<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Nativer Code-Graph · Extremer KV-Cache · Plattformübergreifender All-in-One-Agent (TUI / WebUI / Desktop)</h1>
  <p><strong>Nativer Code-Graph · 98–99% KV-Cache-Schutz · Plattformübergreifender Agent (TUI, WebUI, Desktop) · Schnelle Selbstheilung</strong></p>
  <p>
    <em>Autonomer KI-Programmieragent der nächsten Generation, speziell für komplexe Softwareentwicklung in der Produktion entwickelt — eliminiert Kontextüberlastung, Tool-Fehlerschleifen und Cache-Verlust.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <strong>Deutsch</strong> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>Offizielle Dokumentation</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Quellcode</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 Was ist JeikCode?

**JeikCode** ist ein plattformübergreifender, funktionsreicher Open-Source-KI-Coding-Agent der nächsten Generation, nativ in **Rust** entwickelt. Für komplexe Production-Engineering-Aufgaben konzipiert, bietet er extreme Leichtigkeit, volle Kontrolle und durchgängige Multi-Device-Workflows:

- 🔍 **Semantischer CodeGraph (CodeExplore)**: Tree-Sitter für 12+ Sprachen. Zweisprachige Domänen-Thesauri (`thesaurus`) ermöglichen Abfragen in natürlicher Geschäftssprache, mit inkrementellen Patches in 1–3 ms;
- 🛡️ **98–99 % KV-Cache-Schutz (Sacred Floor)**: strikte Append-only-Byte-Unveränderlichkeit und Speicherbewahrung halten den System-Prefix über Turns hinweg eingefroren. Eliminiert Cache-Thrashing, senkt Token-Kosten um über 90 % und komprimiert TTFT auf Millisekunden;
- ⚡ **Minimale 9k-Prompts und hohe Disziplin**: vermeidet 30–50k Token große System-Prompts. Ein normaler Turn verbraucht nur ~9–11k Token und lässt dem Code maximalen Kontext; Regeln werden live neu geladen;
- 📱 **Omni-Plattform-Workflows und einheitlicher Agent**: Terminal-TUI, moderne WebUI, Tauri-Desktop, Hintergrund-Daemon und OpenWrt-Router/Gateways (x86_64 / aarch64). Konsistente Erfahrung unter Windows, macOS, Linux und OpenWrt;
- 🔒 **Git-ähnlicher atomarer Zustandsschutz**: strikte Grenzen für parallele Dateibearbeitung verhindern schmutzige Schreibvorgänge. Stabil mit starken und leichten Modellen, inklusive Undo und Rollback-Checkpoints;
- 🔄 **Native Unterstützung von 5 Protokollen**: `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini` und `Ollama`, mit vollständiger Entkopplung von Konten und Modellen;
- 🧩 **Tri-Protokoll-Gateway und offenes Ökosystem**: stellt OpenAI-, Anthropic- und Gemini-kompatible Server-Endpunkte bereit, sodass OpenClaw oder Übersetzungs-Plugins sich mühelos verbinden;
- 🚀 **Schnelle Iterationen und agiles Review**: Community-Issues und PRs werden sehr schnell geprüft und gemerged, begleitet von schnellen Beta-Builds.

---

## 🚀 Installation und Schnellstart

### 1. Desktop-Anwendung (empfohlen)

Sofort einsatzbereite plattformübergreifende Desktop-App mit integrierter WebUI und automatischer `jeikcode`-CLI-Integration in den PATH:

| OS / Architektur | Installer | Beschreibung |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Windows-Installer (.exe) herunterladen**](https://github.com/jeikl/JeikCode/releases/latest) | Grafischer Setup-Assistent |
| **macOS** (Apple Silicon / Intel) | [🍏 **macOS-Installer (.dmg) herunterladen**](https://github.com/jeikl/JeikCode/releases/latest) | Unterstützt Apple Mac |
| **Linux** (x64: Debian / Ubuntu / universell) | [🐧 **Linux-Paket (.deb / .AppImage) herunterladen**](https://github.com/jeikl/JeikCode/releases/latest) | Eigenständiges Paket |

> 🍎 **macOS: „App ist beschädigt und kann nicht geöffnet werden“ beheben**:
> Ziehe die App nach `/Applications` und führe im Terminal aus:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Offizielle Terminal-Einzeiler-Installation (CLI)

```bash
# Im Terminal unter Linux / macOS / OpenWrt ausführen
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Unter Windows (PowerShell) ausführen
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> Headless-Geräte (Boxen, NAS, Soft-Router) benötigen nur das CLI-Binary. Support-Matrix: [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 Schnellstart

Wechsle in ein beliebiges Code-Repository und starte:

```bash
cd /path/to/your/project
jeikcode
```

Häufige CLI-Optionen:
```bash
# In einem bestimmten Verzeichnis starten
jeikcode -C /path/to/project

# WebUI im Browser öffnen
jeikcode webui

# Vorherige Sitzung fortsetzen
jeikcode -c

# Headless-Aufgabe ausführen (CI/CD und Skripte)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# Mit einem Klick auf die neueste Version aktualisieren
jeikcode update
```

---

## 📝 Änderungsprotokoll (Changelog)

> Vollständige Historie in [CHANGELOG.md](./CHANGELOG.md) und [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Support und Sponsoring

Wenn JeikCode deinen Workflow verbessert, unterstütze gerne die weitere Entwicklung und Open-Source-Pflege!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 Lizenz

Dieses Projekt steht unter der **JeikCode Non-Commercial & Attribution License (abgeleitet von CC BY-NC 4.0)**. Details in [LICENSE](./LICENSE):

1. **Nicht-kommerzielle Einschränkung**: Ohne vorherige schriftliche Genehmigung des Autors darf die Software ganz oder teilweise nicht für kommerzielle Zwecke, kommerzielle Produktintegration, monetarisierte Dienste, SaaS-Hosting oder kommerzielle Weiterverbreitung genutzt werden.
2. **Pflicht zur Namensnennung**: Jede öffentliche Bereitstellung, Verbreitung, Fork oder abgeleitete Arbeit muss den ursprünglichen Copyright-Hinweis, den Projektnamen (**JeikCode**), die Autorennennung und die offizielle Repository-URL `https://github.com/jeikl/JeikCode` deutlich sichtbar beibehalten.
3. **Kommerzielle Lizenzierung**: Für kommerzielle Lizenzen, Unternehmensintegration oder Partnerschaften kontaktiere den Autor über das offizielle Repository.
