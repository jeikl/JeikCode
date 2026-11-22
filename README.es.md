<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Grafo de Código Nativo · Caché KV Extrema · Agente Todo en Uno Multiplataforma (TUI / WebUI / Desktop)</h1>
  <p><strong>Grafo de Código Nativo · 98–99% Protección de Caché KV · Agente Multiplataforma (TUI, WebUI, Desktop) · Recuperación Ultrarrápida</strong></p>
  <p>
    <em>Agente de programación autónomo con IA de última generación diseñado para ingeniería de software compleja en producción — eliminando el desbordamiento de contexto, bucles de herramientas rotos y la degradación de caché.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <strong>Español</strong> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>Portal de Documentación Oficial</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Código Fuente</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 ¿Qué es JeikCode?

**JeikCode** es un agente de programación con IA de nueva generación, multiplataforma y completo, construido nativamente en **Rust**. Diseñado para ingeniería de producción compleja, ofrece extrema ligereza, control total y flujos de trabajo multidispositivo de extremo a extremo:

- 🔍 **Grafo semántico de código (CodeExplore)**: impulsado por Tree-Sitter en más de 12 lenguajes. Los tesauros bilingües (`thesaurus`) permiten consultar el código y las cadenas de llamadas con lenguaje de negocio natural, con parches incrementales de 1 a 3 ms;
- 🛡️ **Protección de caché KV del 98–99 % (Sacred Floor)**: la inmutabilidad estricta de bytes en modo append-only y la preservación de memoria mantienen el prefijo del sistema congelado entre turnos. Elimina el cache thrashing, reduce el coste de tokens más del 90 % y comprime el TTFT a milisegundos;
- ⚡ **Prompts mínimos de 9k y alta disciplina**: evita prompts de sistema inflados de 30–50k tokens. Un turno estándar consume solo ~9–11k tokens, reservando el máximo contexto para el código; las reglas se recargan en caliente;
- 📱 **Flujos omnicanal y agente unificado**: TUI de terminal, WebUI moderna, aplicación Tauri, demonio en segundo plano y routers/pasarelas OpenWrt (x86_64 / aarch64). Experiencia coherente en Windows, macOS, Linux y OpenWrt;
- 🔒 **Protección atómica estilo Git**: límites estrictos en ediciones concurrentes de archivos eliminan escrituras sucias. Funciona con modelos potentes y ligeros, con deshacer y puntos de restauración en un clic;
- 🔄 **Soporte nativo de 5 protocolos**: `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini` y `Ollama`, con desacoplamiento total de cuentas y modelos;
- 🧩 **Pasarela triprotocolo y ecosistema abierto**: expone endpoints de servidor compatibles con OpenAI, Anthropic y Gemini, permitiendo que OpenClaw o plugins de traducción se conecten sin esfuerzo;
- 🚀 **Iteraciones rápidas y revisión ágil**: los Issues y PR de la comunidad se revisan y fusionan con gran velocidad, acompañados de builds beta frecuentes.

---

## 🚀 Instalación y inicio rápido

### 1. Aplicación de escritorio (recomendada)

Aplicación de escritorio multiplataforma lista para usar, con WebUI integrada y añadido automático del CLI `jeikcode` al PATH:

| SO / arquitectura | Instalador | Descripción |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Descargar instalador de Windows (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | Asistente gráfico |
| **macOS** (Apple Silicon / Intel) | [🍏 **Descargar instalador de macOS (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | Compatible con Apple Mac |
| **Linux** (x64: Debian / Ubuntu / universal) | [🐧 **Descargar paquete de Linux (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | Paquete autónomo |

> 🍎 **macOS: solución al mensaje «la aplicación está dañada y no se puede abrir»**:
> Arrastra la aplicación a `/Applications` y ejecuta en Terminal:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Instalación oficial en una línea (CLI)

```bash
# Ejecutar en una terminal Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Ejecutar en Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> Los dispositivos sin interfaz (cajas, NAS, routers software) solo necesitan el binario CLI. Matriz de soporte: [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 Inicio rápido

Entra en cualquier repositorio de código y ejecuta:

```bash
cd /path/to/your/project
jeikcode
```

Opciones CLI habituales:
```bash
# Iniciar en un directorio concreto
jeikcode -C /path/to/project

# Abrir la WebUI en el navegador
jeikcode webui

# Continuar la sesión anterior
jeikcode -c

# Ejecución autónoma de una tarea (CI/CD y scripts)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# Actualizar a la última versión con un clic
jeikcode update
```

---

## 📝 Registro de cambios (Changelog)

> Historial completo en [CHANGELOG.md](./CHANGELOG.md) y [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Soporte y patrocinio

Si JeikCode mejora tu flujo de trabajo, puedes apoyar el desarrollo continuo y el mantenimiento open source.

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 Licencia

Este proyecto se publica bajo la **licencia JeikCode Non-Commercial & Attribution (adaptada de CC BY-NC 4.0)**. Consulta [LICENSE](./LICENSE):

1. **Restricción no comercial**: sin autorización escrita previa del autor, el software y sus derivados no pueden usarse, total o parcialmente, con fines comerciales, integrarse en productos comerciales, monetizarse, alojarse como SaaS o redistribuirse comercialmente.
2. **Atribución obligatoria**: cualquier despliegue público, distribución, fork u obra derivada debe conservar de forma destacada el aviso de copyright original, el nombre del proyecto (**JeikCode**), el crédito del autor y la URL del repositorio oficial: `https://github.com/jeikl/JeikCode`.
3. **Licencia comercial**: para licencias comerciales, integración empresarial o alianzas, contacta con el autor a través del repositorio oficial.
