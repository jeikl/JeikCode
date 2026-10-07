# CI kiểm tra tính khả chuyển

Workflow `.github/workflows/portability.yml` độc lập với quy trình phát hành: chạy cho PR vào `main`, push vào `main` và `workflow_dispatch`; không chạy theo tag, không tạo release, không dùng secrets và checkout không lưu credentials. Không sửa `build.yml` hay `release.yml`.

## Phạm vi và giới hạn

- Native: `windows-latest`, `ubuntu-latest`, `macos-latest`, Rust stable, Python 3.11, Node 22; mỗi job tối đa 60 phút, matrix không fail-fast.
- Mỗi native job dùng `npm ci` từ `webui/package-lock.json` và build WebUI trước `cargo check --workspace --locked` vì daemon nhúng `webui/dist` khi biên dịch.
- Capabilities mặc định chỉ bật `provider,tools`. Lần test riêng thêm `codeintel`; lần test chung với coding và telemetry bật thêm các capability mà coding dùng trong production qua feature unification. Cả hai chạy library tests tuần tự (`--test-threads=1`). Không tuyên bố đây là toàn bộ integration/E2E suite.
- Job Ubuntu riêng kiểm tra và test library của capabilities với từng cấu hình: không có optional feature (gọi là `core`), `tools`, `codeintel`, `provider`, `session`, `mcp`. Mỗi cấu hình là một lệnh Cargo riêng, không chọn workspace/coding để tránh feature unification che lỗi dependency. `--all-features` chỉ **check library**, không chạy E2E cần API key hoặc build mọi example/binary.
- Một job Ubuntu chạy WebUI test, typecheck, build; timeout 45 phút. Native jobs chỉ build WebUI làm đầu vào nhúng, không lặp lại bộ test frontend.
- `Portability gate` luôn chạy và chỉ thành công nếu **mọi** job cần thiết thành công; failed, skipped hoặc cancelled không được coi là pass. Không có `continue-on-error`. Có thể chọn gate này trong branch protection; workflow không tự cấu hình branch protection.

## Cách ly và công cụ

Cần Rust stable/Cargo, linker và C/C++ compiler bản địa (MSVC Build Tools trên Windows, Xcode Command Line Tools trên macOS, build-essential trên Linux), Git, Bash, Python 3.11 và Node 22/npm. Dùng Node 22 bản mới nhất (Vite 8 yêu cầu ít nhất 20.19). Trên Windows dùng Git Bash; đưa `C:/Program Files/Git/bin` vào PATH của tiến trình con để Python wrapper và cơ chế `find_shell` tìm được Bash. Không cần clipboard thật hay API key; không cài desktop/WebKit vì không build desktop.

Không đặt `JEIKCODE_HOME` chung cho job test và không cache/upload test home: constructor của test binary tự tạo home tạm riêng. Riêng **workspace check** đặt `JEIKCODE_HOME` tới đường dẫn chưa tồn tại dưới `runner.temp`, kiểm tra không tồn tại cả trước và sau lệnh. Không `mkdir` đường dẫn này: `crates/jeikcode-cli/build.rs` sẽ bỏ qua đồng bộ tài sản người dùng khi home không phải thư mục. Đây không phải một biến `skip_cli` mới và không bỏ qua CLI trong workspace check.

Cargo cache chỉ phục vụ dependency/build artifacts; `CARGO_INCREMENTAL=0`, debug info của dev/test bằng 0. Log dùng Bash `set -euo pipefail` và `tee`, nên lỗi Cargo/npm vẫn làm step thất bại. Artifact `always()` chỉ lấy `portability-logs/*.log`, giữ 7 ngày; không upload source, temp home, credential files hay toàn bộ `runner.temp`, không dump môi trường.

## Tái hiện cục bộ (Bash, tại root repo)

Các lệnh dưới đây tương ứng với CI, không phải báo cáo rằng đã chạy toàn bộ suite trên máy hiện tại:

```bash
set -euo pipefail
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_TERM_COLOR=never
# Test constructors quản lý home riêng; không kế thừa home người dùng.
unset JEIKCODE_HOME

(cd webui && npm ci && npm run build)
# mktemp tạo parent riêng; KHÔNG tạo child home dùng cho build script.
build_parent=$(mktemp -d)
test ! -e "$build_parent/home-not-created"
JEIKCODE_HOME="$build_parent/home-not-created" cargo check --workspace --locked
test ! -e "$build_parent/home-not-created"
rmdir "$build_parent"

cargo test -p jeikcode-capabilities --locked --features codeintel --lib -- --test-threads=1
cargo test -p jeikcode-capabilities -p jeikcode-coding -p jeikcode-telemetry --locked --lib -- --test-threads=1

for feature in core tools codeintel provider session mcp; do
  args=()
  if [[ "$feature" != core ]]; then args=(--features "$feature"); fi
  cargo check -p jeikcode-capabilities --locked --lib --no-default-features "${args[@]}"
  cargo test -p jeikcode-capabilities --locked --lib --no-default-features "${args[@]}" -- --test-threads=1
done
cargo check -p jeikcode-capabilities --locked --lib --all-features

(cd webui && npm ci && npm test && npm run typecheck && npm run build)
```

Nếu muốn lưu log cục bộ, thêm `2>&1 | tee <file.log>` với `pipefail` như workflow; chỉ chia sẻ log kiểm chứng, không chia sẻ home cấu hình.

## UNC thật: kiểm chứng opt-in trên Windows

CI hosted không tự có SMB share được cấp quyền. Test lexical UNC prefix và fixture local không thay thế việc kiểm chứng UNC thật. Chỉ chạy lệnh dưới đây khi người duy trì đã cung cấp một **thư mục UNC tồn tại, có quyền ghi**:

```bash
export JEIKCODE_TEST_UNC_ROOT='//server/share/jeikcode-test-root'
cargo test -p jeikcode-capabilities --locked --no-default-features --lib \
  pathnorm::tests::codeintel_windows_real_unc_alias_identity \
  -- --ignored --exact --test-threads=1
unset JEIKCODE_TEST_UNC_ROOT
```

Test tạo một thư mục con duy nhất bằng `TempDir` và tự dọn thư mục con; không tạo/xóa share hoặc root được cung cấp, không sửa credential và không tự cấu hình SMB. Khi chạy explicit mà thiếu biến môi trường, root không phải UNC hoặc không có quyền ghi, test thất bại thay vì im lặng pass. Test này chỉ kiểm chứng identity UNC/verbatim/update/delete; graph và SQLite alias được phủ bằng fixture native riêng. Không chạy `--ignored` toàn bộ suite vì có thể bật các test khác cần hạ tầng riêng.

## Trạng thái chạy từ xa

Thêm workflow vào working tree **không** chạy GitHub Actions. Chưa có kết quả Windows/Linux/macOS từ xa chỉ vì file đã được tạo hoặc kiểm tra cú pháp cục bộ. Sau khi người duy trì push workflow lên GitHub, sự kiện PR/push phù hợp mới chạy; manual dispatch cần workflow hiện diện trên default branch. Việc tạo workflow không tự push, dispatch hoặc điều phối build phát hành. Commit local và trạng thái kiểm chứng được ghi riêng trong báo cáo bàn giao. Kết quả từ xa phải được xác nhận qua từng job và `Portability gate` trong Actions sau đó.
