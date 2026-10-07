# Tiếp tục dọn dẹp: đồng bộ upstream và sửa lỗi nền — 2026-10-07

## Trạng thái và phạm vi

Tiếp nối [báo cáo cleanup ban đầu](cleanup-validation-2026-10-07.md).

- Commit cleanup: `413f413fd` (`refactor(cleanup): retire stale release paths and remove unused code`).
- Đã fetch và merge `origin/main` tới `18824be4b`; merge commit local: `96e9d1969`. Không có xung đột, không rewrite lịch sử hoặc reset worktree.
- Các commit có trailer `Co-Authored-By: JeikCode <code@jeikcode.top>`.
- Không push, tag hoặc phát hành. Không thay runtime lifecycle owner, contract prefix hay hợp nhất website.
- Diff chưa commit của worktree daemon giữ nguyên Git blob fingerprint `2da3d2d95c14479e868525c8f8a64bc3c6d0096f`; worktree chat vẫn sạch. Không xóa source hoặc worktree.

## Sửa lỗi theo nguyên nhân

### CodeIntel: identity đường dẫn và persistence

- Dùng identity chung giữa walker, editor, scoped query và cache trên Windows; resolve alias 8.3, slash và verbatim prefix. Không hạ lowercase hoặc đổi backslash hợp lệ trên Unix.
- So sánh relative path theo component, không cắt chuỗi theo độ dài của root có spelling khác. Hai scope tuyệt đối không được khớp nhờ substring qua drive/root khác nhau; vẫn giữ tương thích relative-vs-absolute có chủ đích.
- Graph resolve canonical identity của query một lần rồi so sánh key trong bộ nhớ; không canonicalize từng key trong vòng fallback. Có regression cho alias delete/update và Unix symlink lookup. Test Unix không chạy trên host Windows này.
- Git-ignore walker nhận relative path cùng identity với root, tránh panic `path is expected to be under the root` khi Temp root có dạng tên ngắn khác.
- SQLite chuẩn hóa các write/load/delete boundary, kể cả public prepared writes và legacy rows. Windows dùng indexed `COLLATE NOCASE` cho delete bằng alias khác case sau khi file đã mất; Unix vẫn so sánh phân biệt case.

### Edit/todo: phục hồi có giới hạn và không ghi dữ liệu cắt

- Stringified edits phải chứng minh toàn bộ danh sách đủ dữ liệu trước deserialize/coalesce hoặc file IO.
- Không áp dụng hunk A rồi âm thầm bỏ hunk B bị cắt; complete sibling không được che phần edit request chưa hoàn chỉnh. Các regression kiểm tra file giữ nguyên khi từ chối.
- Xử lý nháy đơn trong edits losslessly trước structural repair, giữ punctuation và nội dung chuỗi. Có ngân sách byte/depth xuyên JSON-in-string và cây JSON; trả lỗi có kiểm soát khi quá giới hạn.
- Todo vẫn phục hồi được sibling hoàn chỉnh theo schema cho trường hợp hybrid, không chấp nhận phần text bị cắt như thể hoàn chỉnh.

### Python Windows: chạy interpreter tại chỗ

- Lỗi `No pyvenv.cfg file` do venv launcher bị copy/hardlink ra khỏi thư mục gốc.
- Thay bằng forwarding wrappers Git Bash/CMD, gọi interpreter ở vị trí thật. Native command heads vẫn rewrite tới executable gốc.
- Wrapper key phụ thuộc interpreter và nội dung; xuất bản bằng tempfile cùng thư mục và `persist_noclobber`, không truncate wrapper mà process khác đang đọc. Kiểm tra concurrency, argv, exit code, nested shell và venv thật.
- Quoting vẫn theo hợp đồng từng shell; không tuyên bố mọi chuỗi argv đều chuyển nguyên vẹn qua mọi shell. Teaches đã cập nhật.

### Coding/telemetry: fixture đúng và privacy không đổi

- Source-build gateway fixture dùng URL unsupported cụ thể thống nhất với mock factory. Steering assertion kiểm tra nội dung đã compose theo contract hiện hành, không đòi text raw. Không sửa production CodingRuntime để thỏa fixture.
- Telemetry mặc định không có endpoint và disabled `no_endpoint`; bỏ kiểm tra env trùng, sửa reason/assertion và thêm case precedence. Không bật destination upstream, không gửi telemetry để kiểm chứng.
- Repo-origin classifier phân tích authority URL/SCP thay vì substring; phủ spoof userinfo/path/domain. Provider host test đòi host đúng, không chứa path.
- Cập nhật teaches về endpoint, opt-out precedence và restart cho cấu hình startup-only.

