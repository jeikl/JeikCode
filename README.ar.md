<div align="center" dir="rtl">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: مخطط كود أصلي · تخزين مؤقت فائق لـ KV · وكيل شامل متعدد المنصات (TUI / WebUI / Desktop)</h1>
  <p><strong>مخطط كود أصلي · حماية تخزين مؤقت لـ KV بنسبة 98–99% · وكيل شامل لجميع الأجهزة · استرداد ذاتي فائق السرعة</strong></p>
  <p>
    <em>الجيل الجديد من وكلاء البرمجة الذاتية بالذكاء الاصطناعي المصمم خصيصًا للهندسة البرمجية المعقدة في الإنتاج — يقضي على تضخم السياق وحلقات الأدوات المتعطلة وفقدان التخزين المؤقت.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <strong>العربية</strong> · <a href="./README.vi.md"><strong>Tiếng Việt</strong></a>
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
    🌐 <strong>بوابة التوثيق الرسمية</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>المستودع البرمجي</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 ما هو JeikCode؟

**JeikCode** هو وكيل برمجة بالذكاء الاصطناعي مفتوح المصدر من الجيل الجديد، متعدد المنصات وكامل الميزات، بُني أصلاً بلغة **Rust**. صُمم لهندسة البرمجيات الإنتاجية المعقدة، ويوفر خفة فائقة وتحكماً كاملاً وسير عمل متعدد الأجهزة من البداية إلى النهاية:

- 🔍 **رسم بياني دلالي للشيفرة (CodeExplore)**: مدعوم بـ Tree-Sitter لأكثر من 12 لغة. تتيح القواميس ثنائية اللغة (`thesaurus`) الاستعلام عن الشيفرة وسلاسل الاستدعاء بلغة الأعمال الطبيعية، مع تحديثات تدريجية من 1 إلى 3 مللي ثانية؛
- 🛡️ **حماية ذاكرة KV بنسبة 98–99% (Sacred Floor)**: ثبات بايتات صارم بنمط append-only وحفظ للذاكرة يبقيان بادئة النظام مجمّدة بين الأدوار. يزيل اهتزاز الذاكرة ويقلل تكلفة الرموز بأكثر من 90% ويضغط زمن أول رمز إلى المللي ثانية؛
- ⚡ **أوامر نظام مختصرة بحجم 9k وانضباط عالٍ**: يتجنب تضخم أوامر النظام إلى 30–50k رمزاً. يستهلك الدور العادي نحو 9–11k رمزاً فقط، مع ترك أقصى سياق للشيفرة؛ وتُعاد القواعد تحميلها فورياً؛
- 📱 **سير عمل موحّد عبر المنصات**: TUI طرفية، WebUI حديثة، تطبيق Tauri سطح مكتب، خادم خلفي، وموجّهات/بوابات OpenWrt (x86_64 / aarch64). تجربة متسقة على Windows وmacOS وLinux وOpenWrt؛
- 🔒 **حماية ذرّية بنمط Git**: حدود صارمة للتحرير المتزامن للملفات تمنع الكتابات الفاسدة. يعمل بثبات مع النماذج القوية والخفيفة، مع تراجع ونقاط استعادة بنقرة واحدة؛
- 🔄 **دعم أصلي لخمسة بروتوكولات**: `OpenAI Chat` و`OpenAI Responses` و`Anthropic Claude` و`Google Gemini` و`Ollama` مع فصل كامل للحسابات والنماذج؛
- 🧩 **بوابة ثلاثية البروتوكولات ونظام بيئي مفتوح**: exposes نقاط نهاية متوافقة مع OpenAI وAnthropic وGemini، ما يتيح لـ OpenClaw أو إضافات الترجمة الاتصال بسهولة؛
- 🚀 **تكرار سريع ومراجعة مرنة**: تُراجع Issues وPRs المجتمع وتُدمج بسرعة عالية، مع إصدارات beta سريعة.

---

## 🚀 التثبيت والبدء السريع

### 1. تطبيق سطح المكتب (موصى به)

تطبيق سطح مكتب جاهز للاستخدام ومتعدد المنصات، يتضمن WebUI مدمجة ويضيف CLI ‏`jeikcode` تلقائياً إلى PATH:

| نظام التشغيل / المعمارية | المثبّت | الوصف |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **تنزيل مثبّت Windows (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | معالج تثبيت رسومي |
| **macOS** (Apple Silicon / Intel) | [🍏 **تنزيل مثبّت macOS (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | يدعم أجهزة Apple Mac |
| **Linux** (x64: Debian / Ubuntu / عام) | [🐧 **تنزيل حزمة Linux (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | حزمة مستقلة |

> 🍎 **macOS: إصلاح رسالة «التطبيق تالف ولا يمكن فتحه»**:
> اسحب التطبيق إلى `/Applications` ثم نفّذ في الطرفية:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. التثبيت الرسمي بسطر واحد (CLI)

```bash
# نفّذ في طرفية Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# نفّذ في Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> الأجهزة بلا واجهة (الصناديق، NAS، الموجّهات البرمجية) تحتاج فقط إلى ثنائي CLI. مصفوفة الدعم: [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 البدء السريع

انتقل إلى أي مستودع شيفرة ثم شغّل:

```bash
cd /path/to/your/project
jeikcode
```

خيارات CLI الشائعة:
```bash
# البدء في دليل محدد
jeikcode -C /path/to/project

# فتح WebUI في المتصفح
jeikcode webui

# متابعة الجلسة السابقة
jeikcode -c

# تنفيذ مهمة بلا واجهة (CI/CD والسكربتات)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# الترقية إلى أحدث إصدار بنقرة واحدة
jeikcode update
```

---

## 📝 سجل التغييرات (Changelog)

> السجل الكامل في [CHANGELOG.md](./CHANGELOG.md) و[GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ الدعم والرعاية

إذا كان JeikCode مفيداً لسير عملك، يمكنك دعم التطوير المستمر وصيانة المصدر المفتوح!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 الترخيص

يُوزَّع هذا المشروع بموجب **ترخيص JeikCode غير التجاري مع الإسناد (مستند إلى CC BY-NC 4.0)**. راجع [LICENSE](./LICENSE):

1. **قيد غير تجاري**: لا يجوز استخدام البرنامج أو أعماله المشتقة، كلياً أو جزئياً، لأي غرض تجاري أو دمج في منتج تجاري أو خدمة مربحة أو استضافة SaaS أو إعادة توزيع تجاري دون إذن كتابي مسبق من المؤلف.
2. **إسناد إلزامي**: يجب على أي نشر عام أو توزيع أو fork أو عمل مشتق الاحتفاظ بشكل بارز بإشعار حقوق النشر الأصلي واسم المشروع (**JeikCode**) واسم المؤلف ورابط المستودع الرسمي `https://github.com/jeikl/JeikCode`.
3. **الترخيص التجاري**: للترخيص التجاري أو التكامل المؤسسي أو الشراكات، تواصل مع المؤلف عبر المستودع الرسمي.
