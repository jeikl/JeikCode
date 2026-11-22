<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: 네이티브 코드 그래프 · 극한의 KV 캐시 · 크로스 플랫폼 올인원 에이전트 (TUI / WebUI / Desktop)</h1>
  <p><strong>네이티브 코드 그래프 · 98–99% KV 캐시 보존 · 크로스 플랫폼 올인원 에이전트 (TUI, WebUI, Desktop) · 고속 자가 복구</strong></p>
  <p>
    <em>복잡한 프로덕션 엔지니어링을 위해 구축된 차세대 자율 AI 코딩 에이전트 — 컨텍스트 비대화, 도구 루프 오류, 캐시 손실을 근본적으로 해결합니다.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <strong>한국어</strong> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>공식 문서 포털</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>소스 코드</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 JeikCode란?

**JeikCode**는 순수 **Rust**로 구축된 차세대 크로스 플랫폼 풀기능 오픈소스 AI 코딩 에이전트입니다. 복잡한 프로덕션 소프트웨어 엔지니어링을 위해 설계되어 극도의 경량성, 완전한 제어, 엔드투엔드 멀티 디바이스 워크플로를 제공합니다:

- 🔍 **시맨틱 코드 그래프 (CodeExplore)**: 12개 이상의 주요 언어를 지원하는 Tree-Sitter 기반. 비즈니스 자연어로 코드 구조와 호출 관계를 검색하며 1~3ms 증분 패치를 제공합니다;
- 🛡️ **98–99% KV 캐시 보호 (Sacred Floor)**: 엄격한 append-only 바이트 불변성과 메모리 보존으로 멀티턴 대화에서도 프리픽스를 고정합니다. 캐시 스래싱을 제거하고 토큰 비용을 90% 이상 절감하며 TTFT를 밀리초 단위로 단축합니다;
- ⚡ **9k 최소 프롬프트와 높은 규율**: 30~50k 토큰의 시스템 비대화를 피하고 일반 대화는 약 9~11k 토큰만 사용합니다. 컨텍스트 창을 코드베이스에 최대한 양보하며 규칙은 핫 리로드됩니다;
- 📱 **옴니 플랫폼 워크플로**: 터미널 TUI, 최신 WebUI, Tauri 데스크톱 앱, 백그라운드 데몬, OpenWrt 라우터/게이트웨이(x86_64 / aarch64)를 모두 지원합니다. Windows, macOS, Linux, OpenWrt에서 일관된 경험을 제공합니다;
- 🔒 **Git 스타일 상태 머신 원자 보호**: 다중 파일 동시 편집의 원자성을 보장해 더티 쓰기를 방지하고, 강한 모델과 가벼운 모델 모두 안정적으로 실행됩니다. 원클릭 Undo/롤백 체크포인트를 제공합니다;
- 🔄 **5대 산업 프로토콜 네이티브 지원**: `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini`, `Ollama` 형식을 통합하고 계정과 모델 설정을 완전히 분리합니다;
- 🧩 **트라이 프로토콜 게이트웨이와 오픈 생태계**: 표준 OpenAI/Anthropic/Gemini 호환 서버 엔드포인트를 노출해 OpenClaw나 번역 플러그인 같은 외부 도구가 손쉽게 연결됩니다;
- 🚀 **빠른 반복과 민첩한 리뷰**: 커뮤니티 Issue와 PR을 빠르게 검토·병합하고 베타 빌드를 신속히 제공합니다. 오픈소스 공동 창작을 환영합니다.

---

## 🚀 설치 및 빠른 시작

### 1. 데스크톱 애플리케이션 (권장)

WebUI를 내장하고 `jeikcode` CLI를 자동으로 PATH에 추가하는 크로스 플랫폼 데스크톱 앱:

| OS / 아키텍처 | 설치 프로그램 | 설명 |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Windows 설치 프로그램 (.exe) 다운로드**](https://github.com/jeikl/JeikCode/releases/latest) | 그래픽 설치 마법사 |
| **macOS** (Apple Silicon / Intel) | [🍏 **macOS 설치 프로그램 (.dmg) 다운로드**](https://github.com/jeikl/JeikCode/releases/latest) | Apple Mac 지원 |
| **Linux** (x64: Debian / Ubuntu / 범용) | [🐧 **Linux 패키지 (.deb / .AppImage) 다운로드**](https://github.com/jeikl/JeikCode/releases/latest) | 독립 실행 패키지 |

> 🍎 **macOS에서 "손상되었기 때문에 열 수 없습니다"가 표시될 때**:
> 앱을 `/Applications`로 드래그한 뒤 터미널에서 실행:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. 공식 터미널 원라이너 (CLI)

```bash
# Linux / macOS / OpenWrt 터미널에서 실행
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell)에서 실행
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> 헤드리스 장치(박스, NAS, 소프트 라우터)는 CLI 바이너리만 필요합니다. 지원 매트릭스는 [Supported Platforms](https://jeikcode.top/guide/supported-platforms)를 참고하세요.

---

## 💡 빠른 시작

원하는 코드베이스 디렉터리에서 바로 시작:

```bash
cd /path/to/your/project
jeikcode
```

자주 쓰는 CLI 옵션:
```bash
# 지정 디렉터리에서 시작
jeikcode -C /path/to/project

# 브라우저에서 WebUI 열기
jeikcode webui

# 이전 세션 이어서 대화
jeikcode -c

# 헤드리스 자동 실행 (CI/CD 및 스크립트용)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# 최신 버전으로 원클릭 업그레이드
jeikcode update
```

---

## 📝 변경 로그 (Changelog)

> 전체 이력은 [CHANGELOG.md](./CHANGELOG.md)와 [GitHub Releases](https://github.com/jeikl/JeikCode/releases)를 참고하세요.

---

## ☕ 후원 및 지원

JeikCode가 소프트웨어 개발 워크플로에 도움이 된다면 프로젝트의 지속적인 개발과 오픈소스 유지를 위해 후원해 주세요!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 라이선스

이 프로젝트는 **JeikCode 비상업적 사용 및 저작자 표시 라이선스(CC BY-NC 4.0 기반)** 로 공개됩니다. 자세한 내용은 [LICENSE](./LICENSE)를 참고하세요:

1. **비상업적 제한**: 저작자의 사전 서면 허가 없이 소프트웨어의 전부 또는 일부를 상업적 목적, 상업 제품 통합, 수익화 서비스, SaaS 호스팅 또는 상업적 재배포에 사용할 수 없습니다.
2. **저작자 표시 의무**: 공개 배포, 배포, 포크 또는 파생 작업은 원저작권 고지, 프로젝트 이름(**JeikCode**), 저작자 크레딧, 공식 저장소 URL(`https://github.com/jeikl/JeikCode`)을 눈에 띄게 유지해야 합니다.
3. **상업적 라이선스**: 상업적 라이선스, 기업 통합 또는 제휴 문의는 공식 저장소를 통해 저작자에게 연락하세요.
