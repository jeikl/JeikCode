# Báo cáo dọn dẹp và kiểm chứng — 2026-10-07

> Báo cáo này ghi trạng thái của đợt đầu. Kết quả đồng bộ upstream, sửa 16 lỗi nền và kiểm chứng không skip ở đợt tiếp theo: [cleanup-continuation-2026-10-07.md](cleanup-continuation-2026-10-07.md).

## Phạm vi và trạng thái

- Baseline: local `main`, commit `20d0f2a3a`; tại lúc kiểm tra chậm hơn `origin/main` 5 commit. Không fetch, merge, rebase, commit, push hoặc phát hành.
- Không xóa worktree, source, session, memory, rewind hoặc thay đổi chưa commit.
- Chỉ dọn hai cache Cargo `target/` trong worktree bằng `cargo clean --target-dir`.
- Diff chưa commit của worktree `daemon-approval-timeout` giữ nguyên fingerprint Git blob `2da3d2d95c14479e868525c8f8a64bc3c6d0096f`.
- `chat-user-input-correlation` vẫn sạch; hai nhánh worktree vẫn được giữ.

## Những thay đổi đã thực hiện

1. **Dung lượng**: Cargo báo đã xóa 5,2 GiB + 10,3 GiB cache. Sau toàn bộ kiểm thử, ổ C tăng từ khoảng 20,75 GiB lên 33,80 GiB trống, tức tăng ròng khoảng 13,05 GiB. `target/` mới cho kiểm thử khoảng 3,16 GiB được giữ để tái sử dụng. Dung lượng ổ đĩa có thể thay đổi theo tiến trình khác.
2. **Tài liệu hiện hành**: cập nhật architecture/target-architecture theo Driver → CodingRuntime → kernel; mô tả đúng persistence và legacy importer. Ghi lại mâu thuẫn append-only/hot-reload mà không đổi quy tắc hoặc hành vi.
3. **WebUI**: sửa hướng dẫn bundle generated, build trước Rust và giới hạn dev redirect. Vite hiện không có API proxy; redirect đơn lẻ chưa tạo môi trường full-stack HMR hoạt động.
4. **Phát hành**: `scripts/release.sh` và `scripts/release-self-update.sh` trở thành stub fail-fast, exit 1 trước mọi thao tác; chỉ dẫn pipeline main/tag và tutorial chính thức. Cập nhật onboarding, Docker consumers, installer messaging và nguồn release notes trong teaches.
5. **Build theo máy**: bỏ linker/ar tuyệt đối `E:/...`, giữ đúng target-scoped flags. Script daemon local khai báo musl linker; không publish hoặc ghi manifest. Hướng dẫn cấu hình toolchain tương ứng được bổ sung vào teaches.
6. **Mã thừa**: bỏ wrapper private không gọi trong repair, helper discovery private không gọi trong index, helper pipe streaming private không gọi trong Bash. Giữ các đường xử lý đang dùng.
7. **Dependency trực tiếp**: bỏ `chrono` của coding, `futures` của telemetry và `serde` của desktop; giữ dependency gián tiếp và `serde_json`. Cargo cập nhật lockfiles. Version package desktop trong lockfile được đồng bộ từ 7.1.45 sang version manifest sẵn có 7.1.52, không phải bump phát hành mới.
8. **WebUI nhỏ**: dọn selector CSS không dùng, tách copy feedback thành controller/hook dùng chung cho ba component. Có cancellation timer, chống kết quả async sau unmount/reset và chống kết quả cũ ghi đè kết quả mới.
9. **Hướng dẫn an toàn**: teaches không còn mô tả xóa rewind/logs như cache vô hại; nêu rõ mất khả năng phục hồi/chẩn đoán.

**Lưu ý tên package**: Cargo package ở `crates/jeikcode-cli` là `jeikcode`, không phải `jeikcode-cli`. Lệnh helper giữ `-p jeikcode`; chỉ tên thư mục không đủ để kết luận lệnh cũ sai.

## Kết quả kiểm chứng

| Kiểm tra | Kết quả |
|---|---|
| `npm test` trong webui | 300 đạt, 0 lỗi |
| `npm run typecheck` | Đạt |
| `npm run build` | Đạt; còn cảnh báo chunk > 500 kB |
| `cargo check --workspace --locked --offline` | Đạt |
| Desktop `cargo check --manifest-path desktop/src-tauri/Cargo.toml --locked --offline` | Đạt sau khi dependency Tauri thiếu được tải ở lần kiểm tra online trước |
| Repair tests serial | 64 đạt |
| Bash tests serial | 67 đạt |
| Capabilities serial, loại rõ 9 lỗi baseline | 991 đạt, 9 filtered out |
| Coding serial, loại rõ 3 lỗi baseline | 361 đạt, 8 ignored có sẵn, 3 filtered out |
| Telemetry serial, loại rõ 4 lỗi baseline | 74 đạt, 4 filtered out |
| Bash syntax và PowerShell parsing | Đạt |
| Hai script retired chạy smoke test | Cùng exit 1, thông báo tutorial; không phát hành |
| `git diff --check` | Đạt |
| `cargo fmt --all -- --check` | Không đạt do khác biệt có sẵn; không format ngoài phạm vi |

