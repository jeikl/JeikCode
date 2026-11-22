<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Нативный граф кода · Экстремальный KV-кэш · Кроссплатформенный агент «Все в одном» (TUI / WebUI / Desktop)</h1>
  <p><strong>Нативный граф кода · 98–99% защита KV-кэша · Кроссплатформенный агент (TUI, WebUI, Desktop) · Быстрое самовосстановление</strong></p>
  <p>
    <em>Автономный ИИ-ассистент нового поколения для сложной промышленной разработки ПО — забудьте о раздувании контекста, ошибках инструментов и деградации кэша.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <strong>Русский</strong> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>Официальная документация</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Исходный код</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 Что такое JeikCode?

**JeikCode** — это новое поколение кроссплатформенного полнофункционального open-source AI-агента для программирования, созданного на чистом **Rust**. Он разработан для сложной production-разработки и обеспечивает предельную лёгкость, полный контроль и сквозные мультиустройственные рабочие процессы:

- 🔍 **Семантический граф кода (CodeExplore)**: на базе Tree-Sitter для 12+ языков. Двуязычные предметные тезаурусы (`thesaurus`) позволяют искать код и цепочки вызовов обычным деловым языком; инкрементальные патчи за 1–3 мс;
- 🛡️ **Защита KV-кэша 98–99% (Sacred Floor)**: строгая append-only неизменяемость байтов и сохранение памяти удерживают системный префикс между ходами. Устраняет cache thrashing, сокращает расход токенов более чем на 90% и сжимает TTFT до миллисекунд;
- ⚡ **Минимальные промпты 9k и высокая дисциплина**: отказ от раздутых системных промптов на 30–50k токенов. Обычный ход consumes ~9–11k токенов, оставляя максимум контекста коду; правила перезагружаются на лету;
- 📱 **Единый агент на всех платформах**: терминальный TUI, современный WebUI, Tauri-десктоп, фоновый демон и OpenWrt-роутеры/шлюзы (x86_64 / aarch64). Единая модель работы в Windows, macOS, Linux и OpenWrt;
- 🔒 **Атомарная защита в стиле Git**: строгие границы одновременного редактирования файлов исключают грязные записи. Стабильно работает с сильными и лёгкими моделями, поддерживает Undo и точки отката;
- 🔄 **Нативная поддержка пяти протоколов**: `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini` и `Ollama` с полным разделением аккаунтов и моделей;
- 🧩 **Трёхпротокольный шлюз и открытая экосистема**: серверные эндпоинты, совместимые с OpenAI, Anthropic и Gemini, позволяют OpenClaw и сторонним инструментам подключаться без доработок;
- 🚀 **Быстрые итерации и гибкое ревью**: Issues и PR сообщества рассматриваются и мержатся с высокой скоростью, сопровождаясь быстрыми beta-сборками.

---

## 🚀 Установка и быстрый старт

### 1. Десктопное приложение (рекомендуется)

Готовое кроссплатформенное десктопное приложение со встроенным WebUI и автоматической интеграцией `jeikcode` CLI в PATH:

| ОС / архитектура | Установщик | Описание |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Скачать установщик Windows (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | Графический мастер установки |
| **macOS** (Apple Silicon / Intel) | [🍏 **Скачать установщик macOS (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | Поддержка Apple Mac |
| **Linux** (x64: Debian / Ubuntu / универсальный) | [🐧 **Скачать пакет Linux (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | Автономный исполняемый пакет |

> 🍎 **macOS: исправление ошибки «приложение повреждено и не может быть открыто»**:
> Перетащите приложение в `/Applications`, затем выполните в терминале:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Официальная установка одной строкой (CLI)

```bash
# Выполните в терминале Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Выполните в Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> Для headless-устройств (боксы, NAS, софт-роутеры) нужен только CLI-бинарник. Матрица поддержки: [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 Быстрый старт

Перейдите в каталог любого проекта и запустите:

```bash
cd /path/to/your/project
jeikcode
```

Основные опции CLI:
```bash
# Запуск в указанном каталоге
jeikcode -C /path/to/project

# Открыть WebUI в браузере
jeikcode webui

# Продолжить предыдущую сессию
jeikcode -c

# Автономное выполнение задачи (CI/CD и скрипты)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# Обновление до последней версии одной командой
jeikcode update
```

---

## 📝 История изменений (Changelog)

> Полная история — в [CHANGELOG.md](./CHANGELOG.md) и [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Поддержка и спонсорство

Если JeikCode помогает вашему инженерному процессу, поддержите дальнейшую разработку и поддержку open-source!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 Лицензия

Проект распространяется по **лицензии JeikCode Non-Commercial & Attribution (на основе CC BY-NC 4.0)**. Подробности в [LICENSE](./LICENSE):

1. **Некоммерческое ограничение**: без предварительного письменного разрешения автора запрещено использовать программное обеспечение полностью или частично в коммерческих целях, интегрировать в коммерческие продукты, монетизируемые сервисы, SaaS-хостинг или коммерчески распространять.
2. **Обязательная атрибуция**: любое публичное развёртывание, распространение, форк или производная работа должны явно сохранять исходное уведомление об авторских правах, название проекта (**JeikCode**), указание автора и URL официального репозитория: `https://github.com/jeikl/JeikCode`.
3. **Коммерческое лицензирование**: по вопросам коммерческой лицензии, корпоративной интеграции или партнёрства свяжитесь с автором через официальный репозиторий.