### WebUI sau merge

- Bỏ setter `setSync(false)` đã không tồn tại sau thay đổi upstream (sync hiện cố định false), giữ cleanup reconnect và error feedback.
- Không đổi thiết kế composer hoặc hành vi queued-input upstream để né TypeScript check.

## Kiểm chứng cuối

Các lệnh Rust dùng `CARGO_INCREMENTAL=0`, debug symbols bằng 0 để hạn chế cache. Workspace check đặt `JEIKCODE_HOME` cách ly, tránh build.rs đồng bộ asset cá nhân. Unit tests bỏ override home để constructor tự cách ly. Không sửa CI hoặc đánh dấu ignore mới để làm test xanh.

| Kiểm tra | Kết quả |
|---|---|
| Capabilities `--features codeintel --lib -- --test-threads=1` | **1018 đạt, 0 fail, 0 ignored, 0 filtered out** |
| Coding `--lib -- --test-threads=1` | **364 đạt, 0 fail, 8 ignored có sẵn, 0 filtered out** |
| Telemetry `--lib -- --test-threads=1` | **81 đạt, 0 fail, 0 filtered out** |
| WebUI `npm test` | **302 đạt, 0 fail, 0 skipped** |
| WebUI `npm run typecheck` / `npm run build` | Đạt; còn cảnh báo bundle chunk >500 kB |
| `cargo check --workspace --locked --offline` | Đạt |
| Desktop `cargo check --manifest-path desktop/src-tauri/Cargo.toml --offline` | Đạt sau merge upstream |
| `git diff --check` | Đạt |
| Review độc lập | Không còn blocker mới trong phạm vi sửa |

Tổng **1765 test đạt**, không lọc bỏ 16 lỗi cũ. Số ignored coding không đổi. Chưa chạy toàn bộ test mọi crate/feature/platform trong workspace. Các warning compiler ngoài phạm vi cleanup vẫn còn; không format toàn repository để xóa khác biệt nền.

## Browser smoke test

Dùng agent-browser cài cục bộ trong `.jeikcode/browser-tools`, Chrome headless session riêng không tài khoản và cổng tự chọn. Fixture trong `.jeikcode/browser-smoke` render **đúng ba component thật** qua transform chỉ dùng cho test; API giả lập, không gọi live agent/session cá nhân, không thêm production exports.

- Code, diff và terminal: click thật copy đúng ba payload, hiện `Copied`, không alert lỗi.
- Click liên tiếp: timer reset; sau khoảng 1200 ms trở về `Copy`; click không bubble lên parent.
- Clipboard denial giả lập: báo lỗi và không hiển thị success.
- Promise hoàn tất sau unmount: không báo lỗi/state feedback muộn; remount trở về trạng thái sạch.
- Terminal live indicator vẫn hiện; không browser page error.
- Screenshot local: `.jeikcode/browser-smoke/copy-smoke.png`.

JavaScript `.click()` không cung cấp user gesture nên lần thử clipboard đầu bị browser từ chối; success được xác minh lại bằng click thật của automation. Đây là smoke test component trong browser, **không phải** full application E2E với provider/backend hoặc cross-browser certification.

## Các bước kế tiếp đề xuất

1. Review ba commit local và quyết định push; nếu cần phát hành, thực hiện checklist changelog/README/version/tag chính thức trong nhiệm vụ riêng, không coi cleanup là phát hành.
2. Ưu tiên CI portability: chạy regression Unix/symlink và feature matrix trên Linux/macOS, test Windows UNC thật khi có share, kiểm tra quoted argv theo shell. Windows alias fallback hiện là ASCII case-fold; không tuyên bố hỗ trợ mọi filesystem Unicode/case mode.
3. Chốt contract prefix: bảo vệ compaction khác byte immutability; hot-reload đổi block hiện hành cần quyết định explicit cache invalidation so với append-only update. Không tự chọn qua thay đổi code.
4. Chốt nguồn sở hữu `site/`/`docs-site/` và frontend lockfile; sau đó mới archive nguồn cũ. Không xóa `verify-jetbrains-approval` trước khi xác minh file duy nhất.
5. Refactor WebUI nhỏ tiếp theo: full-stack dev proxy có auth/WebSocket đúng, hoặc tách Chat search và CSS; đo bundle trước khi code-split. TUI/runtime lớn triển khai theo lát riêng, không gộp với refactor state machine.
