# Local-File-MCP-Server-Demo（ユーザー向け手順書：VS Code でツール導入 → clone → .env → npm run dev）

この README は、リポジトリを **PowerShell で `git clone`** して、**`.env` を作成**し、**`npm run dev` で起動**するまでを、**0〜10 の手順**で 1 つにまとめたものです。 【1-d09037】  
（Windows + VS Code + PowerShell 前提）

対象リポジトリ：
- https://github.com/tamuo-0604/Local-File-MCP-Server-Demo 

---

## 0. 事前準備（VS Code からインストールできるようにする）

> **ポイント**：この手順書では、可能な限り **VS Code の統合ターミナル（PowerShell）**から `winget` を使ってインストールします。  
> VS Code には統合ターミナルがあり、`git` や `npm` などのコマンドを VS Code 内で実行できます。 

### 0-1. （任意）VS Code が未インストールの場合
VS Code がまだ無い場合は、まず VS Code をインストールしてください（この操作だけは VS Code が無いので “外側” で実施します）。

- `winget` が使える場合は、PowerShell（または Windows Terminal）で以下を実行して VS Code をインストールできます。
  ```powershell
  winget install -e --id Microsoft.VisualStudioCode
  ```
- `winget` 自体が無い場合は、Windows の **App Installer** を入れることで利用可能になります（WinGet は App Installer の一部として提供）。 【4-3af988】

---

### 0-2. VS Code の統合ターミナル（PowerShell）を開く
1. VS Code を起動し、何かフォルダ（例：`C:\Copilot_Studio_Demo`）を開きます  
2. メニュー **View > Terminal**（または `Ctrl + \``）で統合ターミナルを開きます 【2-7085b1】  
3. ターミナルのシェルが PowerShell になっていることを確認します（違う場合でも PowerShell を選べばOK）

---

### 0-3. `winget` が使えるか確認（VS Code から）
VS Code の統合ターミナルで実行：

```powershell
winget --version
```

> バージョンが表示されれば OK です。  
> もし `winget` が見つからない場合は、Windows の App Installer を導入してください（WinGet は App Installer として配布）。

---

### 0-4. Node.js（LTS）を VS Code からインストール（winget）
VS Code の統合ターミナルで実行：

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

この `OpenJS.NodeJS.LTS`（Node.js LTS）インストールコマンドが案内されています。

インストール後、**VS Code を再起動**（またはターミナルを作り直す）してから確認：

```powershell
node -v
npm -v
```

> `node -v` と `npm -v` が表示されれば OK です（npm は Node.js と一緒に入ります）。

例：
PS C:\Users\tamuo> node -v
v24.13.1
PS C:\Users\tamuo> npm -v 
11.8.0

---

### 0-5. Git を VS Code からインストール（winget）
VS Code の統合ターミナルで実行：

```powershell
winget install --id Git.Git -e --source winget
```

この `winget install --id Git.Git -e --source winget` は Git 公式（Install for Windows）でも案内されています。 【8-da0865】

インストール後、**VS Code を再起動**（またはターミナルを作り直す）してから確認：

```powershell
git -v
```

`git -v` が表示されれば OK です

例：
PS C:\Users\tamuo> git -v
git version 2.53.0.windows.1

---

## 1. 作業フォルダを作る
ここでは `C:\Copilot_Studio_Demo` を使います（好きな場所でOK）。

```powershell
mkdir C:\Copilot_Studio_Demo -ErrorAction SilentlyContinue
cd C:\Copilot_Studio_Demo
```

---

## 2. リポジトリを PowerShell でクローンして VS Code で開く（必須）
この手順書は **PowerShell で clone** する前提です。

```powershell
#cd C:\Copilot_Studio_Demo
git clone https://github.com/tamuo-0604/Local-File-MCP-Server-Demo.git
cd Local-File-MCP-Server-Demo
code .
```

---

## 3. `.env` を作成（必須：この手順書は `.env` 前提）
リポジトリ直下（`package.json` と同じ階層）に `.env` を作成し、設定を書きます。

### 3-1. `.env` を作成
VS Code 上で新規ファイル `.env` を作ります。
`.env.example` の中身を `.env` にコピーします。

### 3-2. `.env` の意味
- `PORT`：待ち受けポート（例：3110）です。一般的には 3000 が利用されることが多いですが、本環境では重複しないように 3110 に設定しておりますので変更しないことを推奨します。
- `BASE_DIR`：Copilot Studio が参照するローカル フォルダ（例：`./demo-data`）です。既に demo-data のフォルダが作成済みですのでこのままで問題ありません。
- `API_KEY`：認証用キー（Copilot Studio が参照できるように Port Forward を Public で実施するため、推測されにくい値に変更することを推奨します）

