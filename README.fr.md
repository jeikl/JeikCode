<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Graphe de Code Natif · Cache KV Extrême · Agent Tout-en-Un Multiplateforme (TUI / WebUI / Desktop)</h1>
  <p><strong>Graphe de Code Natif · Protection du Cache KV 98–99% · Agent Tout-en-Un (TUI, WebUI, Desktop) · Auto-Réparation Rapide</strong></p>
  <p>
    <em>Agent de programmation IA autonome de nouvelle génération conçu pour l'ingénierie logicielle complexe en production — éliminant la saturation du contexte, les boucles d'outils défaillantes et la dégradation du cache.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <strong>Français</strong> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>Documentation officielle</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Code source</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 Qu'est-ce que JeikCode ?

**JeikCode** est un agent de codage IA open source nouvelle génération, multiplateforme et complet, construit nativement en **Rust**. Conçu pour l'ingénierie de production complexe, il offre une légèreté extrême, un contrôle total et des workflows multi-appareils de bout en bout :

- 🔍 **Graphe de code sémantique (CodeExplore)** : propulsé par Tree-Sitter sur 12+ langages. Les thésaurus bilingues (`thesaurus`) permettent d'interroger le code et les chaînes d'appel en langage métier naturel, avec des patchs incrémentaux de 1 à 3 ms ;
- 🛡️ **Protection du cache KV à 98–99 % (Sacred Floor)** : l'immuabilité stricte des octets en append-only et la préservation mémoire gardent le préfixe système figé entre les tours. Élimine le cache thrashing, réduit les coûts de tokens de plus de 90 % et compresse le TTFT à l'échelle de la milliseconde ;
- ⚡ **Prompts minimaux de 9k et discipline élevée** : évite les prompts système gonflés de 30 à 50k tokens. Un tour standard ne consomme qu'environ 9 à 11k tokens, laissant le maximum de contexte au code ; les règles sont rechargées à chaud ;
- 📱 **Workflows omnicanaux et agent unifié** : TUI terminal, WebUI moderne, application Tauri, démon d'arrière-plan et routeurs/passerelles OpenWrt (x86_64 / aarch64). Une expérience cohérente sous Windows, macOS, Linux et OpenWrt ;
- 🔒 **Protection atomique type Git** : des frontières strictes pour les éditions concurrentes de fichiers éliminent les écritures sales. Fonctionne avec les modèles puissants comme légers, avec annulation et points de restauration en un clic ;
- 🔄 **Prise en charge native de 5 protocoles** : `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini` et `Ollama`, avec découplage complet des comptes et des modèles ;
- 🧩 **Passerelle tri-protocole et écosystème ouvert** : expose des endpoints serveur compatibles OpenAI, Anthropic et Gemini, permettant à OpenClaw ou à des plugins de traduction de se connecter sans effort ;
- 🚀 **Itérations rapides et revue agile** : les Issues et PR de la communauté sont examinées et fusionnées très rapidement, avec des builds bêta fréquents.

---

## 🚀 Installation et démarrage rapide

### 1. Application de bureau (recommandée)

Application de bureau multiplateforme prête à l'emploi, avec WebUI intégrée et ajout automatique du CLI `jeikcode` au PATH :

| OS / architecture | Programme d'installation | Description |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Télécharger l'installateur Windows (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | Assistant graphique |
| **macOS** (Apple Silicon / Intel) | [🍏 **Télécharger l'installateur macOS (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | Compatible Apple Mac |
| **Linux** (x64 : Debian / Ubuntu / universel) | [🐧 **Télécharger le paquet Linux (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | Paquet autonome |

> 🍎 **macOS : corriger le message « application endommagée et ne peut pas être ouverte »** :
> Glissez l'application dans `/Applications`, puis exécutez dans le terminal :
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Installation officielle en une ligne (CLI)

```bash
# À exécuter dans un terminal Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# À exécuter sous Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> Les appareils sans interface (box, NAS, routeurs logiciels) n'ont besoin que du binaire CLI. Matrice de support : [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 Démarrage rapide

Placez-vous dans n'importe quel dépôt de code et lancez :

```bash
cd /path/to/your/project
jeikcode
```

Options CLI courantes :
```bash
# Démarrer dans un répertoire donné
jeikcode -C /path/to/project

# Ouvrir la WebUI dans le navigateur
jeikcode webui

# Continuer la session précédente
jeikcode -c

# Exécution autonome d'une tâche (CI/CD et scripts)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# Mise à jour en un clic vers la dernière version
jeikcode update
```

---

## 📝 Journal des modifications (Changelog)

> Historique complet dans [CHANGELOG.md](./CHANGELOG.md) et [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Support et sponsoring

Si JeikCode améliore votre flux de travail, vous pouvez soutenir le développement continu et la maintenance open source !

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 Licence

Ce projet est publié sous **licence JeikCode Non-Commercial & Attribution (adaptée de CC BY-NC 4.0)**. Voir [LICENSE](./LICENSE) :

1. **Restriction non commerciale** : sans autorisation écrite préalable de l'auteur, le logiciel et ses dérivés ne peuvent être utilisés, en tout ou partie, à des fins commerciales, intégrés à un produit commercial, monétisés, hébergés en SaaS ou redistribués commercialement.
2. **Attribution obligatoire** : tout déploiement public, distribution, fork ou œuvre dérivée doit conserver de manière visible l'avis de copyright d'origine, le nom du projet (**JeikCode**), le crédit de l'auteur et l'URL du dépôt officiel : `https://github.com/jeikl/JeikCode`.
3. **Licence commerciale** : pour une licence commerciale, une intégration en entreprise ou un partenariat, contactez l'auteur via le dépôt officiel.
