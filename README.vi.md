<div align="center">
  <img src="./assets/jeikcode-logo.svg" alt="JeikCode Logo" width="120" />
  <h1>JeikCode: Đồ thị mã nguồn gốc · Bộ nhớ đệm KV tối đa · Tác nhân tất cả trong một đa nền tảng (TUI / WebUI / Desktop)</h1>
  <p><strong>Đồ thị mã nguồn gốc · Bảo vệ bộ nhớ đệm KV 98–99% · Tác nhân đa nền tảng (TUI, WebUI, Desktop) · Tự phục hồi siêu tốc</strong></p>
  <p>
    <em>Tác nhân lập trình AI tự hành thế hệ mới được thiết kế riêng cho phát triển phần mềm phức tạp trong môi trường sản xuất — loại bỏ phình ngữ cảnh, vòng lặp công cụ lỗi và mất bộ nhớ đệm.</em>
  </p>
  <p>
    <a href="./README.md"><strong>English (Default)</strong></a> · <a href="./README.zh-CN.md"><strong>简体中文</strong></a> · <a href="./README.zh-TW.md"><strong>繁體中文</strong></a> · <a href="./README.ja.md"><strong>日本語</strong></a> · <a href="./README.ko.md"><strong>한국어</strong></a> · <a href="./README.ru.md"><strong>Русский</strong></a> · <a href="./README.fr.md"><strong>Français</strong></a> · <a href="./README.es.md"><strong>Español</strong></a> · <a href="./README.de.md"><strong>Deutsch</strong></a> · <a href="./README.ar.md"><strong>العربية</strong></a> · <strong>Tiếng Việt</strong>
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
      <img src="https://img.shields.io/badge/📖_Tài_liệu_chính_thức-jeikcode.top-0284c7?style=for-the-badge" alt="Docs">
    </a>
    <a href="https://github.com/jeikl/JeikCode">
      <img src="https://img.shields.io/badge/⭐_Star_trên_GitHub-Ủng_hộ_dự_án-2563eb?style=for-the-badge&logo=github&logoColor=white" alt="GitHub Repo">
    </a>
    <a href="https://github.com/jeikl/JeikCode/releases">
      <img src="https://img.shields.io/badge/📥_Tải_bản_phát_hành-Mới_nhất-0ea5e9?style=for-the-badge" alt="Releases">
    </a>
  </p>
  <p>
    🌐 <strong>Cổng tài liệu chính thức</strong>: <a href="https://jeikcode.top"><strong>https://jeikcode.top</strong></a> · 
    ⭐ <strong>Mã nguồn</strong>: <a href="https://github.com/jeikl/JeikCode"><strong>https://github.com/jeikl/JeikCode</strong></a>
  </p>
</div>

---

## 📌 JeikCode là gì?

**JeikCode** là một AI coding agent mã nguồn mở thế hệ mới, đa nền tảng và đầy đủ tính năng, được xây dựng thuần **Rust**. Thiết kế cho kỹ thuật phần mềm production phức tạp, nó mang lại sự nhẹ nhàng tối đa, kiểm soát hoàn toàn và quy trình đa thiết bị đầu-cuối:

- 🔍 **Đồ thị mã ngữ nghĩa (CodeExplore)**: dựa trên Tree-Sitter cho 12+ ngôn ngữ. Từ điển song ngữ theo miền (`thesaurus`) cho phép truy vấn mã và chuỗi gọi bằng ngôn ngữ nghiệp vụ tự nhiên, với bản vá tăng dần 1–3 ms;
- 🛡️ **Bảo vệ KV-Cache 98–99% (Sacred Floor)**: bất biến byte append-only nghiêm ngặt và bảo toàn bộ nhớ giữ prefix hệ thống cố định qua các lượt. Loại bỏ cache thrashing, giảm chi phí token hơn 90% và nén TTFT xuống mili giây;
- ⚡ **Prompt tối giản 9k và kỷ luật cao**: tránh prompt hệ thống phình 30–50k token. Một lượt tiêu chuẩn chỉ dùng ~9–11k token, dành tối đa ngữ cảnh cho mã nguồn; quy tắc được nạp lại nóng;
- 📱 **Quy trình đa nền tảng và agent thống nhất**: TUI terminal, WebUI hiện đại, ứng dụng Tauri, daemon nền và router/gateway OpenWrt (x86_64 / aarch64). Trải nghiệm nhất quán trên Windows, macOS, Linux và OpenWrt;
- 🔒 **Bảo vệ nguyên tử kiểu Git**: ranh giới chỉnh sửa đồng thời nghiêm ngặt loại bỏ ghi bẩn. Hoạt động ổn định với cả mô hình mạnh và nhẹ, kèm undo và điểm khôi phục một chạm;
- 🔄 **Hỗ trợ gốc 5 giao thức**: `OpenAI Chat`, `OpenAI Responses`, `Anthropic Claude`, `Google Gemini` và `Ollama`, tách biệt hoàn toàn tài khoản và mô hình;
- 🧩 **Gateway ba giao thức và hệ sinh thái mở**: cung cấp endpoint máy chủ tương thích OpenAI, Anthropic và Gemini, cho phép OpenClaw hoặc plugin dịch kết nối dễ dàng;
- 🚀 **Lặp nhanh và review linh hoạt**: Issue và PR cộng đồng được review, merge với tốc độ cao, kèm các bản beta nhanh.

