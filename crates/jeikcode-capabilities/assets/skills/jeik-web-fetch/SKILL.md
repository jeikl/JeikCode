---
name: jeik-web-fetch
description: "High-performance web extraction tool. Scrapes any URL (SPA, dynamic JS, anti-bot, intranet, or internet) and outputs clean structured Markdown with 3 categorized modes: --fast (default), --common, and --complex."
---

# Jeik Web Fetch

Run the `jeik fetch` command directly in terminal or bash. `jeik fetch` provides 3 dedicated extraction modes tailored for different types of web pages:

```bash
jeik fetch "<URL>" [mode-flag] [options]
```

---

## 🎯 3 Categorized Fetch Modes (三档抓取模式分类)

| 模式选项 | 适用场景与网页类型 | 运行机制与核心优势 | 示例命令 |
| :--- | :--- | :--- | :--- |
| **`--fast`**<br>*(缺省 / Default)* | **静态网页与纯文本**<br>• GitHub 仓库、Issues、代码文件<br>• 纯 HTML 博客、维基百科<br>• CSS、JS、Markdown、JSON 等 Raw 文件 | **毫秒级极速探针直出**<br>无需拉起浏览器，零内存开销，200ms 内秒级输出结构化 Markdown。若遇骨架屏自动自愈升级。 | `jeik fetch "https://github.com/..."`<br>`jeik fetch "https://example.com" --fast` |
| **`--common`** | **非静态技术文档与动态 JS 页面**<br>• 嵌套式 JS 技术文档（DeepSeek, MiMo, Docusaurus, Mintlify）<br>• SPA 客户端渲染（React / Vue / Next.js / Nuxt）<br>• 包含 Monaco / CodeMirror 编辑器、懒加载与展开抽屉的复杂技术手册 | **无头浏览器完整深度渲染**<br>跳过静态探针，直接唤起 Chromium 完整执行 JavaScript，等待组件水合并展开代码块，高保真提取正文与侧边栏目录超链接。 | `jeik fetch "https://mimo.mi.com/docs/..." --common`<br>`jeik fetch "https://api-docs.deepseek.com/..." --common` |
| **`--complex`** | **高风控反爬与强交互网站**<br>• 风控极严站点（知乎、小红书、微信公众号、淘宝等）<br>• 遇到 Cloudflare 5秒盾、验证码拦截、需要登录态或复杂反爬检测的页面 | **深度反爬对抗与浏览器接管**<br>启用高级 Stealth 伪装、加大缓冲等待并执行平滑微操滚动；支持一键通过 `jeik open` 打开真实浏览器登录后直接无缝接管！ | `jeik fetch "https://www.zhihu.com/..." --complex`<br>`jeik open "<URL>"` 登录后执行 `jeik fetch --active-tab` |

---

## 🚀 Usage Examples

### 1. Fast Mode (Default) — 静态网页秒级抓取
```bash
# 抓取 GitHub 仓库、文档或静态博客（缺省默认为 --fast）
jeik fetch "https://github.com/torvalds/linux"
jeik fetch "https://raw.githubusercontent.com/user/repo/main/README.md" --fast
```

### 2. Common Mode — 复杂/动态 JS 技术文档完整抓取
```bash
# 抓取嵌套式前端技术文档、Swagger/OpenAPI 文档、带侧边栏超链接与代码示例的 API 手册
jeik fetch "https://mimo.mi.com/docs/zh-CN/api/guidance/rate-limit" --common
jeik fetch "https://api-docs.deepseek.com/zh-cn/api/create-chat-completion" --common
```

### 3. Complex Mode — 高风控对抗与登录接管抓取
```bash
# 抓取知乎、小红书等有严格反爬策略的站点
jeik fetch "https://www.zhihu.com/question/123456" --complex

# 如果遇到登录墙或滑块验证码（1秒极简方案）：
jeik open "https://www.xiaohongshu.com"   # 弹出已配置好调试通道的浏览器，用户正常浏览或扫码登录
jeik fetch --active-tab                  # 瞬间直接接管并提取当前已登录的标签页！
```

---

## ⚙️ Advanced Options

```bash
# 1. 多线程高并发批量抓取 (-j / --threads)
jeik fetch "url1" "url2" "url3" -j 4 --common

# 2. 自定义 DNS 解析 (--dns，支持纯数字 IP 或 DoH 加密 DNS)
jeik fetch "<URL>" --dns "https://1.1.1.1/dns-query"

# 3. 携带登录态 Cookies (--cookie / --cookie-file)
jeik fetch "<URL>" --cookie "session_id=abc; token=123" --complex
jeik cookie set zhihu.com "z_c0=..."     # 永久保存域名登录态，后续自动装载

# 4. 控制侧边栏目录提取 (--no-sidebar)
jeik fetch "<URL>" --common --no-sidebar  # 仅提取正文主体，不挂载文末侧边栏链接列表
```

> Output begins with an absolute path anchor header where the full Markdown has been persisted safely to `.jeik/fetches/`.
