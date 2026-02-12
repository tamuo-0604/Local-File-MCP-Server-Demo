import "dotenv/config";
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { z } from "zod";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

// mammoth / exceljs の import が環境で崩れたときの保険（実行時エラー対策）
// import * as mammoth from "mammoth";
// import * as ExcelJS from "exceljs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 3110);
const BASE_DIR = process.env.BASE_DIR ?? path.resolve(process.cwd(), "data");
// .env末尾の空白/不可視文字対策で trim 推奨
const API_KEY = (process.env.API_KEY ?? "").trim();

// ログ出力制御（必要なら .env に DEBUG=1）
const DEBUG = (process.env.DEBUG ?? "") === "1";

// -------------------- auth / path safety --------------------

function requireApiKey(req: http.IncomingMessage) {
  if (!API_KEY) return;

  const got = req.headers["x-api-key"];
  const key = Array.isArray(got) ? got[0] : got;

  if (key !== API_KEY) {
    if (DEBUG) {
      console.warn("[401] x-api-key mismatch", {
        method: req.method,
        url: req.url,
        got,
        normalizedKey: key,
        expectedLength: API_KEY.length,
        gotLength: (key ?? "").length,
      });
    }
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function resolveSafe(relativePath: string) {
  const p = path.resolve(BASE_DIR, relativePath);
  const base = path.resolve(BASE_DIR);
  if (!p.startsWith(base + path.sep) && p !== base) {
    throw new Error("Invalid path (path traversal blocked)");
  }
  return p;
}

// ---- demo-data 配下のサブフォルダ ----
const CACHE_SUBDIR = ".cache";
const DOCS_SUBDIR = "docs";
const EXCEL_SUBDIR = "excel";

// キャッシュフォルダ（demo-data/.cache）
const CACHE_DIR = resolveSafe(CACHE_SUBDIR);

async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function cacheKeyForFile(relPath: string, mtimeMs: number) {
  return crypto
    .createHash("sha256")
    .update(relPath)
    .update(":")
    .update(String(mtimeMs))
    .digest("hex");
}

async function cacheReadText(key: string): Promise<string | null> {
  const p = path.join(CACHE_DIR, `${key}.txt`);
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function cacheWriteText(key: string, text: string) {
  const p = path.join(CACHE_DIR, `${key}.txt`);
  await fs.writeFile(p, text, "utf8");
}

async function ensureBaseDir() {
  await fs.mkdir(BASE_DIR, { recursive: true });
}

function toTextResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

// -------------------- Tools implementation (shared) --------------------
// 重要：McpServer をセッションごとに作るため、ツール登録は関数にまとめる

function buildMcpServer() {
  const mcp = new McpServer({ name: "local-folder-mcp", version: "1.0.0" });

  mcp.tool(
    "list_files",
    "List files under BASE_DIR (optionally under a subfolder). Returns relative paths.",
    { subdir: z.string().optional().default(""), max: z.number().int().min(1).max(1000).optional().default(200) },
    async ({ subdir, max }) => {
      const targetDir = resolveSafe(subdir || "");
      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const out = entries.slice(0, max).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return toTextResult(out.join("\n"));
    }
  );

  mcp.tool(
    "read_text",
    "Read a UTF-8 text file under BASE_DIR and return its content (size-limited).",
    { file: z.string(), maxBytes: z.number().int().min(1_000).max(2_000_000).optional().default(200_000) },
    async ({ file, maxBytes }) => {
      const full = resolveSafe(file);
      const st = await fs.stat(full);
      if (!st.isFile()) throw new Error("Not a file");
      if (st.size > maxBytes) return toTextResult(`File is too large (${st.size} bytes).`);
      const txt = await fs.readFile(full, "utf8");
      return toTextResult(txt);
    }
  );

  mcp.tool(
    "search_text",
    "Search keyword in .txt/.md/.csv/.json under BASE_DIR (simple recursive grep).",
    { keyword: z.string().min(1), subdir: z.string().optional().default(""), maxHits: z.number().int().min(1).max(200).optional().default(50) },
    async ({ keyword, subdir, maxHits }) => {
      const startDir = resolveSafe(subdir || "");
      const allowExt = new Set([".txt", ".md", ".csv", ".json", ".log"]);
      const hits: string[] = [];

      async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (hits.length >= maxHits) return;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else {
            const ext = path.extname(e.name).toLowerCase();
            if (!allowExt.has(ext)) continue;
            const buf = await fs.readFile(full, "utf8");
            const lines = buf.split(/\r?\n/);
            lines.forEach((line, idx) => {
              if (hits.length >= maxHits) return;
              if (line.includes(keyword)) {
                const rel = path.relative(BASE_DIR, full);
                hits.push(`${rel}:${idx + 1}: ${line}`);
              }
            });
          }
        }
      }

      await walk(startDir);
      return hits.length ? toTextResult(hits.join("\n")) : toTextResult("No hits.");
    }
  );

  mcp.tool(
    "upload_file",
    "Upload a file into demo-data/uploads. Accepts base64 OR contentBytes. filename can be omitted if name is provided.",
    {
      // Copilot Studio で扱いやすい形式（推奨）
      name: z.string().optional(),                 // 例: "comments_export.xlsx"
      contentBytes: z.string().optional(),         // 例: base64

      // 既存互換（手入力/旧ルート）
      filename: z.string().optional(),
      base64: z.string().optional(),

      subdir: z.string().optional().default("uploads"),
      overwrite: z.boolean().optional().default(false),
      maxBytes: z.number().int().min(1_000).max(10_000_000).optional().default(3_000_000),
    },
    async (args) => {
      const filename = (args.filename ?? args.name ?? "").trim();
      const b64 = (args.base64 ?? args.contentBytes ?? "").trim();

      if (!filename) throw new Error("filename/name is required.");
      if (!b64) throw new Error("base64/contentBytes is required.");

      // data:...;base64, を渡された場合に備えて取り除く
      const cleaned = b64.includes("base64,") ? b64.split("base64,")[1] : b64;

      const safeName = path.basename(filename);
      const targetDir = resolveSafe(args.subdir || "uploads");
      await fs.mkdir(targetDir, { recursive: true });

      const buf = Buffer.from(cleaned, "base64");
      if (buf.byteLength > (args.maxBytes ?? 3_000_000)) {
        return toTextResult(`Rejected: too large (${buf.byteLength} bytes).`);
      }

      const full = resolveSafe(path.join(args.subdir || "uploads", safeName));

      try {
        if (!args.overwrite) {
          await fs.access(full);
          return toTextResult(`Rejected: already exists: ${path.relative(BASE_DIR, full)}`);
        }
      } catch {}

      await fs.writeFile(full, buf);
      return toTextResult(`Saved: ${path.relative(BASE_DIR, full)} (${buf.byteLength} bytes)`);
    }
  );

  mcp.tool(
    "word_read_text",
    "Read-only: Extract plain text from a .docx under demo-data/docs (cached). Use this to summarize or quote Word documents.",
    {
      file: z.string(), // "handbook.docx" または "docs/handbook.docx"
      maxChars: z.number().int().min(1000).max(800_000).optional().default(150_000),
      useCache: z.boolean().optional().default(true),
    },
    async ({ file, maxChars, useCache }) => {
      const normalized = file.startsWith(`${DOCS_SUBDIR}/`) ? file : `${DOCS_SUBDIR}/${file}`;

      const full = resolveSafe(normalized);
      const st = await fs.stat(full);
      if (!st.isFile()) throw new Error("Not a file");
      if (path.extname(full).toLowerCase() !== ".docx") {
        throw new Error("Only .docx is supported (read-only).");
      }

      const key = cacheKeyForFile(normalized, st.mtimeMs);

      if (useCache) {
        const cached = await cacheReadText(key);
        if (cached) {
          const out = cached.length > maxChars ? cached.slice(0, maxChars) + "\n...(truncated)" : cached;
          return toTextResult(out);
        }
      }

      const result = await mammoth.extractRawText({ path: full });
      const text = (result.value ?? "").trim();

      await cacheWriteText(key, text);

      const out = text.length > maxChars ? text.slice(0, maxChars) + "\n...(truncated)" : text;
      return toTextResult(out || "(empty)");
    }
  );

  // ---- Excel helpers (scoped) ----
  function resolveExcelSafe(excelFileName: string) {
    const safeName = path.basename(excelFileName);
    return resolveSafe(path.join(EXCEL_SUBDIR, safeName));
  }

  function colToNumber(col: string) {
    let n = 0;
    for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }

  function parseCellA1(a1: string) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(a1.trim());
    if (!m) throw new Error(`Invalid cell: ${a1}`);
    return { col: colToNumber(m[1]), row: Number(m[2]) };
  }

  function parseRangeA1(range: string) {
    const parts = range.split(":").map((s) => s.trim());
    if (parts.length !== 2) throw new Error(`Invalid range: ${range}`);
    const a = parseCellA1(parts[0]);
    const b = parseCellA1(parts[1]);
    return {
      r1: Math.min(a.row, b.row),
      r2: Math.max(a.row, b.row),
      c1: Math.min(a.col, b.col),
      c2: Math.max(a.col, b.col),
    };
  }

  function cellValueToString(v: any) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return String(v);
  }

  mcp.tool(
    "excel_read_range",
    "Read an .xlsx range from demo-data/excel. sheet/range can be omitted; server will infer defaults (Menu/LunchLog).",
    {
      file: z.string(),
      sheet: z.string().optional(),           // ← optional にする
      range: z.string().optional(),           // ← optional にする
      hint: z.string().optional(),            // ← 自然言語ヒント（例：'menu', 'ログ', '売上'）
    },
    async ({ file, sheet, range, hint }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(full);

      const sheetNames = wb.worksheets.map(ws => ws.name);

      // 1) シート推定（優先：sheet > hint > default）
      const h = (hint ?? "").toLowerCase();
      const desired =
        sheet ??
        (h.includes("menu") || h.includes("メニュー") ? "Menu" :
        h.includes("log") || h.includes("ログ") ? "LunchLog" :
        "LunchLog");

      // 大文字小文字違いを吸収して探す
      const matchedName =
        sheetNames.find(n => n.toLowerCase() === desired.toLowerCase()) ??
        sheetNames.find(n => n.toLowerCase().includes(desired.toLowerCase())) ??
        null;

      if (!matchedName) {
        // 質問ではなく候補を返す（＝会話が途切れにくい）
        return toTextResult(
          JSON.stringify(
            { error: "Sheet not found", requested: desired, availableSheets: sheetNames },
            null, 2
          )
        );
      }

      const ws = wb.getWorksheet(matchedName)!;

      // 2) range 推定（未指定なら “よくある範囲” を読む）
      const effectiveRange = range ?? "A1:F50";

      const { r1, r2, c1, c2 } = parseRangeA1(effectiveRange);

      const values: string[][] = [];
      for (let r = r1; r <= r2; r++) {
        const row: string[] = [];
        for (let c = c1; c <= c2; c++) {
          row.push(cellValueToString(ws.getCell(r, c).value));
        }
        values.push(row);
      }

      return toTextResult(JSON.stringify({
        file: `excel/${path.basename(file)}`,
        sheet: matchedName,
        range: effectiveRange,
        values
      }, null, 2));
    }
  );


  mcp.tool(
    "excel_write_range",
    "Write values (2D array) into an .xlsx in demo-data/excel starting at startCell (e.g., A1). Creates file/sheet if missing.",
    {
      file: z.string(),
      sheet: z.string(),
      startCell: z.string(),
      values: z.array(z.array(z.any())),
      createSheet: z.boolean().optional().default(true),
    },
    async ({ file, sheet, startCell, values, createSheet }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      try {
        await fs.access(full);
        await wb.xlsx.readFile(full);
      } catch {}

      let ws = wb.getWorksheet(sheet);
      if (!ws) {
        if (!createSheet) throw new Error(`Sheet not found: ${sheet}`);
        ws = wb.addWorksheet(sheet);
      }

      const start = parseCellA1(startCell);
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < values[r].length; c++) {
          ws.getCell(start.row + r, start.col + c).value = values[r][c] as any;
        }
      }

      await wb.xlsx.writeFile(full);
      return toTextResult(`Wrote ${values.length}x${(values[0]?.length ?? 0)} to excel/${path.basename(file)} sheet=${sheet} start=${startCell}`);
    }
  );

  mcp.tool(
    "excel_append_rows",
    "Append rows to the bottom of a sheet in demo-data/excel. sheet can be omitted (defaults to LunchLog).",
    {
      file: z.string(),
      sheet: z.string().optional(),
      rows: z.array(z.array(z.any())),
    },
    async ({ file, sheet, rows }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      try { await fs.access(full); await wb.xlsx.readFile(full); } catch {}

      const sheetName = sheet ?? "LunchLog";
      let ws = wb.getWorksheet(sheetName);
      if (!ws) ws = wb.addWorksheet(sheetName);

      for (const row of rows) ws.addRow(row as any[]);
      await wb.xlsx.writeFile(full);

      return toTextResult(`Appended ${rows.length} rows to excel/${path.basename(file)} sheet=${sheetName}`);
    }
  );

  mcp.tool(
    "excel_list_sheets",
    "List worksheet names in an .xlsx under demo-data/excel. Use when sheet name is unknown.",
    { file: z.string() },
    async ({ file }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(full);

      const sheets = wb.worksheets.map(ws => ws.name);
      return toTextResult(JSON.stringify({ file: `excel/${path.basename(file)}`, sheets }, null, 2));
    }
  );

  mcp.tool(
    "excel_add_menu_item",
    "Add one menu item row into the 'Menu' sheet of an .xlsx in demo-data/excel. Use this when user says 'メニューに追加'.",
    {
      file: z.string(),                          // friendly_cafe_lunch_log.xlsx
      menu: z.string().min(1),                   // カレーライス
      category: z.string().min(1),               // ご飯
      priceJPY: z.number().int().min(0),         // 750
      allergyNotes: z.string().optional().default("—"),  // ナシ/小麦/乳…など
      tips: z.string().optional().default(""),   // 辛い物好きにおすすめ
    },
    async ({ file, menu, category, priceJPY, allergyNotes, tips }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      try {
        await fs.access(full);
        await wb.xlsx.readFile(full);
      } catch {
        // ファイルが無いなら新規作成してもいいが、デモでは既存を想定
        // 必要ならここで wb.addWorksheet(...) して初期化してもOK
      }

      let ws = wb.getWorksheet("Menu");
      if (!ws) ws = wb.addWorksheet("Menu");

      // 1行追記
      ws.addRow([menu, category, priceJPY, allergyNotes, tips]);

      await wb.xlsx.writeFile(full);

      return toTextResult(
        `Added menu item to excel/${path.basename(file)} sheet=Menu: ${menu} / ${category} / ${priceJPY}円`
      );
    }
  );

  mcp.tool(
    "excel_add_lunchlog_entry",
    "Append one log row into 'LunchLog' sheet of an .xlsx in demo-data/excel. Use this for demo logging.",
    {
      file: z.string(),
      date: z.string().min(1),           // 2026-02-12
      menu: z.string().min(1),
      category: z.string().min(1),
      priceJPY: z.number().int().min(0),
      rating: z.number().int().min(1).max(5),
      notes: z.string().optional().default(""),
    },
    async ({ file, date, menu, category, priceJPY, rating, notes }) => {
      const full = resolveExcelSafe(file);
      if (path.extname(full).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx is supported");

      const wb = new ExcelJS.Workbook();
      try { await fs.access(full); await wb.xlsx.readFile(full); } catch {}

      let ws = wb.getWorksheet("LunchLog");
      if (!ws) ws = wb.addWorksheet("LunchLog");

      ws.addRow([date, menu, category, priceJPY, rating, notes]);

      await wb.xlsx.writeFile(full);

      return toTextResult(
        `Added LunchLog row to excel/${path.basename(file)}: ${date} / ${menu} / rating=${rating}`
      );
    }
  );


  return mcp;
}

