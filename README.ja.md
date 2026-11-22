<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: ネイティブコードグラフ · 極限KVキャッシュ · クロスプラットフォーム統合エージェント（TUI / WebUI / デスクトップ）</h1>
  <p><strong>ネイティブコードグラフ · 98–99% KVキャッシュ保護 · クロスプラットフォーム統合エージェント (TUI, WebUI, Desktop) · 高速自己修復</strong></p>
  <p>
    <em>複雑な本番ソフトウェア開発のために設計された次世代の自律型AIコーディングエージェント — コンテキスト肥大化、ツールエラー、キャッシュ消失を一掃します。</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <strong>日本語</strong> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>公式ドキュメント</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>ソースコード</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 JeikCode とは？

**JeikCode** は、100% ピュアな **Rust** で構築された次世代のクロスプラットフォーム・フル機能オープンソース AI コーディングエージェントです。複雑な実稼働ソフトウェアエンジニアリング専用に設計され、圧倒的な軽量性と高速性、完全な制御、エンドツーエンドのマルチデバイスワークフローを提供します：

- 🔍 **セマンティックコードグラフ (CodeExplore)**: 12以上の主要言語に対応する Tree-Sitter 駆動。ビジネス自然言語でコード構造や呼び出し関係を高速検索、1〜3ms のインクリメンタルパッチを実現；
- 🛡️ **98〜99% KVキャッシュ保護 (Sacred Floor)**: 厳格な追記専用（append-only）バイト不変性とメモリ保護により、マルチターン対話でもプレフィックスを固定。キャッシュ消失を根絶し、トークン費用を90%以上削減、ミリ秒単位の TTFT を実現；
- ⚡ **9k ミニマルプロンプトと高い規律**: 30〜50k トークンの肥大化を排除。標準対話のシステム消費は約 9〜11k トークンに抑えられ、コンテキストウィンドウを最大限コードベースに開放；
- 📱 **オムニプラットフォームワークフロー**: ターミナル TUI、最新の WebUI、Tauri デスクトップアプリ、バックグラウンドデーモン、OpenWrt ルーター/ゲートウェイ（x86_64 / aarch64）を完全網羅。Windows、macOS、Linux、OpenWrt 間で一貫した開発体験を提供；
- 🔒 **Gitスタイルの状態マシンアトミック保護**: ファイル編集の並行境界を厳格に保護し、ダーティライトを防止。ワンクリックの取り消し・ロールバックチェックポイントを完備；
- 🔄 **5大業界プロトコルのネイティブサポート**: `OpenAI Chat`、`OpenAI Responses`、`Anthropic Claude`、`Google Gemini`、`Ollama` フォーマットを統合、アカウントとモデルを完全に分離；
- 🧩 **トリプロトコルゲートウェイとオープンエコシステム**: OpenAI / Anthropic / Gemini 互換のサーバーエンドポイントを公開し、OpenClaw や翻訳プラグインなどの外部ツールがシームレスに接続可能；
- 🚀 **高速イテレーションとアジャイルレビュー**: コミュニティの Issue と PR を高速にレビュー・マージし、ベータビルドを迅速に提供。オープンソース共創を歓迎。

---

## 🚀 インストールとクイックスタート

### 1. デスクトップアプリケーション（推奨）

WebUI を内蔵し、`jeikcode` CLI を自動で PATH に追加するクロスプラットフォーム・デスクトップアプリ：

| OS / アーキテクチャ | インストーラー | 説明 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Windows インストーラー (.exe) をダウンロード**](https://github.com/jeikl/JeikCode/releases/latest) | グラフィカルセットアップ |
| **macOS** (Apple Silicon / Intel) | [🍏 **macOS インストーラー (.dmg) をダウンロード**](https://github.com/jeikl/JeikCode/releases/latest) | Apple Mac 対応 |
| **Linux** (x64: Debian / Ubuntu / 汎用) | [🐧 **Linux パッケージ (.deb / .AppImage) をダウンロード**](https://github.com/jeikl/JeikCode/releases/latest) | スタンドアロン実行ファイル |

> 🍎 **macOS で「壊れているため開けません」と表示された場合**：
> アプリを `/Applications` にドラッグした後、ターミナルで次を実行：
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. 公式ターミナル・ワンライナー (CLI)

```bash
# Linux / macOS / OpenWrt のターミナルで実行
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell) で実行
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> ヘッドレス機器（ボックス、NAS、ソフトルーター）は CLI バイナリのみで動作します。対応表は [Supported Platforms](https://jeikcode.top/guide/supported-platforms) を参照。

---

## 💡 クイックスタート

任意のコードベースに移動して起動：

```bash
cd /path/to/your/project
jeikcode
```

よく使う CLI オプション：
```bash
# 指定ディレクトリで起動
jeikcode -C /path/to/project

# ブラウザで WebUI を開く
jeikcode webui

# 前回のセッションを継続
jeikcode -c

# ヘッドレス自動実行（CI/CD やスクリプト向け）
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# 最新版へワンクリック更新
jeikcode update
```

---

## 📝 変更履歴 (Changelog)

> 完全な履歴は [CHANGELOG.md](./CHANGELOG.md) と [GitHub Releases](https://github.com/jeikl/JeikCode/releases) を参照。

---

## ☕ サポートとスポンサー

JeikCode が開発効率の向上に役立つと感じたら、プロジェクトの継続的な開発とオープンソース維持へのご支援を歓迎します！

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 ライセンス

本プロジェクトは **JeikCode 非商用・表示必須ライセンス（CC BY-NC 4.0 準拠）** で公開されています。詳細は [LICENSE](./LICENSE) を参照：

1. **非商用制限**：原作者の事前の書面許可なく、本ソフトウェアの全部または一部を商業目的、商用製品への統合、収益化サービス、SaaS ホスティング、商業再配布に使用することはできません。
2. **表示義務**：公開デプロイ、配布、フォーク、派生作品では、元の著作権表示、プロジェクト名（**JeikCode**）、作者クレジット、公式リポジトリ URL（`https://github.com/jeikl/JeikCode`）を目立つ形で保持する必要があります。
3. **商用ライセンス**：商用ライセンス、企業統合、提携については、公式リポジトリ経由で作者にご連絡ください。