> ⚠️ `.env` は秘密情報になり得るので、共有しないでください（共有するなら `.env.example` を別途用意）。

---

## 4. 依存関係をインストール（初回のみ）
VS Code の統合ターミナル（PowerShell）で実行：

```powershell
npm install
```

---

## 5. 開発モードで起動（`npm run dev` 前提）
この手順書は `npm run dev` で起動する前提です。

```powershell
npm run dev
```
> 「✅ MCP Server listening: http://localhost:3110/mcp」 のように表示されれば OK です。
> ⚠️ 起動中は、このターミナルを閉じないでください（閉じるとサーバーが止まります）。

---

## 6. ローカル疎通確認（起動できているか）
ポートは `.env` の `PORT` に合わせます（例：3110）。

### 6-1. PowerShell で確認
```powershell
Invoke-WebRequest http://localhost:3110/ | Select-Object StatusCode
```
> 想定では「The remote server returned an error: (404) Not Found. 」と出ますが、問題ありません。 404 レスポンスであってもサーバーが起動されている証拠です。

### 6-2. ブラウザで確認
- `http://localhost:3110/`

> 想定では Not found と表示されますが、問題ありません。

---

## 7. VS Code の Port Forwarding で外部からアクセス可能にする
Copilot Studio など **ローカルPC以外**からアクセスする必要がある場合、VS Code には **Port Forwarding（Microsoft dev tunnels）** が組み込みであります。

### 7-1. Port Forward の手順（VS Code）
1. VS Code 下部の **Panel** を開く  
2. **PORTS** ビューを開く (**TERMINAL** の右隣にあるはずです)
3. **Forward a Port** を選択し、ポート番号 `3110` を入力し、Enter を押します。Github へのサインインが求められるので、サインインします（アカウントがない方は作成してください）。
4. 表示された **Forwarded Address**（URL）をコピーして利用 

### 7-2. Visibility（公開範囲）の注意（重要）
- 既定は **Private**
- 作成された行を右クリックし、**Port Visibility** を **Public** に変更します。

> ⚠️ **Public にするとリンクを知っている人がアクセスできる可能性があります**。機密情報や弱い認証のサービスは公開しないでください。
> ⚠️ Public を使う場合は `.env` の `API_KEY` を必ず強い値に変更し、第三者に共有しないでください。

---

## 8. （必要な場合のみ）外部クライアントから MCP エンドポイントを指定して使う
Port Forwarding を使う場合、接続先は次の形式になります。

- 例：`https://<your-forwarded-address>/mcp`

> **Forwarded Address**（URL）をコピーしたら、末尾に `/mcp` をつけてメモしておいてください。

---

## 9. 更新（本レポジトリ内のコードが更新された場合に、最新版に追従するための手順です）
Git でクローンした場合：

```powershell
git pull
npm install
npm run dev
```

---

## 10. よくあるトラブルシュート

### 10-1. ポートが使用中（`EADDRINUSE` / `PORT is already in use`）
`.env` の `PORT` を別の値に変更（例：3111）し、再起動します。

`.env`（例）
```env
PORT=3111
BASE_DIR=./demo-data
API_KEY=demo-secret
```

再起動：
```powershell
npm run dev
```

（参考）どのプロセスが使っているか確認（例：3110）
```powershell
netstat -ano | findstr :3110
```

---

### 10-2. `node` や `git` が見つからない
- `winget` でインストール後は **VS Code を再起動**（または新しいターミナルを開き直す）してください。 【2-7085b1】  
- それでもダメなら、以下で確認：
```powershell
node -v
npm -v
git --version
```

---

### 10-3. Port Forward の URL にアクセスできない
- サーバーが起動しているか（`npm run dev` が動作中か）確認 【10-875787】  
- Private の場合はアクセス側でサインインが必要なことがあります 【10-25f9db】  

---

## 参考リンク（公式）
- Node.js ダウンロード（公式）：https://nodejs.org/en/download/ 【11-f01cac】  
- Git for Windows（公式）：https://git-scm.com/install/windows 【8-79f907】  
- VS Code 統合ターミナル：https://code.visualstudio.com/docs/terminal/getting-started 【2-7085b1】  
- VS Code Port Forwarding：https://code.visualstudio.com/docs/debugtest/port-forwarding 【10-c98b75】  
- VS Code で MCP servers を使う（注意事項含む）：https://code.visualstudio.com/docs/copilot/customization/mcp-servers 【9-014dd6】  
- WinGet（App Installer として提供）：https://learn.microsoft.com/en-us/windows/package-manager/winget/ 【4-3af988】  