# Kiểm chứng portability và feature isolation — 2026-10-07

Tiếp nối [đợt sửa lỗi nền](cleanup-continuation-2026-10-07.md), trên baseline local `fb3b8bf4b`.

## Những gì đã thực hiện

- Thêm `.github/workflows/portability.yml`: native runners Windows/Linux/macOS, feature-isolated checks/tests và WebUI locked install. Có summary gate, không `continue-on-error`, log artifacts 7 ngày, timeout, concurrency và quyền `contents: read`. Không dùng secret, không phát hành, checkout không lưu credential.
- Workflow chạy cho PR vào main, push main hoặc dispatch thủ công; không có trigger tag. CI hiện hành cho release không bị sửa.
- Feature job gọi Cargo riêng cho `core`, `tools`, `codeintel`, `provider`, `session`, `mcp`, rồi check library `--all-features`. Không dùng workspace unification làm bằng chứng feature độc lập.
- Ranh giới capabilities được sửa để no-default có thể compile/test: process utilities khai báo đủ Tokio primitives; session không re-export write hook khi tools tắt; Windows shell discovery dùng chung ở lớp neutral, không tạo phụ thuộc session → tools.
- JSON repair compile một lần ở module dùng chung; giữ compatibility alias `tools::repair`. Provider-only dùng cùng logic repair, không bật toàn bộ tools ngầm hoặc chỉ bọc raw arguments để né test.
- Sửa fixture project hash cho no-tools: kiểm tra scheme lexical đã chuẩn hóa, không thay identity storage production.
- Thêm regression Unix filename Unicode/backslash, symlink identity và case semantics; không giả định macOS filesystem phân biệt case.
- Thêm lexical UNC tests và test UNC thật opt-in `pathnorm::tests::codeintel_windows_real_unc_alias_identity`. Test explicit thiếu fixture sẽ fail, không silent pass; chỉ tạo/dọn thư mục con TempDir trong root được cấp.
- Sửa Windows CC hook truyền CMD source bằng `raw_arg`: CRT escape qua `.arg()` trước đây làm hỏng quoted executable path. Windows vẫn CMD, Unix vẫn sh; không chuyển shell contract ngầm. Fixture dùng Python, giữ kiểm tra stdin, exit code, JSON, timeout.
- Skill catalog giữ nguyên policy activation ban đầu; cập nhật assertion theo exact catalog và thêm discovery hint `list_skills` cho entries bị budget omit. Không thêm bắt buộc brainstorming cho mọi task. Teaches đồng bộ disclosure và hook shell contract.
- Sửa lockfile WebUI thiếu optional peer dependency khiến `npm ci` fail. Không đổi dependency ranges; root version lockfile đồng bộ package version 7.1.53 hiện có. Job WebUI dùng Node 22, phù hợp tests chạy TypeScript trực tiếp.

## Kết quả thực chạy trên Windows

Máy host Windows 10; Node 22.20.0, npm 10.9.3, Rust/Cargo 1.93.0, actionlint 1.7.7. Cargo serial, debug0/incremental0; check dùng home không tồn tại để CLI build.rs không sync asset cá nhân. Test constructor tự sở hữu home, không dùng JEIKCODE_HOME cá nhân.

| Cấu hình | Kết quả tests (không filter lỗi) |
|---|---:|
| core / no optional feature | 84 đạt |
| tools | 683 đạt |
| codeintel | 209 đạt |
| provider | 382 đạt |
| session | 266 đạt |
| mcp | 211 đạt |
| capabilities native có codeintel | 1018 đạt |
| capabilities expanded cùng production features của coding | 1466 đạt |
| coding | 364 đạt |
| telemetry | 81 đạt |
| WebUI sau `npm ci` | 302 đạt |

Mỗi cấu hình capabilities có **1 ignored UNC test cần share thật**; coding có **8 ignored có sẵn**. Không có filtered-out hoặc failing test trong các suite đầy đủ nói trên. Các counts có test trùng giữa nhiều feature configuration: không cộng chúng thành số test duy nhất.

Các check sau đều đạt:

- `cargo check` library cho từng feature độc lập và `--all-features`.
- `cargo check --workspace --locked --offline`.
- Desktop workspace check `--locked --offline`.
- `npm ci`, WebUI typecheck/build (còn chunk >500 kB warning).
- actionlint thực và parser YAML assertions cho trigger/permissions/native matrix/no-continue-on-error.
- `git diff --check`.
- Renderer sau giữ nguyên activation guidance được test lại riêng: 9 đạt.

Lần chạy exact CI-expanded ban đầu tìm thêm 8 lỗi ngoài suite mặc định: 6 POSIX fixture hooks trên CMD và 2 catalog assertions lỗi thời. Đã xử lý theo contract thực, không bật skip và không đổi CI thành green giả. Lần chốt expanded: capabilities 1466, coding 364, telemetry 81 đều đạt.

## Những gì chưa được chứng minh

- **Linux/macOS chưa chạy thực tế trong đợt này.** Host không có distro WSL hoặc Docker runner dùng được; workflow mới chưa push/dispatch. Actionlint không chứng minh runtime native tests sẽ pass trên các OS khác.
- Không có UNC share được cấp; UNC thật chưa chạy. Không tự tạo SMB share, đổi credential hoặc dùng admin.
- CI feature job chạy Ubuntu; Windows local đã kiểm chứng cùng từng feature. Native matrix không thay cho mọi feature combination hoặc toàn bộ target Rust.
- Không thay release pipeline, prefix hot-reload contract, website ownership hoặc runtime lifecycle.
- Logs local nằm ở `.jeikcode/portability-*.log` và `.jeikcode/portability-logs/`; không track tool binaries, npm node_modules hoặc các temporary home.
- Review độc lập đã thực hiện; mọi cảnh báo reviewer được đối chiếu source thực. Có nhận định về hàm không nằm trong diff nên không áp dụng patch dựa trên suy đoán.

## Git và bảo toàn dữ liệu

- Không push/tag/phát hành. Commit local mới phải có trailer JeikCode theo AGENTS.md.
- `origin/main` quan sát qua API vẫn tại `18824be4b`; không tự tích hợp beta/release workflow từ branch khác.
- Diff worktree daemon giữ fingerprint `2da3d2d95c14479e868525c8f8a64bc3c6d0096f`; chat worktree sạch. Không xóa worktree, session, source hoặc thay đổi của phiên khác.

## Bước tiếp theo

1. Người duy trì review/push các commit local, chạy portability workflow và xem **cả Windows/Linux/macOS + features + WebUI + summary**; chưa gọi đây là chứng nhận đa nền tảng trước khi runner kết thúc thành công.
2. Nếu có UNC root được cấp, chạy exact opt-in command trong [portability-ci.md](portability-ci.md), không chạy `--ignored` toàn suite.
3. Chốt contract prefix/hot-reload: protected floor không đồng nghĩa byte immutability; quyết định explicit cache invalidation hay append-only updates trước khi sửa.
4. Chốt vai trò site/docs-site và frontend lockfile. Sau đó chọn một lát nhỏ: full-stack dev proxy auth/WebSocket, hoặc Chat search/CSS; đo bundle trước code-split.
5. Không gộp release, refactor TUI/runtime state machine hoặc xóa worktree vào đợt portability.