Kiểm tra Rust sử dụng profile không có debug symbols/incremental để hạn chế cache. Workspace check đặt `JEIKCODE_HOME` cách ly để `build.rs` không đồng bộ asset cá nhân vào source. Unit tests bỏ biến này để constructor test harness tự cách ly home; đường dẫn chứa `.jeikcode` từng làm sai tiền đề của test credential.

### Lỗi baseline đã đối chiếu bằng thực thi

Không có tuyên bố toàn bộ suite Rust đã xanh. Các lỗi dưới đây được chạy ở cả binary hiện tại và source xuất sạch từ `HEAD`; lỗi tái hiện giống nhau. Việc filtered out chỉ dùng để kiểm tra phần còn lại, không sửa hoặc ẩn lỗi trong source/CI.

**Capabilities — 9 lỗi:**

- `codeintel::index::tests::scoped_get_ignores_dirty_files_outside_focus`
- `codeintel::index::tests::scoped_query_skips_full_walk_when_focus_already_indexed`
- `codeintel::index::tests::test_quick_update_single_file_and_caching`
- `codeintel::repo_map::tests::test_default_mode_is_tree`
- `codeintel::repo_map::tests::test_tree_mode_recurses_subdirs_and_counts_deep_files`
- `codeintel::repo_map::tests::test_tree_mode_skips_symbols_and_is_complete`
- `process_utils::tests::python3_shim_runs_real_cpython`
- `tools::edit::tests::stringified_edits_truncated_new_string_is_rejected`
- `tools::todo::tests::hybrid_truncated_actions_string_plus_sibling_fields_is_applied`

**Coding — 3 lỗi:**

- `runtime::tests::required_source_build_gateway_gap_remains_startup_error`
- `runtime::tests::source_build_gateway_gap_starts_awaiting_provider_and_can_switch`
- `runtime::tests::native_turn_steers_and_finishes_only_after_real_snapshot`

**Telemetry — 4 lỗi:**

- `config::tests::default_is_enabled`
- `config::tests::env_wins_over_config`
- `repo_origin::tests::classify_hosts`
- `runtime::resolve_host_tests::parses_host_from_full_url`

Coding có fixture gateway URL rỗng không khớp điều kiện mock factory, và assertion steer chưa khớp nội dung đã wrap. Telemetry có mismatch giữa default/endpoint/reason và assertion, cùng classifier/host expectation đáng rà lại. Đây là đầu mối điều tra, chưa phải quyết định sửa contract sản phẩm.

Formatting của Bash trên HEAD có đúng năm đoạn lệch như file hiện tại, chỉ dịch 31 dòng do helper bị xóa. Giữ nguyên các đoạn ngoài phạm vi. Log kiểm chứng nằm trong `.jeikcode/cleanup-*.log` (không tracked).

## Giới hạn và các mục chưa triển khai

- Chưa smoke test GUI/clipboard trong trình duyệt thật hoặc build Docker image/cross-platform release.
- Không thay runtime hot-reload, sacred floor hoặc thêm lifecycle owner.
- Không hợp nhất `site/` và `docs-site/`, không thay chính sách lockfile frontend toàn dự án.
- Không refactor Chat search, runtime lớn hoặc TUI event/render trong cùng đợt.
- Không thay cơ chế sync asset của build.rs; chỉ cách ly home khi kiểm chứng.
- Không xóa thư mục `verify-jetbrains-approval`: chưa xác nhận nội dung duy nhất đã được bảo vệ.

## Bước tiếp theo đề xuất

1. Review diff và lưu thành commit cleanup độc lập trước khi đồng bộ 5 commit upstream; xử lý xung đột rồi kiểm chứng lại. Commit phải có trailer `Co-Authored-By: JeikCode <code@jeikcode.top>`.
2. Ưu tiên sửa 16 lỗi baseline theo nhóm: CodeIntel Windows/path/cache, Python shim môi trường, parser edit/todo, fixture/steer coding, telemetry contract. Không cập nhật assertion đơn thuần trước khi xác định hành vi đúng.
3. Smoke test ba nút copy ở browser: success, failure, click liên tiếp và đổi/unmount component. Kiểm tra diff/terminal rendering và indicator live vẫn còn.
4. Chốt contract append-only/hot-reload trước khi sửa prefix; phân biệt bảo vệ compaction với bất biến byte và cache invalidation.
5. Chốt vai trò website/lockfile frontend, rồi tách Chat search/CSS theo component thành các đợt nhỏ có test. Không đưa toàn bộ refactor TUI/runtime vào một commit.