---

## 🚀 Cài đặt và bắt đầu nhanh

### 1. Ứng dụng desktop (khuyến nghị)

Ứng dụng desktop đa nền tảng dùng ngay, tích hợp WebUI và tự động thêm CLI `jeikcode` vào PATH:

| Hệ điều hành / kiến trúc | Bộ cài | Mô tả |
| :--- | :--- | :--- |
| **Windows** (64-bit) | [📥 **Tải bộ cài Windows (.exe)**](https://github.com/jeikl/JeikCode/releases/latest) | Trình cài đặt đồ họa |
| **macOS** (Apple Silicon / Intel) | [🍏 **Tải bộ cài macOS (.dmg)**](https://github.com/jeikl/JeikCode/releases/latest) | Hỗ trợ Apple Mac |
| **Linux** (x64: Debian / Ubuntu / phổ thông) | [🐧 **Tải gói Linux (.deb / .AppImage)**](https://github.com/jeikl/JeikCode/releases/latest) | Gói chạy độc lập |

> 🍎 **macOS: sửa lỗi «ứng dụng bị hỏng và không thể mở»**:
> Kéo ứng dụng vào `/Applications`, sau đó chạy trong Terminal:
> `xattr -cr "/Applications/JeikCode Desktop.app"`

### 2. Cài đặt chính thức một dòng (CLI)

```bash
# Chạy trong terminal Linux / macOS / OpenWrt
curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | sh
```

```powershell
# Chạy trên Windows (PowerShell)
irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
```

> Thiết bị không giao diện (box, NAS, router phần mềm) chỉ cần binary CLI. Ma trận hỗ trợ: [Supported Platforms](https://jeikcode.top/guide/supported-platforms).

---

## 💡 Bắt đầu nhanh

Di chuyển vào bất kỳ kho mã nào và chạy:

```bash
cd /path/to/your/project
jeikcode
```

Tùy chọn CLI thường dùng:
```bash
# Khởi động trong thư mục chỉ định
jeikcode -C /path/to/project

# Mở WebUI trong trình duyệt
jeikcode webui

# Tiếp tục phiên trước
jeikcode -c

# Chạy tác vụ không giao diện (CI/CD và script)
jeikcode -p "Investigate and fix OAuth callback 404 issue"

# Nâng cấp lên bản mới nhất một chạm
jeikcode update
```

---

## 📝 Nhật ký thay đổi (Changelog)

> Lịch sử đầy đủ tại [CHANGELOG.md](./CHANGELOG.md) và [GitHub Releases](https://github.com/jeikl/JeikCode/releases).

---

## ☕ Hỗ trợ và tài trợ

Nếu JeikCode hữu ích cho quy trình của bạn, hãy ủng hộ quá trình phát triển và duy trì mã nguồn mở!

<div align="center">
  <img src="./assets/jeikpaypal.jpg" width="220" alt="PayPal Sponsor QR Code" style="border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
</div>

---

## 📄 Giấy phép

Dự án được phát hành theo **Giấy phép JeikCode Phi thương mại & Ghi công (phỏng theo CC BY-NC 4.0)**. Xem [LICENSE](./LICENSE):

1. **Hạn chế phi thương mại**: không được sử dụng phần mềm hoặc tác phẩm phái sinh, toàn bộ hoặc một phần, cho mục đích thương mại, tích hợp sản phẩm thương mại, dịch vụ kiếm tiền, lưu trữ SaaS hoặc phân phối thương mại mà không có sự cho phép bằng văn bản trước của tác giả.
2. **Ghi công bắt buộc**: mọi triển khai công khai, phân phối, fork hoặc tác phẩm phái sinh phải giữ nổi bật thông báo bản quyền gốc, tên dự án (**JeikCode**), ghi công tác giả và URL kho chính thức `https://github.com/jeikl/JeikCode`.
3. **Cấp phép thương mại**: cho cấp phép thương mại, tích hợp doanh nghiệp hoặc hợp tác, vui lòng liên hệ tác giả qua kho chính thức.
