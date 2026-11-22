<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 原生程式碼圖譜 · 極致快取 · 跨平台全功能 Agent（TUI / WebUI / 桌面）</h1>
  <p><strong>原生程式碼圖譜 · 98–99% 極致快取 · 跨平台全功能 Agent (TUI / WebUI / Desktop) · 開源極速自癒</strong></p>
  <p>
    <em>專為大型複雜工程打造的新一代自主程式設計智慧體，告別可設定性差、上下文臃腫、工具報錯與快取雪崩。</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <strong>繁體中文</strong> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
  </p>
  <p>
    <a href="https://github.com/jeikl/JeikCode/releases" target="_blank">
      <img src="https://img.shields.io/github/v/release/jeikl/JeikCode?color=blue&label=version" alt="version">
    </a>
    <img src="https://img.shields.io/badge/rust-1.93%2B-orange.svg" alt="rust">
    <img src="https://img.shields.io/badge/license-Non--Commercial%20(CC--BY--NC--4.0)-red.svg" alt="license">
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg" alt="platform">
    <a href="https://github.com/jeikl/JeikCode" target="_blank">
      <img src="https://img.shields.io/github/stars/jeikl/JeikCode?style=social" alt="GitHub Stars"/>
    </a>
  </p>
  <p>
    <a href="https://jeikcode.top">
      <img src="https://img.shields.io/badge/📖_Official_Documentation-jeikcode.top-0284c7?style=for-the-badge" alt="Docs">
    </a>
    <a href="https://github.com/jeikl/JeikCode">
      <img src="https://img.shields.io/badge/⭐_Star_on_GitHub-Support_Project-2563eb?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Repo">
    </a>
    <a href="https://github.com/jeikl/JeikCode/releases">
      <img src="https://img.shields.io/badge/📥_Download_Releases-Latest-0ea5e9?style=for-the-badge" alt="Releases">
    </a>
  </p>
  <p>
    🌐 <strong>官方文件門戶</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>原始碼倉庫</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 什麼是 JeikCode？

**JeikCode** 是一款以純 **Rust** 原生打造的新一代跨平台全功能開源 AI 編程智能體（AI Coding Agent）。專為高複雜度生產工程而生，具備極致輕量、高可控與端到端協同能力：

- 🔍 **語意程式碼圖譜 (CodeExplore)**：內建 Tree-Sitter，原生支援 12+ 種主流語言。融合領域雙語詞林（`thesaurus`），可用業務自然語言提問全域程式碼與上下游呼叫鏈，1~3ms 無感增量更新；
- 🛡️ **98–99% 極致快取 (KV-Cache)**：嚴格 Append-Only 位元組不可變性與聖地地基設計（`sacred_floor`），首部系統提示詞永久凍結，杜絕快取雪崩，API 成本降低 90%+，毫秒級首字輸出；
- ⚡ **9k 極簡提示詞與嚴苛紀律**：拒絕 30~50k 臃腫系統開銷，單次起手僅約 9~11k Token，將絕大多數上下文留給程式碼；全面開源，規則修改熱重載即刻生效；
- 📱 **全場景協同與全平台統一 Agent**：終端 TUI、現代 WebUI、Tauri 桌面端、背景 Daemon 與 OpenWrt 軟路由/閘道（x86_64 / aarch64）全覆蓋。無縫運行於 Windows、macOS、Linux（x64/ARM64）與 OpenWrt，統一架構與一致體驗；
- 🔒 **類 Git 狀態機並行原子保護**：多檔案大範圍並行編輯嚴格原子性防髒寫，強弱模型皆能穩定執行，支援一鍵 Undo 歷史檢查點回滾；
- 🔄 **原生五大協議全棧相容**：原生自適應支援 `OpenAI Chat`、`OpenAI Responses`、`Anthropic Claude`、`Google Gemini` 與 `Ollama` 格式，帳號憑證與模型設定徹底解耦；
- 🧩 **開放生態與第三方相容端點**：服務端暴露標準 OpenAI/Claude/Gemini API 端點，外部工具、翻譯外掛或 OpenClaw 等 Agent 框架可直接接入；
- 🚀 **高頻迭代與社群敏捷審批**：社群 Issue 與 PR 保持極高頻審核與合入，快速發布 Beta 測試版本，真誠擁抱開源共創。

---

## 🚀 安裝與起步 (Installation)

### 1. 桌面客戶端安裝包（首選推薦）

開箱即用的跨平台桌面應用（內嵌 WebUI，並自動將 `jeikcode` CLI 寫入系統路徑）：

| 作業系統 / 晶片架構 | 推薦安裝包 | 說明 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **下載 Windows 安裝程式 (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | 圖形化安裝精靈 |
| **macOS** (Apple Silicon / Intel) | [🍏 **下載 macOS 安裝包 (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | 支援 Apple 電腦 |
| **Linux** (x64：Debian / Ubuntu / 通用) | [🐧 **下載 Linux 安裝包 (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | 通用獨立執行包 |

> 🍎 **macOS 提示「已損壞，無法開啟」的解決方法**：
> 將應用拖入 `/Applications`（應用程式）資料夾後，開啟終端機執行：
> `xattr -cr "/Applications/JeikCode Desktop.app"` 即可正常使用。

### 2. 官方終端一鍵安裝腳本 (CLI)

```bash
# Linux / macOS / OpenWrt 終端執行
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell) 執行
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> 無頭裝置（盒子、NAS、軟路由）只需要 CLI 二進位；支援矩陣見 [Supported Platforms](https://jeikcode.top/guide/supported-platforms)。

---

## 💡 快速上手 (Quick Start)

進入任意程式碼工程目錄直接啟動：

```bash
cd /path/to/your/project
jeikcode
```

常用 CLI 選項：
```bash
# 指定工程目錄啟動
jeikcode -C /path/to/project

# 啟動並在瀏覽器開啟現代 WebUI 介面
jeikcode webui

# 持續對話，恢復上一輪工作階段
jeikcode -c

# 無頭自動化批次執行任務（適合 CI/CD 與腳本排障）
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# 一鍵平滑升級至最新版本
jeikcode update
```

---

## 📝 更新日誌 (Changelog)

> 完整歷史請參閱 [CHANGELOG.md](./CHANGELOG.md) 與 [GitHub Releases](https://github.com/jeikl/JeikCode/releases)。

---

## ☕ 贊助與支持 (Support & Sponsor)

如果您覺得 JeikCode 為您的工程研發帶來了切實的效率提升，歡迎請作者喝一杯咖啡，支持專案的持續演進與開源建設！

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 License / 開源授權條款

本專案遵循 **JeikCode 非商業性使用與署名開源協議（基於 CC BY-NC 4.0 適配）** 開源，詳情請參閱 [LICENSE](./LICENSE)：

1. **嚴格禁止商用**：未經原作者顯式書面許可與正式商業授權，嚴禁任何個人或機構將本軟體（含原始碼與二進位）全部或部分用於商業營利、收費產品整合、閉源銷售或作為 SaaS/雲端加值服務提供；
2. **強制署名與註明出處**：任何基於本專案的二次修改、衍生版本、程式碼合併或公開部署，**必須在介面顯著位置完整保留原作者著作權聲明、專案名稱（JeikCode）及官方開源倉庫位址（`https://github.com/jeikl/JeikCode`）**；
3. **商業授權與合作**：如需將本軟體用於商業環境、企業系統整合或商業合作，請透過官方開源倉庫聯繫作者取得正式書面授權。