// -------------------- Streamable HTTP session handling --------------------
// Streamable HTTP は mcp-session-id でセッションを管理するのが一般的です。
type SessionEntry = {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
  createdAt: number;
  lastSeen: number;
};

const sessions = new Map<string, SessionEntry>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30分（デモ用）
function cleanupSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions.entries()) {
    if (now - s.lastSeen > SESSION_TTL_MS) {
      sessions.delete(sid);
    }
  }
}

async function createNewSession(): Promise<SessionEntry> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true, // Copilot Studio が解釈しやすい JSON 応答に寄せる
  });

  const mcp = buildMcpServer();

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
  };

  await mcp.connect(transport);

  const now = Date.now();
  return { transport, mcp, createdAt: now, lastSeen: now };
}

// -------------------- server --------------------

await ensureBaseDir();
await ensureCacheDir();

const server = http.createServer(async (req, res) => {
  if (DEBUG) {
    console.log("[REQ]", req.method, req.url, {
      origin: req.headers["origin"],
      hasApiKey: !!req.headers["x-api-key"],
      session: req.headers["mcp-session-id"],
    });
  }

  try {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end("Not Found");
      return;
    }

    // OPTIONS (CORS preflight)
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, x-api-key, mcp-session-id, accept",
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      });
      res.end();
      return;
    }

    // 認証：POST/DELETE のみ必須（GETは緩める）
    // Streamable HTTP は GET/POST/DELETE を扱うため、GET が401になると不安定化しがち 
    if (req.method === "POST" || req.method === "DELETE") {
      requireApiKey(req);
    }

    cleanupSessions();

    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? undefined;

    // sessionId が来ているのにサーバが知らない → 新規作成しない（再initializeを促す）
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(410, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown or expired session. Please reinitialize." }));
      return;
    }

    // 既知セッションならそれを使い、sessionId なしなら新規セッションを作る
    let entry: SessionEntry;
    if (sessionId) {
      entry = sessions.get(sessionId)!;
      entry.lastSeen = Date.now();
    } else {
      entry = await createNewSession();
    }

    await entry.transport.handleRequest(req, res);

    // initialize を処理した後に transport.sessionId が確定するので、ここで確実に Map 登録
    if (entry.transport.sessionId) {
      entry.lastSeen = Date.now();
      sessions.set(entry.transport.sessionId, entry);
    }
  } catch (e: any) {
    const code = e?.statusCode ?? 500;
    if (DEBUG) console.error("[ERR]", e?.message ?? e);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e?.message ?? "Internal Error" }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ MCP Server listening: http://localhost:${PORT}/mcp`);
  console.log(`   BASE_DIR = ${BASE_DIR}`);
  console.log(`   API_KEY  = ${API_KEY ? "enabled" : "disabled"}`);
  console.log(`   DEBUG    = ${DEBUG ? "enabled" : "disabled"}`);
});