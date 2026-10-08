use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn vi(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::WelcomeBannerLine1 =>
            "Chào mừng đến với JeikCode. Chọn một mục để bắt đầu:".into(),
        Msg::WelcomeBannerLine2 =>
            "(↑↓ để di chuyển, Enter để xác nhận, Esc để bỏ qua)".into(),
        Msg::WelcomeOptionConfigureManually => "Cấu hình thủ công".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "Khóa API".into(),
        Msg::WelcomeOptionSkip => "Tạm bỏ qua".into(),
        Msg::WelcomeOptionSkipHint => "khám phá trước".into(),


        Msg::ErrUnsupportedLocale { input } =>
            format!("ngôn ngữ không được hỗ trợ: {input}").into(),

        Msg::StatusNoProvider =>
            "chưa có nhà cung cấp · /provider để cấu hình".into(),
        Msg::StatusRuntimeUnavailable =>
            "môi trường thực thi không khả dụng · khởi động lại hoặc xem lỗi phía trên".into(),
        Msg::StatusOfficialBuildRequired =>
            "Bản dựng này không hỗ trợ ký yêu cầu qua cổng JeikCode — dùng /provider".into(),
        Msg::StatusUpgradeHint { version } =>
            format!("↑ Có phiên bản {version} · /upgrade").into(),
        Msg::StatusUpgradeHintPm { version } =>
            format!("↑ Có phiên bản {version} · brew upgrade jeikcode").into(),
        Msg::StatusModelNotConfigured =>
            "(chưa cấu hình)".into(),
        Msg::StatusClipboardImageHint =>
            "Có ảnh trong bộ nhớ tạm · alt+v / ctrl+alt+v để dán".into(),
        Msg::StatusClipboardImageHintSlash =>
            "Có ảnh trong bộ nhớ tạm · alt+v / ctrl+alt+v / /paste".into(),
        Msg::StatusWebuiHint =>
            "Mẹo: Dùng /webui để mở JeikCode trong trình duyệt".into(),

        Msg::StatusBody { model, dir, config } =>
            format!(
                "  Mô hình: {}\n  Thư mục: {}\n  Cấu hình: {}\n",
                model, dir, config,
            ).into(),
        Msg::StatusInstructionFilesHeader =>
            "  Tệp chỉ dẫn:\n".into(),
        Msg::StatusInstructionScopeGlobal => "Người dùng toàn cục".into(),
        Msg::StatusInstructionScopeProject => "Dùng chung trong dự án".into(),
        Msg::StatusInstructionScopeUser => "Ghi đè riêng của người dùng cho dự án".into(),
        Msg::StatusInstructionPresent { path, label, scope } =>
            format!("    ✓ {scope} ({label}): {path}\n").into(),
        Msg::StatusInstructionMissing { path, label, scope } =>
            format!("    × {scope} ({label}): {path} — không tìm thấy\n").into(),
        Msg::StatusMemoryFilesHeader => "  Tệp bộ nhớ:\n".into(),
        Msg::StatusMemoryScopeGlobal => "Người dùng toàn cục".into(),
        Msg::StatusMemoryScopeProject => "Bộ nhớ dự án".into(),
        Msg::StatusMemoryPresent { path, scope } =>
            format!("    ✓ {scope}: {path}\n").into(),
        Msg::StatusMemoryMissing { path, scope } =>
            format!("    × {scope}: {path} — không tìm thấy\n").into(),

        Msg::HelpAvailableCommands =>
            "  Các lệnh khả dụng:\n".into(),
        Msg::KeybindingsHelp => r#"  Phím tắt

  ── Nhập liệu ──
    Enter                            Gửi tin nhắn
    \ rồi Enter                     Xuống dòng (mọi terminal)
    Shift / Alt / Ctrl+Enter         Xuống dòng *
    Ctrl+J                           Xuống dòng *
    /                                Mở danh sách lệnh dấu gạch chéo
    Tab                              Chấp nhận gợi ý lệnh hoặc tệp
    Backspace / Ctrl+H               Xóa ký tự trước
    Delete / Ctrl+?                  Xóa ký tự sau
    Ctrl+W                           Xóa từ phía trước
    Ctrl+U                           Xóa dòng hiện tại
    Ctrl+K                           Xóa tới cuối dòng
    Ctrl+A / Home                    Về đầu dòng
    Ctrl+E / End                     Tới cuối dòng
    Left / Right                     Di chuyển con trỏ

  ── Lịch sử ──
    Up / Down                        Nội dung nhập trước / sau
    Ctrl+R                           Tìm ngược; nhấn lại để tìm kết quả cũ hơn
    Right                            Chấp nhận gợi ý câu lệnh tiếp (không gửi)

  ── Chế độ và mô hình ──
    Tab / Shift+Tab                  Khi không mở menu, đổi chế độ tiếp / trước
    F2 / Shift+F2                    Mô hình tiếp / trước (Mac: Fn+F2 / Fn+Shift+F2)
    Ctrl+T                           Chuyển reasoning_effort

  ── Xem đầu ra ──
    Shift+Up / Shift+Down            Cuộn lên / xuống một dòng
    PageUp / PageDown                Cuộn lên / xuống 10 dòng
    Alt+Up / Alt+Down                Tới tin nhắn trước / sau
    Ctrl+Up / Ctrl+Down              Tới tin nhắn người dùng trước / sau
    Home / End                       Khi ô nhập trống, tới đầu / cuối
    Lăn chuột                        Cuộn vùng trò chuyện
    Kéo chuột                        Chọn văn bản
    Shift+kéo chuột                  Dùng chọn văn bản gốc của terminal
    Ctrl+Shift+C                     Sao chép vùng chọn JeikCode

  ── Điều khiển ──
    Esc                              Xóa nội dung nhập / đóng hộp thoại / hủy
    Esc Esc                          Hoàn tác lượt trước khi nhàn rỗi và ô nhập trống
    Ctrl+C                           Hủy; nhấn lại khi nhàn rỗi để thoát
    Ctrl+O                           Bật/tắt đầu ra công cụ thời gian thực
    Ctrl+V / Ctrl+Alt+V              Dán văn bản hoặc ảnh **

  ── Điều hướng menu / hộp thoại ──
    Up / Down                        Di chuyển lựa chọn
    Enter                            Xác nhận
    Esc                              Hủy / đóng hộp thoại
    Tab                              Chèn lệnh đang chọn
    1..9                             Chọn phương án phê duyệt / câu hỏi
    y / a / n                        Phê duyệt: một lần / luôn / từ chối

  * Enter kèm phím bổ trợ cần terminal phân biệt được phím bổ trợ.
    Đã biết có hỗ trợ: Kitty / WezTerm / iTerm2 (bật Report Modifiers)
    / Windows Terminal / Ghostty / Warp. Các terminal khác
    (macOS Apple Terminal, xterm mặc định, GNOME Terminal, terminal
    tích hợp VS Code) coi Shift+Enter như Enter — dùng \ + Enter.
  ** Ctrl+Alt+V là cách thay thế khi terminal chặn Ctrl+V;
     Ctrl+Shift+V vẫn là phím dán văn bản thuần của terminal.

  Mẹo: chạy /help để xem đầy đủ danh sách lệnh.
"#.into(),

        Msg::ProviderWizardHeader =>
            "  Quản lý nhà cung cấp: thêm, sửa, xóa hoặc đặt mặc định toàn cục. Nhấn Esc để hủy.\n".into(),
        Msg::ProviderWizardCancelled =>
            "(đã hủy)".into(),
        Msg::ProviderMenuAdd => "Thêm".into(),
        Msg::ProviderMenuAddDesc => "Tạo cấu hình nhà cung cấp".into(),
        Msg::ProviderMenuEdit => "Sửa".into(),
        Msg::ProviderMenuEditDesc => "Sửa cấu hình nhà cung cấp hiện có".into(),
        Msg::ProviderMenuDelete => "Xóa".into(),
        Msg::ProviderMenuDeleteDesc => "Xóa cấu hình nhà cung cấp hiện có".into(),
        Msg::ProviderMenuSetDefault => "Đặt mặc định toàn cục".into(),
        Msg::ProviderMenuSetDefaultDesc =>
            "Đặt nhà cung cấp mặc định và chuyển phiên này".into(),
        Msg::ProviderImportPrompt =>
            "Dán mẫu để tự nhận dạng (curl / JSON / TOML), hoặc Enter để nhập thủ công:".into(),
        Msg::ProviderImportParsed { base_url, type_name, model } =>
            format!("Đã nhận dạng: {base_url} · {type_name} · {model}").into(),
        Msg::ProviderImportFailed =>
            "Không nhận ra mẫu. Dán curl / JSON / TOML, hoặc Enter để nhập thủ công.".into(),
        Msg::ProviderNoProviders =>
            "Chưa cấu hình nhà cung cấp nào.".into(),
        Msg::ProviderDeleteConfirm { name } =>
            format!("Xóa \"{name}\"? [y/N]").into(),
        Msg::ProviderDeleted { name } =>
            format!("Đã xóa \"{name}\".").into(),
        Msg::ProviderDeleteKept => "(đã giữ lại)".into(),
        Msg::ProviderDefaultSet { name } =>
            format!("Đã đặt mặc định thành {name}.").into(),
        Msg::ProviderAdded { name } =>
            format!("Đã thêm tài khoản \"{name}\" và mở danh sách mô hình; nhấn Ctrl+A để thêm mô hình.").into(),
        Msg::ProviderUpdated { name } =>
            format!("Đã cập nhật \"{name}\".").into(),
        Msg::ProviderStepName => "Tên nhà cung cấp?".into(),
        Msg::ProviderStepType => "Loại? (openai / claude / ollama)".into(),
        Msg::ProviderStepTypeWithHint { current } =>
            format!("Loại? [{current}] (openai / claude / ollama, để trống để giữ nguyên)").into(),
        Msg::ProviderStepBaseUrl =>
            "URL gốc? (ví dụ https://api.deepseek.com/v1)".into(),
        Msg::ProviderStepBaseUrlWithHint { current } =>
            format!("URL gốc? [{current}] (để trống để giữ nguyên)").into(),
        Msg::ProviderDefaultHint => "mặc định của nhà cung cấp".into(),
        Msg::ProviderStepApiKey =>
            "Khóa API? (để trống nếu chưa đặt)".into(),
        Msg::ProviderStepApiKeyWithHint { hint } =>
            format!("Khóa API? [{hint}]").into(),
        Msg::ProviderStepApiKeySet => "đã đặt — để trống để giữ nguyên".into(),
        Msg::ProviderStepApiKeyUnset => "chưa đặt".into(),
        Msg::ProviderStepModel => "Mô hình?".into(),
        Msg::ProviderStepModelWithHint { current } =>
            format!("Mô hình? [{current}] (để trống để giữ nguyên)").into(),
        Msg::ProviderStepContextWindow { default } =>
            format!("Cửa sổ ngữ cảnh? [{default}] token (để trống để dùng mặc định; ví dụ 128000 / 256000 / 512000 / 1000000, hoặc 128k / 1m)").into(),
        Msg::ProviderStepContextWindowWithHint { current } =>
            format!("Cửa sổ ngữ cảnh? [{current}] token (để trống để giữ nguyên; ví dụ 128000 / 256000 / 512000 / 1000000, hoặc 128k / 1m)").into(),
        Msg::ProviderContextWindowInvalid =>
            "Cửa sổ ngữ cảnh phải là số token dương, ví dụ 128000 hoặc 128k.".into(),
        Msg::ProviderStepPricing =>
            "Giá USD cho 1M token? input,output,cached-input (để trống = chưa biết/giữ nguyên; `clear` để xóa; ví dụ 2.5,10,0.25; miễn phí = 0,0,0)".into(),
        Msg::ProviderStepPricingWithHint { current } =>
            format!("Giá USD cho 1M token? [{current}] (để trống để giữ nguyên; `clear` để xóa)").into(),
        Msg::ProviderPricingInvalid =>
            "Giá phải gồm ba số hữu hạn không âm: input,output,cached-input.".into(),
        Msg::ProviderNameEmpty => "Tên không được để trống.".into(),
        Msg::ProviderBaseUrlEmpty => "URL gốc không được để trống.".into(),
        Msg::ProviderUnknownType =>
            "Loại không xác định. Chọn openai / claude / ollama.".into(),
        Msg::ProviderUnknownTypeEdit =>
            "Loại không xác định. Chọn openai / claude / ollama hoặc để trống.".into(),
        Msg::ProviderModelEmpty => "Mô hình không được để trống.".into(),
        Msg::ProviderEditKeep => "(giữ nguyên)".into(),
        Msg::ProviderTypeInferred { type_name } =>
            format!("Loại đã nhận dạng: {type_name}").into(),
        Msg::ProviderStepNameDefault { default } =>
            format!("Tên nhà cung cấp? [{default}] (để trống để dùng tên này)").into(),
        Msg::ProviderStepProgress { current, total } =>
            format!("({current}/{total})").into(),

        Msg::ProviderPanelTabAccounts => "Tài khoản".into(),
        Msg::ProviderPanelTabModels => "Mô hình".into(),
        Msg::ProviderPanelEmptyAccounts =>
            "(Chưa có tài khoản nhà cung cấp — nhấn Ctrl+A để thêm)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(Không có tài khoản nhà cung cấp phù hợp)".into(),
        Msg::ProviderPanelEmptyModels =>
            "(Chưa có mô hình — nhấn Ctrl+A để thêm; lấy danh sách /models từ nhà cung cấp)".into(),
        Msg::ProviderPanelNoMatchingModels => "(Không có mô hình phù hợp)".into(),
        Msg::ProviderPanelLegacyBadge => "kiểu cũ".into(),
        Msg::ProviderPanelDefaultBadge => "mặc định".into(),
        Msg::ProviderPanelModelCount { count } =>
            format!("{count} mô hình{}", if count == 1 { "" } else { "" }).into(),
        Msg::ProviderPanelAddModelRow => "+ Thêm mô hình".into(),
        Msg::ProviderPanelAccountsHint =>
            "Lọc · ↑↓ chọn · ↵ mô hình · Ctrl+A thêm · Ctrl+E sửa · Ctrl+Dx2 xóa · Tab chuyển · Esc đóng".into(),
        Msg::ProviderPanelModelsHint =>
            "Lọc · ↑↓ chọn · ↵ mặc định/thêm · Ctrl+A thêm + lấy danh sách từ nhà cung cấp · Ctrl+E sửa · Ctrl+Dx2 xóa · Tab chuyển · Esc đóng".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ chọn · ↵ mặc định/thêm · Ctrl+A thêm + lấy danh sách từ nhà cung cấp · Ctrl+E sửa · Ctrl+Dx2 xóa · Tab tất cả · Esc đóng").into(),
        Msg::ProviderPanelModelSaved { model } => format!("Đã lưu mô hình \"{model}\".").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "Ảnh được gửi đến mô hình này; tắt đầu vào ảnh để dùng VL.".into()
        }
        Msg::ProviderPanelAddTitle => "[Thêm tài khoản nhà cung cấp]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[Sửa tài khoản {account}]").into(),
        Msg::ProviderPanelAddModelTitle => "[Thêm mô hình]".into(),
        Msg::ProviderPanelEditModelTitle => "[Sửa mô hình]".into(),
        Msg::ProviderPanelFieldVendor => "Nhà cung cấp".into(),
        Msg::ProviderPanelFieldAccount => "Tài khoản".into(),
        Msg::ProviderPanelFieldBaseUrl => "URL gốc".into(),
        Msg::ProviderPanelFieldApiKey => "Khóa API".into(),
        Msg::ProviderPanelFieldModel => "Mô hình".into(),
        Msg::ProviderPanelFieldWindow => "Cửa sổ ngữ cảnh".into(),
        Msg::ProviderPanelFieldSupportsVision => "Hỗ trợ đầu vào ảnh?".into(),
        Msg::ProviderPanelVisionYes => "Có [✓]  (gửi ảnh base64)".into(),
        Msg::ProviderPanelVisionNo => "Không [ ]  (chỉ văn bản)".into(),
        Msg::ProviderPanelFieldReasoningModel => "Mô hình suy luận?".into(),
        Msg::ProviderPanelReasoningYes => "Có [✓]  (hiển thị suy luận trong lịch sử)".into(),
        Msg::ProviderPanelReasoningNo => "Không [ ]  (thông thường / không hiển thị suy luận)".into(),
        Msg::ProviderPanelFieldMakeDefault => "Đặt làm mặc định".into(),
        Msg::ProviderPanelSwitchHint => "←→ để chuyển".into(),
        Msg::ProviderPanelEnvHint { env } => format!("để trống để dùng ${env}").into(),
        Msg::ProviderPanelDefaultValue => "mặc định".into(),
        Msg::ProviderPanelKeepOriginal => "để trống để giữ giá trị hiện tại".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab Tiếp  ←→ Đổi nhà cung cấp  Space Bật/tắt  ↵ Lưu  Esc Quay lại".into(),
        Msg::ProviderPanelAccountFormHint => "Tab Chuyển  ↵ Lưu  Esc Quay lại".into(),
        Msg::ProviderPanelModelFormHint =>
            "Mở danh sách từ nhà cung cấp  Gõ để lọc  ↑↓ chọn  Tab/↵ điền  ←→ tài khoản (mô hình trống)  Space bật/tắt  Esc quay lại".into(),
        Msg::ProviderPanelModelPlaceholder => "(gõ để lọc danh sách từ nhà cung cấp)".into(),
        Msg::ProviderPanelUpstreamListLabel => "Mô hình từ nhà cung cấp".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ chọn · Tab/↵ điền".into(),
        Msg::ProviderPanelUpstreamLoading => "đang tải…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("Đã tải {n} mô hình từ nhà cung cấp · gõ để lọc · ↑↓ chọn · Tab/↵ điền").into(),
        Msg::ProviderPanelUpstreamEmpty =>
            "Danh mục của nhà cung cấp trống — nhập mã mô hình".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("Không lấy được danh sách từ nhà cung cấp ({error}) — nhập mã mô hình").into(),
        Msg::ProviderPanelUpstreamNoUrl =>
            "Chưa có URL nhà cung cấp — nhập mã mô hình".into(),

        Msg::ModelSwitched { provider, model } =>
            format!("  Đã chuyển sang {provider} · {model} cho phiên này\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  Đã chuyển sang {provider} · {model}; đặt làm mặc định cho phiên mới\n").into(),

        Msg::SessionLoadFailed { error } =>
            format!("không tải được phiên: {error}").into(),
        Msg::SessionResumedLabel { name } =>
            format!("đã tiếp tục: {name}").into(),
        Msg::SessionBusyForked { source_id, fork_id } =>
            format!(
                "Phiên gần nhất ({source_id}) đang hoạt động ở cửa sổ khác. Đã tạo nhánh độc lập ({fork_id}) từ trạng thái được lưu cuối cùng."
            ).into(),

        Msg::TodoPanelTitle => "Việc cần làm".into(),
        Msg::TodoPanelCompleted { n } => format!("đã hoàn thành {n}").into(),
        Msg::TodoPanelMore { n } => format!("+{n} mục nữa…").into(),

        Msg::ApprovalAllowOnce => "Cho phép một lần".into(),
        Msg::ApprovalAlwaysAllow { tool } => format!("Luôn cho phép {tool} (trong phiên này)").into(),
        Msg::ApprovalAlwaysAllowFolder => {
            "Luôn cho phép ghi vào thư mục này (trong phiên này)".into()
        }
        Msg::ApprovalAlwaysAllowCommand => "Luôn cho phép lệnh này (trong phiên này)".into(),
        Msg::ApprovalDeny => "Từ chối".into(),
        Msg::ApprovalHint => "↑↓ chọn · Enter xác nhận · Esc hủy".into(),
        Msg::ApprovalHeader { tool, detail } => {
            if detail.is_empty() {
                format!("Cho phép {tool}?").into()
            } else {
                format!("Cho phép {tool}({detail})?").into()
            }
        }
        Msg::ToolDenied => "đã từ chối".into(),

        Msg::CmdSwitchedAutoMode => "  Đã chuyển sang chế độ tự động (tự phê duyệt mọi công cụ).\n".into(),
        Msg::CmdSwitchedAcceptEditsMode => {
            "  Đã chuyển sang chế độ accept-edits (tự phê duyệt sửa tệp; bash vẫn yêu cầu xác nhận).\n".into()
        }

        Msg::SessionTimeJustNow => "vừa xong".into(),
        Msg::SessionTimeMinAgo { n } => format!("{n} phút trước").into(),
        Msg::SessionTimeHourAgo { n } => format!("{n} giờ trước").into(),
        Msg::SessionTimeDayAgo { n } => format!("{n} ngày trước").into(),
        Msg::SessionMsgCount { count } =>
            format!("{count} tin nhắn").into(),
        Msg::SessionNameEmpty =>
            "Tên phiên không được để trống".into(),
        Msg::SessionNameTooLong { max } =>
            format!("Tên phiên quá dài (tối đa {max} ký tự)").into(),
        Msg::SessionNameControlChars =>
            "Tên phiên không được chứa ký tự điều khiển".into(),
        Msg::SessionListFailed { error } =>
            format!("không liệt kê được phiên: {error}").into(),
        Msg::SessionRenamed { old, new } =>
            format!("  Đã đổi tên: '{old}' -> '{new}'").into(),
        Msg::SessionSaveFailed { error } =>
            format!("Không lưu được phiên: {error}. Tên chưa được lưu.").into(),
        Msg::SessionNoneSelected =>
            "Chưa chọn phiên".into(),
        Msg::SessionPickerHint =>
            "↑↓ di chuyển · Enter mở · Ctrl+D×2 xóa · Gõ để tìm · Esc hủy".into(),
        Msg::SessionPickerTitle { n, total, project } =>
            format!("Tiếp tục phiên ({n}/{total} · {project})").into(),
        Msg::SessionPickerTitleBare =>
            "Tiếp tục phiên".into(),
        Msg::SessionPickerEmptyProject =>
            "(dự án này chưa có phiên nào)".into(),
        Msg::SessionPickerEmptyFilter =>
            "(không có phiên phù hợp)".into(),
        Msg::SessionPickerEmptyFilterQuery { query } =>
            format!("(không có phiên khớp \"{query}\" — Backspace để xóa)").into(),
        Msg::SessionDeleted { name } =>
            format!("Đã xóa \"{name}\"").into(),
        Msg::SessionDeleteConfirm { name } =>
            format!("Nhấn Ctrl+D lần nữa để xóa \"{name}\"").into(),
        Msg::SessionDeleteFailed { error } =>
            format!("Không xóa được phiên: {error}").into(),
        Msg::SessionRenameEditing { buffer } =>
            format!("> {buffer}_  [Enter: xác nhận, Esc: hủy]").into(),

        Msg::DirPickerTitle { n, total } =>
            format!("Đổi thư mục làm việc ({n}/{total})").into(),
        Msg::DirPickerHint =>
            "↑↓ di chuyển · Tab hoàn thành · Enter mở · Gõ để tìm/nhập đường dẫn · Esc hủy".into(),
        Msg::DirPickerEmptyPath { query } =>
            format!("Không có dự án đã lưu khớp \"{query}\" · Enter để mở như đường dẫn").into(),
        Msg::DirCurrent => "hiện tại".into(),
        Msg::DirNotExists { path } =>
            format!("thư mục không còn tồn tại: {path}").into(),
        Msg::DirChanged { path } =>
            format!("  Đã chuyển sang: {path}\n").into(),
        Msg::DirNotADirectory { path } =>
            format!("Không phải thư mục: {path}").into(),

        Msg::LanguageSwitched { label, locale } =>
            format!("  ✓ Đã chuyển ngôn ngữ sang {label} ({locale}).\n").into(),

        Msg::IdleHintPrefix =>
            "nhập nội dung, hoặc nhấn ".into(),
        Msg::IdleHintSlash => "/".into(),
        Msg::IdleHintSuffix =>
            " để xem các lệnh".into(),
        Msg::IdleHintFull =>
            "nhập nội dung, hoặc nhấn / để xem các lệnh".into(),
        Msg::IdleHintProvider => "/provider".into(),
        Msg::IdleHintProviderSuffix =>
            "để thêm mô hình tùy chỉnh".into(),
        Msg::IdleHintProviderFull =>
            "/provider  để thêm mô hình tùy chỉnh".into(),
        Msg::IdleHintWebui => "/webui".into(),
        Msg::IdleHintWebuiSuffix =>
            "mở phiên đồng bộ trong trình duyệt".into(),
        Msg::IdleHintWebuiFull =>
            "/webui  mở phiên đồng bộ trong trình duyệt".into(),

        Msg::WelcomeTipsHeading => "Mẹo bắt đầu".into(),
        Msg::WelcomeTipProvider => "thêm mô hình tùy chỉnh".into(),
        Msg::WelcomeTipModel => "đặt mô hình mặc định".into(),
        Msg::WelcomeTipResume => "liệt kê và chuyển phiên".into(),
        Msg::WelcomeTipSetup => "thiết lập đề xuất trong một bước".into(),
        Msg::WelcomeTipSkills => "xem các kỹ năng có sẵn".into(),
        Msg::WelcomeTipPlugin => "cài tiện ích kỹ năng/lệnh".into(),
        Msg::WelcomeTipWebui => "mở phiên đồng bộ trong trình duyệt".into(),
        Msg::WelcomeTipMcp => "kết nối công cụ MCP".into(),
        Msg::WelcomeTipPlan => "chế độ lập kế hoạch chỉ đọc".into(),
        Msg::WelcomeTipSession => "bắt đầu phiên mới".into(),
        Msg::WelcomeTipLoop => "chạy câu lệnh theo vòng lặp định kỳ".into(),
        Msg::WelcomeTipGoal => "đặt mục tiêu cho phiên".into(),
        Msg::WelcomeTipInit => "quét mã nguồn vào AGENTS.md".into(),
        Msg::WelcomeTipLanguage => "đổi ngôn ngữ giao diện".into(),
        Msg::CmdSwitchedPlanMode =>
            "  Đã chuyển sang chế độ Plan (khám phá chỉ đọc).\n".into(),
        Msg::CmdSwitchedBuildMode =>
            "  Đã chuyển sang chế độ Build (thực thi đầy đủ).\n".into(),
        Msg::CmdNewSession =>
            "  Đã bắt đầu phiên mới.\n".into(),
        Msg::CmdSessionTransitionPending =>
            "  Môi trường thực thi đang cấu hình lại; nội dung nhập được giữ đến khi sẵn sàng.\n".into(),
        Msg::CmdSessionTransitionFailed { error } =>
            format!("Không chuyển được phiên; phiên trước vẫn hoạt động: {error}").into(),
        Msg::CmdCapabilityReloadFailed { error } =>
            format!("Không tải lại được khả năng thực thi; môi trường trước vẫn hoạt động: {error}").into(),
        Msg::CmdNoProviders =>
            "  Chưa cấu hình nhà cung cấp nào.\n".into(),
        Msg::CmdSessionListLoading =>
            "  Đang tải các phiên…\n".into(),
        Msg::CmdSessionViewLoading =>
            "  Đang mở phiên…\n".into(),
        Msg::CmdNoSessions =>
            "  Không tìm thấy phiên trước. Hãy bắt đầu trò chuyện.\n".into(),
        Msg::CmdUnknownCommand { name } =>
            format!("Lệnh không xác định: /{name}").into(),
        Msg::CmdCustomArgRequired { name } =>
            format!("/{name} cần tham số. Cách dùng: /{name} <your-input>").into(),
        Msg::CmdReloadDone { provider, model } =>
            format!("  Đã tải lại cấu hình. Đang dùng: {provider} · {model}\n").into(),
        Msg::CmdReloadFailed { error } =>
            format!("tải lại thất bại: {error} (giữ cấu hình trước)").into(),
        Msg::CmdUndoNotSupported =>
            "  Chưa hỗ trợ hoàn tác.\n".into(),
        Msg::CmdUndoDone { target, last } =>
            format!("  ↩ Đã quay lại trước lượt {target} (xóa các lượt {target}–{last}). Câu lệnh của bạn đã trở lại ô nhập.\n").into(),
        Msg::CmdUndoDiskWarning =>
            "  ⚠ Chỉ bộ nhớ hội thoại được hoàn tác — tệp trên đĩa KHÔNG được khôi phục. Dùng /diff để xem lại.\n".into(),
        Msg::CmdUndoNoTurns =>
            "  Không có gì để hoàn tác (chưa có câu lệnh).\n".into(),
        Msg::CmdUndoOutOfRange { requested, available } =>
            format!("  Lượt {requested} không hợp lệ (hội thoại có {available} lượt).\n").into(),
        Msg::CmdUndoBusy =>
            "  Không thể hoàn tác khi tác tử đang làm việc — nhấn Esc để hủy trước.\n".into(),
        Msg::CmdRewindBusy =>
            "  Không thể quay lại khi tác tử đang làm việc — nhấn Esc để hủy trước.\n".into(),
        Msg::CmdRewindUnavailable => "Không thể quay lại".into(),
        Msg::CmdUndoBadArg =>
            "  Cách dùng: /undo hoặc /undo N (N = số lượt).\n".into(),
        Msg::CmdNoChanges =>
            "  (không có thay đổi)\n".into(),
        Msg::CmdDiffTruncated =>
            "  … phần diff đã bị cắt bớt\n".into(),
        Msg::CmdCheckingUpdate =>
            "  Đang kiểm tra cập nhật...\n".into(),
        Msg::CmdNoActiveProvider =>
            "Chưa cấu hình nhà cung cấp hoạt động. Dùng /provider để thêm.".into(),
        Msg::CmdProviderUnavailable =>
            "Nhà cung cấp không khả dụng. Dùng /login để đăng nhập hoặc /provider để cấu hình.".into(),
        Msg::CmdProviderUnsupportedBuild =>
            "Bản dựng này không truy cập được cổng JeikCode. Cài bản chính thức hoặc dùng /provider để đổi nhà cung cấp.".into(),
        Msg::CmdProviderReloading =>
            "Đang đổi nhà cung cấp/mô hình. Hãy gửi sau khi hoàn tất.".into(),
        Msg::SubmitHeldUntilProviderReady =>
            "  ↳ nhà cung cấp chưa sẵn sàng — tin nhắn đã xếp hàng, sẽ tự gửi khi sẵn sàng\n".into(),
        Msg::ApprovalPromptAlt { tool, detail } =>
            format!("Cho phép {}({})? [Y]Có=Enter / [N]Không / [A]Luôn cho phép", tool, detail).into(),
        Msg::ApprovalWaitingLabel =>
            "▶ Đang chờ phê duyệt: ".into(),
        Msg::ApprovalAllow => " Cho phép  ".into(),
        Msg::ApprovalAlways => " Luôn cho phép  ".into(),

        Msg::Cancelled => "(đã hủy)".into(),
        Msg::ErrorPrefix { msg } =>
            format!("[Lỗi: {msg}]").into(),

        Msg::UpgradeSuccess { from, to } =>
            format!("  ✓ Đã nâng cấp {} → {}\n", from, to).into(),
        Msg::UpgradeManifestFetched { version } =>
            format!("  Phiên bản mới nhất: {}\n", version).into(),
        Msg::UpgradeDownloading { pct, bytes, total } =>
            format!("  Đang tải {}% ({} / {} byte)\n", pct, bytes, total).into(),
        Msg::UpgradeVerifying =>
            "  Đang xác minh SHA256\n".into(),
        Msg::UpgradeReplacing =>
            "  Đang thay tệp thực thi\n".into(),
        Msg::UpgradeDone { version, backup } =>
            format!("\n✓ Đã nâng cấp lên {} (phiên bản trước được giữ tại {})\n  Đang khởi động lại phiên bản mới...\n", version, backup).into(),
        Msg::UpgradeAlreadyLatest { current, latest } =>
            format!(
                "  ✓ Đang dùng phiên bản mới nhất: {} (mới nhất là {}). Dùng --force để cài lại.\n",
                current, latest
            ).into(),
        Msg::UpgradeFailed { error } =>
            format!("Nâng cấp thất bại: {}", error).into(),
        Msg::UpgradeRolledBack { exe, backup } =>
            format!("\n✓ Đã quay lại. Tệp thực thi hiện tại: {}; phiên bản khác được lưu tại {}\n  Đang khởi động lại phiên bản vừa khôi phục...\n", exe, backup).into(),

        Msg::ConfigProviderLabel { provider, path } =>
            format!("  Nhà cung cấp: {}\n  Cấu hình: {}\n\n", provider, path).into(),

        Msg::CostReport { prompt, completion, cached, cache_rate, total, cost } =>
            format!(
                "  Token đầu vào: {}\n  Token đầu ra: {}\n  Token đã lưu đệm: {} (tỷ lệ trúng {}%)\n  Tổng token: {}\n  Chi phí ước tính: {}\n",
                prompt, completion, cached, cache_rate, total, cost
            ).into(),
        Msg::CostTokenReport { prompt, completion, cached, cache_rate, total } =>
            format!(
                "  Token đầu vào: {}\n  Token đầu ra: {}\n  Token đã lưu đệm: {} (tỷ lệ trúng {}%)\n  Tổng token: {}\n",
                prompt, completion, cached, cache_rate, total
            ).into(),
        Msg::CostFree => "miễn phí".into(),
        Msg::CostUnattributed { tokens } =>
            format!("Mức sử dụng cũ chưa xác định nguồn\n  Tổng token: {}", tokens).into(),

        Msg::ThinkStatus { status, budget, provider } =>
            format!(
                "  Suy nghĩ mở rộng: {}\n  Ngân sách: {} token\n  Nhà cung cấp: {}\n\n  Cách dùng: /think on | off | budget <N>\n",
                status, budget, provider
            ).into(),
        Msg::ThinkEnabled { budget } =>
            format!("  Đã bật suy nghĩ mở rộng (ngân sách: {} token).\n", budget).into(),
        Msg::ThinkDisabled =>
            "  Đã tắt suy nghĩ mở rộng.\n".into(),
        Msg::ThinkBudgetSet { n } =>
            format!("  Đã đặt ngân sách suy nghĩ thành {} token.\n", n).into(),
        Msg::ThinkBudgetTooSmall { n } =>
            format!("Ngân sách phải >= 1024 (nhận được {})", n).into(),
        Msg::ThinkBudgetUsage =>
            "Cách dùng: /think budget <number>".into(),
        Msg::ThinkUsage =>
            "  Cách dùng: /think [on | off | budget <N>]\n".into(),

        Msg::RememberUsage =>
            "Cách dùng: /remember <fact to remember> (--global cho phạm vi toàn cục)".into(),
        Msg::ForgetUsage =>
            "Cách dùng: /forget <keyword>".into(),

        Msg::BackgroundUsage =>
            "  Cách dùng: /background <task description>\n".into(),

        Msg::InitKickoff =>
            "  Đang phân tích dự án và tạo AGENTS.md…\n".into(),

        Msg::CdWorkingDir { cwd } =>
            format!("  Thư mục làm việc: {}\n  Chưa có dự án gần đây. Dùng `/cd <path>` để chuyển.\n", cwd).into(),

        Msg::DiffFailed { error } =>
            format!("git diff thất bại: {}", error).into(),

        Msg::UpgradePackageManaged =>
            "Bản dựng này được HarmonyBrew quản lý. Chạy `brew upgrade jeikcode` để nâng cấp.".into(),
        Msg::UpgradeUnknownArg { arg } =>
            format!("tham số /upgrade không xác định: {}\n  cách dùng: /upgrade [rollback|--force]", arg).into(),

        Msg::SkillsNone =>
            "  Chưa tải kỹ năng nào có thể gọi trực tiếp.\n".into(),
        Msg::SkillsAvailable =>
            "  Kỹ năng khả dụng:\n".into(),
        Msg::SkillUnknown { name } =>
            format!("Kỹ năng không xác định: {} (dùng /skills để liệt kê)", name).into(),
        Msg::SkillsLoaded { names } =>
            format!("  Kỹ năng đã tải: {}\n", names).into(),

        Msg::McpReloading { count } =>
            format!("  Đang tải lại máy chủ MCP... (đã cấu hình {})\n", count).into(),
        Msg::McpConnecting =>
            "  Đang kết nối:\n".into(),
        Msg::McpConnectingServer { name } =>
            format!("    - {}  đang kết nối...\n", name).into(),
        Msg::McpNoServersConfigured =>
            "  Chưa cấu hình máy chủ MCP nào.\n".into(),
        Msg::McpClearedReconnecting =>
            "  Đã yêu cầu tải lại MCP. Công cụ MCP cũ được gỡ trước khi kết nối lại ở nền.\n".into(),
        Msg::McpClearedNoServers =>
            "  Đã yêu cầu tải lại MCP. Công cụ MCP cũ được gỡ; chưa cấu hình máy chủ nào.\n".into(),
        Msg::McpToolsUsage =>
            "  Cách dùng: /mcp tools <server>\n  Ví dụ: /mcp tools filesystem\n".into(),
        Msg::McpServersHeader =>
            "  Máy chủ MCP:\n".into(),
        Msg::McpReloadFailed { error } =>
            format!("tải lại MCP thất bại: không tải được .mcp.json / $JEIKCODE_HOME/mcp.json: {:#}", error).into(),

        Msg::McpOAuthLoginUsage =>
            "  Cách dùng: /mcp login <server>\n  Ví dụ: /mcp login github\n".into(),
        Msg::McpOAuthLogoutUsage =>
            "  Cách dùng: /mcp logout <server>\n  Ví dụ: /mcp logout github\n".into(),
        Msg::McpOAuthLoadConfigFailed { error } =>
            format!("  Đăng nhập MCP OAuth không tải được cấu hình: {error}\n").into(),
        Msg::McpOAuthServerNotFound { server } =>
            format!("  Đăng nhập MCP OAuth thất bại: không tìm thấy máy chủ '{server}' trong cấu hình.\n").into(),
        Msg::McpOAuthStarting { server } =>
            format!("  Đang bắt đầu MCP OAuth cho '{server}' trong trình duyệt...\n").into(),
        Msg::McpOAuthSaved { provider, server } =>
            format!("  Đã lưu token OAuth {provider} cho máy chủ MCP '{server}'. Đang tải lại khả năng MCP.\n").into(),
        Msg::McpOAuthFailed { error } =>
            format!("  MCP OAuth thất bại: {error}\n").into(),
        Msg::McpOAuthTokenRemoved { server } =>
            format!("  Đã xóa token OAuth đã lưu cho máy chủ MCP '{server}'.\n").into(),
        Msg::McpOAuthNoToken { server } =>
            format!("  Không tìm thấy token OAuth đã lưu cho máy chủ MCP '{server}'.\n").into(),
        Msg::McpOAuthLogoutFailed { error } =>
            format!("  Đăng xuất MCP OAuth thất bại: {error}\n").into(),
        Msg::McpProjectTrusted =>
            "  Đã tin cậy dự án — đang tải lại máy chủ MCP.\n".into(),
        Msg::McpProjectUntrusted =>
            "  Đã thu hồi tin cậy dự án.\n".into(),
        Msg::McpProjectNotTrusted =>
            "  Dự án này chưa được tin cậy.\n".into(),
        Msg::LspServerStarted { name, ext } =>
            format!("✓ Máy chủ LSP '{name}' đã khởi động cho .{ext}").into(),
        Msg::LspServerFailed { name, ext, error } =>
            format!("× Máy chủ LSP '{name}' cho .{ext} thất bại: {error}").into(),

        Msg::WorktreeUsage =>
            "  Cách dùng:\n    /worktree create <branch> [base]  Tạo worktree và chuyển sang\n    /worktree list                     Liệt kê mọi worktree\n    /worktree done                     Quay về thư mục gốc\n    /worktree cleanup <branch>         Dọn worktree\n".into(),
        Msg::WorktreeCreateUsage =>
            "  Cách dùng: /worktree create <branch> [base]\n  Ví dụ: /worktree create fix-bug main\n".into(),
        Msg::WorktreeCreated { branch, base, path } =>
            format!("  ✓ Đã tạo worktree\n    Nhánh: {} (dựa trên {})\n    Đường dẫn: {}\n    Đã đổi thư mục làm việc\n", branch, base, path).into(),
        Msg::WorktreeCreateFailed { error } =>
            format!("không tạo được worktree: {}", error).into(),
        Msg::WorktreeNoActive =>
            "  Không có worktree đang hoạt động.\n".into(),
        Msg::WorktreeListFailed { error } =>
            format!("không liệt kê được worktree: {}", error).into(),
        Msg::WorktreeActiveHeader =>
            "  Worktree đang hoạt động:\n".into(),
        Msg::WorktreeHasChanges => "(có thay đổi)".into(),
        Msg::WorktreeClean => "(sạch)".into(),
        Msg::WorktreeCurrent => " ← hiện tại".into(),
        Msg::WorktreeDoneBack { path } =>
            format!("  ✓ Đã quay về: {}\n", path).into(),
        Msg::WorktreeDoneMergeHint { branch } =>
            format!("  Gợi ý: dùng 'git merge {}' hoặc tạo PR để hợp nhất vào nhánh chính\n", branch).into(),
        Msg::WorktreeNoSession =>
            "  Chưa có phiên worktree hoạt động. Dùng /worktree create trước.\n".into(),
        Msg::WorktreeCleanupUsage =>
            "  Cách dùng: /worktree cleanup <branch> [--force]\n".into(),
        Msg::WorktreeCleaned { branch } =>
            format!("  ✓ Đã dọn worktree '{}'\n", branch).into(),
        Msg::WorktreeCleanedSwitched { path } =>
            format!("  Đã quay về: {}\n", path).into(),
        Msg::WorktreeCleanupUncommitted { branch } =>
            format!("  ⚠ Worktree '{}' có thay đổi chưa commit.\n  Dùng /worktree cleanup {} --force để buộc dọn\n", branch, branch).into(),
        Msg::WorktreeCleanupFailed { error } =>
            format!("không dọn được worktree: {}", error).into(),

        Msg::HelpCustomCommandsHeader =>
            "  Lệnh tùy chỉnh:\n".into(),
        Msg::HelpCustomNone =>
            "    (không có)\n\n".into(),
        Msg::HelpCustomCreateHint =>
            "  Tạo tại: ~/.jeikcode/commands/<name>.md hoặc .jeikcode/commands/<name>.md\n".into(),
        Msg::HelpSourceGlobal => "toàn cục".into(),
        Msg::HelpSourceProject => "dự án".into(),

        Msg::SetupHeader { installed, skipped, failed, duration_ms } =>
            format!("\n✅ Thiết lập hoàn tất — đã cài {}, bỏ qua {}, thất bại {} · {}ms\n\n", installed, skipped, failed, duration_ms).into(),
        Msg::SetupInstalledLabel =>
            "Đã cài:\n".into(),
        Msg::SetupSkippedLabel =>
            "\nĐã bỏ qua:\n".into(),
        Msg::SetupFailedLabel =>
            "\nThất bại:\n".into(),
        Msg::SetupInstalledRow { kind, slug, path } =>
            format!("  ✓ {}:{} → {}\n", kind, slug, path).into(),
        Msg::SetupSkippedRow { kind, slug, reason } =>
            format!("  - {}:{} ({:?})\n", kind, slug, reason).into(),
        Msg::SetupFailedRow { kind, slug, error } =>
            format!("  × {}:{} — {}\n", kind, slug, error).into(),
        Msg::CmdSetupTip =>

            "".into(),
        Msg::CmdSetupRunning =>
            "Đang đồng bộ cấu hình cục bộ...".into(),
        Msg::CmdSetupSkillsReloaded { count } =>
            format!("  🔄 Đã tải lại kỹ năng — có {} kỹ năng", count).into(),
        Msg::CmdSetupError { error } =>
            format!("lỗi cấu hình: {error}").into(),
        Msg::CmdSetupRunningSkill =>
            "  Đang phân tích cấu hình dự án...".into(),
        Msg::CmdSetupSkillMissing =>
            "chưa cài kỹ năng thiết lập tùy chọn (đã bỏ qua)".into(),

        Msg::PluginUsage =>
            "cách dùng: /plugin [marketplace add|remove|update|list | install <p>@<m> | uninstall <p>@<m> | reload | list]".into(),
        Msg::PluginMarketplaceUsage =>
            "cách dùng: /plugin marketplace [add|remove|update|list] <args>".into(),
        Msg::PluginInstallUsage =>
            "cách dùng: /plugin install <plugin> hoặc <plugin>@<marketplace>".into(),
        Msg::PluginInstallNotFound { plugin } =>
            format!("không tìm thấy tiện ích `{plugin}` trong kho nào. Dùng /plugin marketplace list để xem kho đã đăng ký.").into(),
        Msg::PluginInstallAmbiguous { plugin } =>
            format!("tiện ích `{plugin}` có trong nhiều kho, hãy chỉ định một kho:").into(),
        Msg::PluginUninstallUsage =>
            "cách dùng: /plugin uninstall <plugin> hoặc <plugin>@<marketplace>".into(),
        Msg::PluginUninstallNotFound { plugin } =>
            format!("tiện ích `{plugin}` chưa được cài. Dùng /plugin list để xem tiện ích đã cài.").into(),
        Msg::PluginUninstallAmbiguous { plugin } =>
            format!("tiện ích `{plugin}` được cài từ nhiều kho, hãy chỉ định:\n").into(),
        Msg::PluginNoMarketplaces =>
            "chưa đăng ký kho nào".into(),
        Msg::PluginMarketplacesHeader =>
            "kho đã đăng ký:".into(),
        Msg::PluginNoInstalled =>
            "chưa cài tiện ích nào".into(),
        Msg::PluginInstalledHeader =>
            "tiện ích đã cài:".into(),
        Msg::PluginMarketplaceCloning { url } =>
            format!("đang sao chép kho từ {url}…").into(),
        Msg::PluginMarketplaceRemoved { name } =>
            format!("đã xóa kho `{name}`").into(),
        Msg::PluginMarketplaceRemoveFailed { error } =>
            format!("xóa kho: {error}").into(),
        Msg::PluginMarketplaceUpdating { name } =>
            format!("đang cập nhật kho `{name}`…").into(),
        Msg::PluginMarketplaceListFailed { error } =>
            format!("liệt kê kho: {error}").into(),
        Msg::PluginAutoUpdateSkipped { detail } =>
            format!("Đã bỏ qua đồng bộ kho (không ảnh hưởng trò chuyện): {detail}").into(),
        Msg::OfflineModeActive =>
            "Chế độ ngoại tuyến: tắt công cụ web, đo lường và tự cập nhật.".into(),
        Msg::PluginHooksUntrusted { count, names } => format!(
            "{count} tiện ích có hook chưa được tin cậy ({names}) — sẽ không chạy. Để tin cậy: jeikcode plugin trust <name>"
        ).into(),
        Msg::PluginInstalling { plugin, marketplace } =>
            format!("đang cài `{plugin}@{marketplace}`…").into(),
        Msg::PluginInstallingByName { plugin } =>
            format!("đang cài `{plugin}`…").into(),
        Msg::PluginAlreadyInstalled { id } =>
            format!("  tiện ích `{id}` đã được cài.\n  Lưu ý: Để cài lại, chạy `/plugin uninstall {id}` rồi `/plugin install {id}`\n").into(),
        Msg::PluginMgrBrowse => "Xem và cài".into(),
        Msg::PluginMgrAdd => "Thêm kho…".into(),
        Msg::PluginMgrRemove => "Xóa kho…".into(),
        Msg::PluginMgrInstalled { count } => format!("Đã cài ({count})").into(),
        Msg::PluginMgrInstalledMark => "✓ đã cài".into(),
        Msg::PluginMgrInstalledStatus => "đã cài".into(),
        Msg::PluginMgrInstallableStatus => "có thể cài".into(),
        Msg::PluginMgrInstallingStatus => "đang cài".into(),
        Msg::PluginMgrUpdatingStatus => "đang cập nhật".into(),
        Msg::PluginMgrHintNav => "↑/↓ chọn · ⏎ mở · esc quay lại".into(),
        Msg::PluginMgrHintToggle => "⏎ cài/gỡ · esc quay lại".into(),
        Msg::PluginMgrHintRemove => "⏎ xóa · esc quay lại".into(),
        Msg::PluginMgrHintUninstall => "⏎ gỡ · esc quay lại".into(),
        Msg::PluginMgrHintUrl => "Enter để thêm · Esc để hủy".into(),
Msg::PluginMgrHintPending => "Đang cài, vui lòng chờ… · esc quay lại".into(),
Msg::PluginMgrHintUpdating => "Đang cập nhật, vui lòng chờ… · esc quay lại".into(),
Msg::PluginMgrInstallingLabel => "Đang cài…".into(),
        Msg::PluginMgrEmptyMarketplaces => "Chưa có kho. Chọn “Thêm kho…” · esc quay lại".into(),
        Msg::PluginMgrEmptyPlugins => "Kho này chưa có tiện ích · esc quay lại".into(),
        Msg::PluginMgrEmptyInstalled => "Chưa cài tiện ích nào · esc quay lại".into(),
        Msg::PluginMgrCloning => "Đang sao chép kho…".into(),
        Msg::PluginMgrInstalling { plugin } => format!("Đang cài {plugin}…").into(),
        Msg::PluginMgrUpdating { plugin } => format!("Đang cập nhật {plugin}…").into(),
        Msg::PluginMgrEscToCancel => "Esc để hủy".into(),
        Msg::PluginMgrRemoveMarketplaceTitle => "  ◆ Xóa kho".into(),
        Msg::PluginMgrRemoveMarketplacePrompt { name } => format!("  \x1b[33mBạn có chắc muốn xóa kho '{name}'?\x1b[39m").into(),
        Msg::PluginMgrRemoveMarketplaceYes => "Có, xóa".into(),
        Msg::PluginMgrRemoveMarketplaceNo => "Không, giữ lại".into(),
        Msg::PluginMgrRemoveMarketplaceHint => "↑/↓ chọn · ⏎ xác nhận · esc hủy".into(),
        Msg::PluginScopeUser => "Cài cho bạn (phạm vi người dùng)".into(),
        Msg::PluginScopeUserDesc => "~/.jeikcode/plugins — mọi dự án".into(),
        Msg::PluginScopeProject => "Cài cho mọi cộng tác viên (phạm vi dự án)".into(),
        Msg::PluginScopeProjectDesc => ".jeikcode/plugins — chia sẻ qua git".into(),
        Msg::PluginScopeLocal => "Cài cho bạn, chỉ trong kho mã này (phạm vi cục bộ)".into(),
        Msg::PluginScopeLocalDesc => ".jeikcode/plugins/local — không commit".into(),
        Msg::PluginScopeHint => "↑↓ Chọn phạm vi · Enter xác nhận · Esc quay lại".into(),
        Msg::PluginScopeUserShort => "người dùng".into(),
        Msg::PluginScopeProjectShort => "dự án".into(),
        Msg::PluginScopeLocalShort => "cục bộ".into(),
        Msg::PluginActionUninstall => "Gỡ cài đặt".into(),
        Msg::PluginActionUninstallDesc => "Gỡ mọi thành phần và thiết lập".into(),
        Msg::PluginActionUpdate => "Cập nhật".into(),
        Msg::PluginActionUpdateDesc => "Cài lại / Nâng cấp lên phiên bản mới nhất".into(),
        Msg::PluginActionDisable => "Vô hiệu hóa".into(),
        Msg::PluginActionDisableDesc => "Tạm vô hiệu hóa tiện ích này".into(),
        Msg::PluginActionBack => "Quay lại".into(),
        Msg::PluginActionBackDesc => "Trở về danh sách đã cài".into(),
        Msg::PluginUninstalled { plugin, marketplace } =>
            format!("đã gỡ `{plugin}@{marketplace}`").into(),
        Msg::PluginUninstallFailed { error } =>
            format!("gỡ cài đặt: {error}").into(),
        Msg::PluginListFailed { error } =>
            format!("liệt kê tiện ích: {error}").into(),
        Msg::PluginReloadDone { skills, warnings } =>
            format!("Đã tải lại tiện ích: {skills} kỹ năng, {warnings} cảnh báo").into(),
        Msg::PluginGitNotFound =>
            "💡 Chưa cài git hoặc git không có trong PATH. Tự cài và cập nhật kho tiện ích đã bị tắt. Cài git (ví dụ `xcode-select --install` trên macOS, `sudo apt install git` trên Ubuntu) rồi khởi động lại JeikCode.".into(),
        Msg::PluginMarketplaceAdded { name, commit, count, plugins } =>
            format!(
                "✓ đã thêm kho `{name}` tại {commit} ({count} tiện ích)\n  Tiện ích: {plugins} — chạy /plugin install <plugin>@{name} để cài trước khi dùng lệnh"
            ).into(),
        Msg::PluginMarketplaceUpdated { name, commit } =>
            format!("✓ đã cập nhật kho `{name}` tới {commit}").into(),
        Msg::PluginInstallDone { plugin, marketplace: _, loaded: _, skipped: _, show_details_hint: _ } => {
            format!("  ⎿  ✓ Đã cài {plugin}. Chạy /reload-plugins để áp dụng.").into()
        }
        Msg::PluginUpdateDone { plugin, marketplace: _, loaded: _, skipped: _, show_details_hint: _ } => {
            format!("  ⎿  ✓ Đã cập nhật {plugin}. Chạy /reload-plugins để áp dụng.").into()
        }
        Msg::SetupAutoReloaded { skills, warnings } =>
            format!("✓ Thiết lập hoàn tất, đã tự tải lại: {skills} kỹ năng, {warnings} cảnh báo").into(),

        Msg::CmdDescWebui => "Mở giao diện web trong trình duyệt (lệnh con: stop, lan, --host <addr>)".into(),
Msg::CmdDescSetup =>
"Quét dự án, cài cấu hình mẫu và chạy kỹ năng thiết lập [hooks|mcp|skills|all]".into(),
        Msg::CmdDescNew => "Bắt đầu phiên mới (xóa hội thoại)".into(),
        Msg::CmdDescSessions => "Liệt kê và chuyển giữa các phiên".into(),
        Msg::SessionSwitched { short_id } =>
            format!("Đã chuyển sang phiên {short_id}").into(),
        Msg::BgUseSessionsInstead =>
            "Dùng /sessions để liệt kê và chuyển phiên (phiên đang chạy có huy hiệu).".into(),
        Msg::CmdDescResume => "Liệt kê và chuyển giữa các phiên (bí danh: dùng /sessions)".into(),
        Msg::CmdDescRename => "Đổi tên phiên hiện tại".into(),
        Msg::CmdDescModel =>
            "Đặt nhà cung cấp / mô hình mặc định và chuyển phiên này".into(),
        Msg::CmdDescModelAdd =>
            "Thêm mô hình vào tài khoản hiện có (lấy /models từ nhà cung cấp)".into(),
        Msg::CmdDescProvider =>
            "Quản lý nhà cung cấp (thêm / sửa / xóa / đặt mặc định toàn cục)".into(),
        Msg::CmdDescStatus => "Hiển thị trạng thái phiên".into(),
        Msg::CmdDescConfig => "Hiển thị đường dẫn cấu hình".into(),
        Msg::CmdDescReload => "Tải lại $JEIKCODE_HOME/config.toml từ đĩa".into(),
        Msg::CmdDescCd => "Đổi thư mục làm việc và bắt đầu phiên mới".into(),
Msg::CmdDescInit => "Phân tích dự án và tạo AGENTS.md".into(),
Msg::CmdDescBg => "Phiên nền: /bg, /bg list, /bg <N>, /bg drop <N>".into(),
Msg::CmdDescBackground => "Chạy tác vụ một lần trong ngữ cảnh nền độc lập (nhóm công cụ chủ yếu chỉ đọc)".into(),
        Msg::CmdDescDiff => "Hiển thị git diff".into(),
        Msg::CmdDescClear => "Xóa màn hình".into(),
        Msg::CmdDescSession => "Bắt đầu phiên mới (xóa hội thoại) — dùng /new".into(),
        Msg::CmdDescCost => "Hiển thị chi phí token".into(),
        Msg::CmdDescContext => "Hiển thị phân bổ ngân sách ngữ cảnh".into(),
        Msg::CmdDescCompact => "Thu gọn lịch sử hội thoại".into(),
        Msg::CmdDescRemember => "Lưu thông tin vào bộ nhớ (/remember --global cho toàn cục)".into(),
        Msg::CmdDescForget => "Xóa các mục bộ nhớ phù hợp".into(),
        Msg::CmdDescMemory => "Hiển thị mọi mục bộ nhớ đã lưu".into(),
        Msg::CmdDescMcp => "Hiển thị trạng thái máy chủ MCP (lệnh con: reload)".into(),
        Msg::CmdDescUndo => "Hoàn tác: quay bộ nhớ hội thoại lại một lượt (/undo hoặc /undo N)".into(),
        Msg::CmdDescRewind => "Quay lại: khôi phục hội thoại về điểm kiểm tra trước".into(),
        Msg::CmdDescWorktree => "Cách ly bằng Git worktree (create/list/done/cleanup)".into(),
        Msg::CmdDescUpgrade => "Nâng cấp jeikcode lên mới nhất (lệnh con: rollback)".into(),
        Msg::CmdDescPlan => "Chuyển sang chế độ Plan (khám phá chỉ đọc)".into(),
        Msg::CmdDescBuild => "Chuyển sang chế độ Build (thực thi đầy đủ)".into(),
        Msg::CmdDescAuto => "Chuyển sang chế độ Auto (tự phê duyệt mọi công cụ)".into(),
        Msg::CmdDescThink => "Điều khiển suy nghĩ mở rộng (on/off/budget N)".into(),
        Msg::CmdDescEffort => "Điều khiển mức suy luận DeepSeek (high / max / off)".into(),
        Msg::CmdDescHelp => "Hiển thị trợ giúp này".into(),
        Msg::CmdDescKeys => "Hiển thị phím tắt".into(),
        Msg::CmdDescLanguage => "Đổi ngôn ngữ hiển thị".into(),
        Msg::CmdDescQuit => "Thoát JeikCode".into(),
        Msg::CmdDescSkills => "Xem kỹ năng đã tải".into(),
        Msg::CmdDescPlugin => "Kho tiện ích (lệnh con: marketplace, install, uninstall, reload, list)".into(),
        Msg::CmdDescPaste => "Đính kèm ảnh từ bộ nhớ tạm (cũng dùng Alt+V / Ctrl+Alt+V)".into(),
        Msg::CmdDescCopy => "Sao chép khối mã hoặc toàn bộ trả lời bằng /copy msg (/copy, /copy N, /copy all, /copy msg)".into(),
        Msg::CopyOk { lines, chars } => format!("Đã sao chép khối mã vào bộ nhớ tạm ({lines} dòng, {chars} ký tự)").into(),
        Msg::CopyOkMsg { lines, chars } => format!("Đã sao chép trả lời vào bộ nhớ tạm ({lines} dòng, {chars} ký tự)").into(),
        Msg::CopyNoCodeBlock => "Trả lời cuối không có khối mã để sao chép".into(),
        Msg::CopyMsgEmpty => "Trả lời cuối trống — không có gì để sao chép".into(),
        Msg::CopyBadIndex { count } => format!("Không có khối mã này — trả lời cuối có {count} khối (dùng /copy N, 1..={count})").into(),
        Msg::CopyFailed => "Bộ nhớ tạm không khả dụng — không sao chép được".into(),
        Msg::CmdDescSave => "Lưu hội thoại hiện tại vào tệp markdown (/save, /save [filename])".into(),
        Msg::SaveOk { path } => format!("Đã lưu hội thoại vào {path}").into(),
        Msg::SaveEmpty => "Chưa có hội thoại để xuất".into(),
        Msg::SaveIoError { error } => format!("Không lưu được hội thoại: {error}").into(),
        Msg::SaveInvalidPath { path } => format!("Đường dẫn không hợp lệ — thư mục không tồn tại: {path}").into(),
        Msg::SaveRefuseOverwrite { path } => format!("Đích đã tồn tại và không phải tệp markdown — từ chối ghi đè để tránh mất mã nguồn/cấu hình: {path}. Dùng tên tệp .md hoặc đường dẫn mới.").into(),
        Msg::CodeBlockCopied => "📋 Đã sao chép khối mã vào bộ nhớ tạm".into(),
        Msg::CmdDescGuide => "Hỏi cách dùng/cấu hình JeikCode qua jeikcode_config_guide".into(),
        Msg::CmdDescView => "Xem nội dung tệp trong hộp thoại nổi".into(),
        Msg::CmdDescApp => "Chia sẻ phiên này với ứng dụng di động qua chuyển tiếp (ghép đôi QR; /app stop để ngắt)".into(),
        Msg::CmdDescReview => "Rà soát mã của thay đổi hiện tại (/review · /review staged · /review <base>)".into(),
        Msg::CmdDescGoal => "Đặt mục tiêu hoàn thành (tự lặp đến khi đạt)".into(),
        Msg::CmdDescProxy => "Chuyển chế độ proxy gửi ra".into(),
        Msg::CmdDescTodo => "Hiển thị việc cần làm; `/todo add <task>` để thêm, `/todo clear` để xóa hết".into(),
        Msg::CmdDescSchedule => "Liệt kê tác vụ định kỳ và thời gian chạy tiếp".into(),
        Msg::CmdDescDesktop =>
            "Mở ứng dụng JeikCode trên máy tính (khởi chạy nếu đã cài, nếu chưa thì hiện liên kết tải)".into(),
        Msg::DesktopOpening { name, path } =>
            format!("Đang mở {}…\n  {}\n", name, path).into(),
        Msg::DesktopNotInstalled { url } =>
            format!("Không tìm thấy ứng dụng JeikCode trên máy tính. Tải và cài:\n  {}\n", url).into(),
        Msg::DesktopLaunchFailed { path, err } =>
            format!("Tìm thấy ứng dụng nhưng không khởi chạy được: {}\n  {}\n", err, path).into(),
        Msg::TodoNoList => "Chưa có danh sách việc (mô hình chưa tạo việc cần làm).".into(),
        Msg::TodoListHeader => "Công việc hiện tại:".into(),
        Msg::TodoAddUsage => "Cách dùng: /todo add <task description>".into(),
        Msg::GuideMenuHeader => "📖 Hướng dẫn JeikCode — nhập /guide <question> (hướng dẫn cấu hình tích hợp)".into(),
        Msg::GuideMenuTopics => "Chủ đề thường gặp:".into(),
        Msg::GuideMenuGettingStarted => "Bắt đầu                  Cài lần đầu, thiết lập nhà cung cấp".into(),
        Msg::GuideMenuSwitchModel => "Đặt mô hình mặc định     Cách dùng /model /provider".into(),
        Msg::GuideMenuMcp => "Sử dụng MCP              Cấu hình và quản lý máy chủ MCP".into(),
        Msg::GuideMenuSkills => "Kỹ năng và tiện ích      Cách dùng /skills /plugin".into(),
        Msg::GuideMenuMemory => "Tính năng bộ nhớ         /remember /forget /memory".into(),
        Msg::GuideMenuBackground => "Tác vụ nền               Thực thi ở nền với /bg".into(),
        Msg::GuideMenuContext => "Quản lý ngữ cảnh         /compact /context /cost".into(),
        Msg::GuideMenuKeybindings => "Phím tắt                 Tra cứu phím tắt".into(),
        Msg::GuideMenuConfig => "Cấu hình                 Tra cứu config.toml".into(),
        Msg::GuideMenuTip => "   Mẹo: nhập /guide <câu hỏi của bạn> để nhận trả lời cụ thể.   Ví dụ: /guide Cách đặt mô hình mặc định ".into(),
        Msg::GuideMenuDocUrl => "".into(),
        Msg::CmdGuideFallbackPrompt { question } => format!(
            "Trả lời câu hỏi cách dùng/cấu hình JeikCode của người dùng. TRƯỚC TIÊN gọi công cụ `jeikcode_config_guide` với `topic` phù hợp nhất (overview, prompts, models, mcp, skills, thesaurus, tools, directories, project, updates, hoặc all). SAU ĐÓ trả lời ngắn gọn bằng ngôn ngữ của người dùng, chỉ dựa trên kết quả công cụ. Không bịa thiết lập và không quảng bá kho kỹ năng bên thứ ba.\n\nCâu hỏi của người dùng: {question}"
        ).into(),
        Msg::CmdGuideInstalling => "Đang chuẩn bị trả lời hướng dẫn, vui lòng chờ...".into(),
        Msg::CmdGuideAutoInstall => "Chưa cài kỹ năng hỏi tùy chọn — dùng hướng dẫn tích hợp.".into(),
        Msg::CmdGuideAutoInvoke { topic } =>
            format!("Đang trả lời: {}", topic).into(),
        Msg::CmdGuideSkillNotFound =>
            "không tìm thấy kỹ năng hỏi — dùng lại /guide <question> với hướng dẫn tích hợp".into(),
        Msg::CmdGuideInstallFailed { error } =>
            format!("Chuẩn bị hướng dẫn thất bại: {}. Thử lại /guide <question>", error).into(),
        Msg::CmdPasteNoImage => "Không có ảnh trong bộ nhớ tạm.".into(),
        Msg::CmdPasteNoImageOhos => {
            "HarmonyOS chưa đọc được ảnh từ bộ nhớ tạm hệ thống. Lưu ảnh vào tệp rồi dán/nhập đường dẫn tuyệt đối (ví dụ /storage/.../pic.png) để đính kèm.".into()
        }

        Msg::ReasoningEffortNoEffect => "reasoning_effort không có tác dụng với mô hình hiện tại (chỉ DeepSeek V4)".into(),

        Msg::ConfigSaveFailed { error } =>
            format!("không lưu được cấu hình: {}", error).into(),

        Msg::OnboardingStepHeaderWelcome => "Bước 1/3 · Chào mừng".into(),
        Msg::OnboardingStepHeaderLanguage => "Bước 2/3 · Ngôn ngữ".into(),
        Msg::OnboardingStepHeaderSetup => "Bước 3/3 · Thiết lập".into(),
        Msg::OnboardingPanelTitle => "JeikCode".into(),
        Msg::OnboardingIntroVersionLine { v } =>
            format!("Phiên bản {v} · Tác tử lập trình AI trong terminal").into(),
        Msg::OnboardingIntroBullet1 =>
            "• Vòng lặp tác tử nhiều bước · công cụ đồ thị mã tích hợp".into(),
        Msg::OnboardingIntroBullet2 =>
            "• Kết nối mọi API tương thích OpenAI".into(),
        Msg::OnboardingIntroBullet3 =>
            "• Cấu hình khóa API riêng để bắt đầu".into(),
        Msg::OnboardingIntroPressEnter => "Nhấn Enter để tiếp tục.".into(),
        Msg::OnboardingIntroCtrlC => "Ctrl+C để thoát bất cứ lúc nào.".into(),
        Msg::OnboardingIntroCompactTagline =>
            "Tác tử lập trình AI trong terminal của bạn.".into(),
        Msg::OnboardingLanguageTitleBilingual =>
            "Chọn ngôn ngữ / Choose your language / 选择语言".into(),
        Msg::OnboardingLanguagePrompt =>
            "Chọn ngôn ngữ giao diện. Có thể đổi bất cứ lúc nào bằng `/language`.".into(),
        Msg::OnboardingLanguageOptionAuto =>
            "Tự nhận dạng (LC_ALL / LANG)".into(),
        Msg::OnboardingLanguageOptionEn => "English".into(),
        Msg::OnboardingLanguageOptionZhCn => "简体中文".into(),
        Msg::OnboardingSetupTitle => "Bạn muốn thiết lập như thế nào?".into(),
        Msg::OnboardingNavHint =>
            "1-3 chọn · Enter xác nhận · ← quay lại · Esc bỏ qua".into(),
        Msg::OnboardingConfirmClear =>
            "/welcome sẽ xóa màn hình. Tiếp tục? [y/N]".into(),
        Msg::CmdWelcomeDescription => "Chạy lại trình hướng dẫn ban đầu".into(),
        Msg::VisionPreprocessSuccess { char_count } =>
            format!("✓ VL đã nhận dạng ảnh, trả về {char_count} ký tự").into(),
        Msg::VisionPreprocessFailed { reason } =>
            format!("Tiền xử lý VL thất bại: {reason} · lượt này tiếp tục chỉ với văn bản; ảnh đã được khôi phục, thử lại để nhận dạng lại").into(),
        Msg::TurnSummary { done, turn_count, tool_call_count, duration, total_tokens, cached_pct } =>
            format!(
                "✓ {done} · {turn_count} vòng · {tool_call_count} công cụ · {duration} · {} token{}",
                super::fmt_tokens(total_tokens),
                cached_pct.map(|p| format!(" · {p}% bộ nhớ đệm")).unwrap_or_default(),
            ).into(),
        Msg::TurnSummaryError { turn_count, tool_call_count, duration, total_tokens, reason } => {
            let cause = reason.map(|r| format!(": {r}")).unwrap_or_default();
            format!("✗ Đã dừng{cause} · {turn_count} vòng · {tool_call_count} công cụ · {duration} · {} token", super::fmt_tokens(total_tokens)).into()
        }
        Msg::CtxUsageHeader => "Mức dùng ngữ cảnh".into(),
        Msg::CtxUsageNoTurns => "(chạy ít nhất một lượt trước — thống kê được ghi theo lượt)".into(),
        Msg::CtxUsageWaiting => "(đang chờ lượt hoàn chỉnh đầu tiên — chỉ có thống kê một phần)".into(),
        Msg::CtxProvider => "Nhà cung cấp".into(),
        Msg::CtxCtxName => "ngữ cảnh".into(),
        Msg::CtxLabelSystemPrompt => "Chỉ dẫn hệ thống".into(),
        Msg::CtxLabelToolDefs => "Định nghĩa công cụ".into(),
        Msg::CtxLabelColdZone => "Vùng lạnh".into(),
        Msg::CtxLabelMessages => "Tin nhắn".into(),
        Msg::CtxLabelFree => "Còn trống".into(),
        Msg::CtxMessagesInWindow { n } => format!("Tin nhắn trong cửa sổ: {n}").into(),
        Msg::CtxSystemPromptHeader => "=== CHỈ DẪN HỆ THỐNG ===".into(),
        Msg::CtxSystemPromptEmpty => "(trống — chờ một lượt hoàn chỉnh để ghi lại)".into(),
        Msg::CtxTokensSuffix => "token".into(),
        Msg::CompactNothingShort => "(không có gì để thu gọn — hội thoại ngắn)\n".into(),
        Msg::CompactStarting => "(đang thu gọn bằng tóm tắt LLM...)\n".into(),
        Msg::CompactInterrupted =>
            "(thu gọn bị gián đoạn — môi trường lập trình đã thay đổi hoặc dừng)\n".into(),
        Msg::CompactUnavailableDuringSync =>
            "Không thể thu gọn khi đồng bộ trực tiếp đang bật; chạy /sync off trước".into(),
        Msg::CompactUnavailableDuringResync =>
            "Không thể thu gọn đến khi môi trường cục bộ khôi phục hội thoại đồng bộ mới nhất".into(),
        Msg::LocalRuntimeRestorePending =>
            "Môi trường cục bộ đang khôi phục hội thoại đồng bộ; vui lòng chờ".into(),
        Msg::LocalRuntimeRestoreTimedOut =>
            "Khôi phục môi trường cục bộ đã hết thời gian; đã khôi phục đồng bộ trực tiếp".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(không có gì để thu gọn — không tiết kiệm token: {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } => {
            let plural = if messages == 1 { "" } else { "" };
            format!("(đã thu gọn — bỏ {} tin nhắn{}, {} → {} token)\n", messages, plural, before, after).into()
        }
        Msg::Compacting => "Đang thu gọn…".into(),
        Msg::CompactingSlow => "Đang thu gọn… (chậm)".into(),
        Msg::CompactMarkDrain { messages, before, after } => {
            let plural = if messages == 1 { "" } else { "" };
            format!("Đã thu gọn · đã tóm tắt {} tin nhắn{} · ~{}→~{} tok", messages, plural, before, after).into()
        }
        Msg::CompactMarkStub { saved } =>
            format!("Đã gấp đầu ra công cụ · tiết kiệm ~{} tok", saved).into(),
        Msg::GoalHelp =>
            "  /goal — tự làm việc nhiều vòng để đạt điều kiện đã nêu.\n  Cách dùng:\n    /goal <condition>     đặt mục tiêu mới; tác tử lặp đến khi bộ đánh giá xác nhận đạt\n    /goal                 xem trạng thái mục tiêu hiện tại\n    /goal status          như trên\n    /goal clear           dừng mục tiêu (bí danh: stop, off, reset, none, cancel)\n    /goal help            trợ giúp này\n  Lưu ý:\n    - Mô hình nhanh đánh giá từng vòng; cấu hình bằng [providers] và\n      evaluator_provider trong ~/.jeikcode/config.toml.\n    - Không có giới hạn vòng/thời gian tích hợp — ghi ngân sách ngay trong\n      điều kiện (ví dụ \"hoặc dừng sau 20 lượt\"). /goal của CC cũng hoạt động như vậy.\n    - Esc / Ctrl+C dừng mục tiêu bất cứ lúc nào.\n".into(),
        Msg::GoalStatus { condition, round, mins, secs } =>
            format!("  ◎ Mục tiêu: {}\n  Vòng: {}\n  Đã qua: {} phút {} giây\n", condition, round, mins, secs).into(),
        Msg::GoalNoActive =>
            "  Chưa có mục tiêu hoạt động.\n  Cách dùng: /goal <condition> | /goal help\n".into(),
        Msg::GoalCleared => "  Đã xóa mục tiêu.\n".into(),

        Msg::LoopStatus { label, round, mins, secs } =>
            format!("  ↻ vòng lặp: {} · vòng {} · {} phút {} giây\n", label, round, mins, secs).into(),
        Msg::LoopNoActive =>
            "  Chưa có /loop hoạt động.\n  Cách dùng: /loop <interval> <cmd> hoặc /loop <prompt>\n".into(),
        Msg::LoopCleared => "  Đã dừng /loop.\n".into(),
        Msg::LoopRound { round, stats } =>
            format!("⚡ vòng lặp {} · {}", round, stats).into(),
        Msg::LoopStopped => "⚠ vòng lặp đã dừng (đạt giới hạn)\n".into(),
        Msg::LoopEnded { reason } =>
            format!("  ↻ Vòng lặp kết thúc: {reason}\n").into(),
        Msg::LoopNoPersistHint =>
            "  (lưu ý: vòng lặp không tiếp tục sau khi khởi động lại / tiếp tục phiên)".into(),
        Msg::CmdDescLoop =>
            "Lặp câu lệnh theo chu kỳ hoặc để mô hình tự điều chỉnh nhịp".into(),
        Msg::ModelNoImageSupport { model } => format!(
            "Mô hình hiện tại \"{}\" không hỗ trợ đầu vào ảnh và chưa cấu hình vision_preprocessor_provider. Dùng /model để chuyển sang mô hình hỗ trợ ảnh hoặc đặt vision_preprocessor_provider trong cấu hình.",
            model
        )
        .into(),
        Msg::VisionPreprocessorUnresolvable { model, provider } => format!(
            "Mô hình hiện tại \"{}\" không hỗ trợ đầu vào ảnh; vision_preprocessor_provider \"{}\" đã cấu hình không tìm thấy (kiểm tra tên có khớp nhà cung cấp/mô hình trong cấu hình). Sửa tên hoặc dùng /model để chuyển sang mô hình hỗ trợ ảnh.",
            model, provider
        )
        .into(),

        Msg::BypassWarningBanner =>
            "\u{26a0} --dangerously-skip-permissions đang bật: mọi lệnh gọi công cụ được tự phê duyệt (không hỏi quyền)\n".into(),
        Msg::BypassWarningHeadless =>
            "[không giao diện] --dangerously-skip-permissions: mọi lệnh gọi công cụ được tự phê duyệt".into(),

        Msg::AdminWarningBanner =>
            "\x1b[33m\u{26a0} Cảnh báo: Đang chạy với quyền Quản trị viên.\n   Mô hình có thể truy cập tệp hệ thống.\n   Nên chạy không nâng quyền, trong thư mục làm việc có phạm vi giới hạn.\x1b[39m\n".into(),
        Msg::AdminWarningHeadless =>
            "[cảnh báo] Đang chạy với quyền Quản trị viên — mô hình có thể truy cập tệp hệ thống.".into(),

        Msg::CtrlCAgainToExit => "  (nhấn Ctrl+C lần nữa để thoát)\n".into(),
        Msg::EscAgainToUndo => "  (nhấn Esc lần nữa để mở hộp quay lại)\n".into(),
        Msg::BashInputHint => "Enter để chạy như lệnh bash".into(),
        Msg::ShellModeHint => "! cho chế độ shell".into(),
        Msg::PendingMessagesTitle =>
            "Tin nhắn sẽ gửi sau lần gọi công cụ tiếp theo (nhấn esc để ngắt và gửi ngay)".into(),
        Msg::PendingMessagesNotSent { count } =>
            format!("{count} tin nhắn chờ chưa được gửi vì môi trường thực thi đã dừng").into(),
        Msg::HintMultiLineInput =>
            "  ⓘ Nhập nhiều dòng: kết thúc dòng bằng `\\` rồi nhấn Enter.\n    Hoạt động trên mọi terminal. (Shift / Alt / Ctrl + Enter cũng có thể dùng\n    tùy giao thức bàn phím của terminal — hãy thử.)\n\n"
                .into(),

        Msg::BgHelp =>
            "  /bg                 Đưa phiên hiện tại xuống nền và mở phiên mới phía trước\n  /bg list            Liệt kê phiên nền\n  /bg <N>             Tiếp tục phiên nền ở ô N\n  /bg drop <N>        Bỏ phiên nền ở ô N\n  /bg help            Hiển thị trợ giúp này\n".into(),
        Msg::BgListEmpty => "  Chưa có phiên nền.\n".into(),
        Msg::BgListHeader => "  #   ID        Trạng thái   Đã tạo   Tóm tắt\n".into(),
        Msg::BgListRow { slot, short_id, state, age, summary } =>
            format!("  {:<3} {:<8}  {:<9}  {:<8}  {}\n", slot, short_id, state, age, summary).into(),
        Msg::BgStateRunning => "đang chạy".into(),
        Msg::BgStateIdle => "nhàn rỗi".into(),
        Msg::BgStateDone => "hoàn tất".into(),
        Msg::BgStateCancelled => "đã hủy".into(),
        Msg::BgStateError => "lỗi".into(),
        Msg::BgAgeNow => "bây giờ".into(),
        Msg::BgAgeMinutes { n } => format!("{n} phút").into(),
        Msg::BgAgeHours { n } => format!("{n} giờ").into(),
        Msg::BgAgeDays { n } => format!("{n} ngày").into(),
        Msg::BgSlotLimitReached { max } =>
            format!("đã đạt giới hạn ô nền ({max})").into(),
        Msg::BgBackgroundCurrent { new_id, slot, old_id, state } =>
            format!("  Phiên phía trước mới [{new_id}]\n  Phiên nền: [#{slot}] {old_id} (trạng thái: {state})\n").into(),
        Msg::BgInvalidSlot { slot, available } =>
            format!("ô nền {slot} không hợp lệ (khả dụng: {available})").into(),
        Msg::BgNoRuntimeClient => "ô nền không có kết nối môi trường thực thi".into(),
        Msg::BgResumed { slot, short_id } =>
            format!("  Đã tiếp tục phiên nền [#{slot}] {short_id}\n").into(),
        Msg::BgPreviousForegroundMoved { slot } =>
            format!("  Phiên phía trước trước đó đã chuyển vào [#{slot}]\n").into(),
        Msg::BgDropped { slot, short_id } =>
            format!("  Đã bỏ phiên nền [#{slot}] {short_id}\n").into(),
        Msg::BgTaskStarted { slot, short_id } =>
            format!("  Phiên nền: [#{slot}] {short_id} (trạng thái: đang chạy)\n").into(),
        Msg::BgTaskTimedOut { secs } =>
            format!("Tác vụ nền hết thời gian sau {secs} giây.").into(),
        Msg::BgTaskError { error } =>
            format!("Lỗi: {error}").into(),
        Msg::BgTaskCancelled => "Đã hủy.".into(),
        Msg::BgTaskNoSummary => "Tác vụ hoàn tất (không có tóm tắt).".into(),

        Msg::CliAbout => "Trợ lý lập trình AI trong terminal của bạn".into(),
        Msg::CliAboutStatus => "Hiển thị trạng thái đăng nhập hiện tại".into(),
        Msg::CliAboutUpgrade => "Nâng cấp jeikcode tại chỗ lên bản phát hành mới nhất".into(),
        Msg::CliHelpUpgradeForce => "Cài lại ngay cả khi đã dùng phiên bản mới nhất".into(),
        Msg::CliHelpUpgradeYes => "Tự áp dụng thay đổi cấu hình mặc định mà không hỏi tương tác".into(),
        Msg::CliAboutRollback => "Quay lại phiên bản trước (đổi với .bak trên đĩa)".into(),
        Msg::CliAboutMcp => "Quản lý mục máy chủ MCP trong .mcp.json".into(),
        Msg::CliAboutDaemon => "Khởi động daemon HTTP để tích hợp IDE".into(),
        Msg::CliAboutWebui => "Khởi động giao diện web cục bộ".into(),
        Msg::CliAboutServe => {
            "Khởi động máy chủ JeikCode không giao diện để kết nối từ xa (web UI + API)".into()
        }
        Msg::CliAboutAttach => {
            "Kết nối máy khách cục bộ với máy chủ JeikCode đang chạy (mở web UI)".into()
        }
        Msg::CliAboutTelemetry => "Điều khiển đo lường".into(),
        Msg::CliAboutPlugin => "Quản lý tiện ích kỹ năng/lệnh".into(),
        Msg::CliAboutUninstall => "Gỡ JeikCode: xóa tệp thực thi, thay đổi PATH và dữ liệu".into(),
        Msg::CliAboutSetup => "Cài tệp mẫu (skills/commands/hooks/MCP) vào ~/.jeikcode/".into(),
        Msg::CliAboutHooks => "Quản lý hook (liệt kê, thử, bật/tắt)".into(),
        Msg::CliAboutHooksList => "Liệt kê mọi hook đã tải cùng trạng thái".into(),
        Msg::CliAboutHooksTest => "Thử hook cụ thể theo tên".into(),
        Msg::CliAboutHooksPaths => "Hiển thị đường dẫn cấu hình hook".into(),
        Msg::CliAboutPluginMarketplace => "Thao tác đăng ký kho tiện ích".into(),
        Msg::CliAboutPluginInstall => "Cài tiện ích từ kho đã đăng ký".into(),
        Msg::CliAboutPluginUninstall => "Gỡ tiện ích đã cài trước đó".into(),
        Msg::CliAboutPluginList => "Liệt kê tiện ích đã cài".into(),
        Msg::CliAboutMarketplaceAdd => "Sao chép kho git tiện ích và đăng ký cục bộ".into(),
        Msg::CliAboutMarketplaceRemove => "Xóa kho đã đăng ký".into(),
        Msg::CliAboutMarketplaceUpdate => "Kéo lại kho đã đăng ký và cập nhật chỉ mục tiện ích".into(),
        Msg::CliAboutMarketplaceList => "Liệt kê kho đã đăng ký".into(),
        Msg::CliAboutMcpAdd => "Thêm hoặc thay máy chủ MCP stdio".into(),
        Msg::CliAboutMcpAddGithubOauth => "Thêm máy chủ MCP GitHub từ xa bằng OAuth".into(),
        Msg::CliAboutMcpLogin => "Hoàn tất đăng nhập OAuth cho máy chủ MCP từ xa".into(),
        Msg::CliAboutMcpLogout => "Xóa thông tin OAuth đã lưu cho máy chủ MCP từ xa".into(),
        Msg::CliAboutTelemetryStatus => "Hiển thị trạng thái đo lường hiện tại và thống kê hàng đợi".into(),
        Msg::CliAboutTelemetryEnable => "Bật đo lường".into(),
        Msg::CliAboutTelemetryDisable => "Tắt đo lường".into(),
        Msg::CliAboutTelemetryDump => "In sự kiện đang chờ trong hàng đợi".into(),
        Msg::CliAboutTelemetryClear => "Xóa sự kiện trong hàng đợi".into(),
        Msg::CliHelpContinue => "Tiếp tục phiên trước thay vì bắt đầu phiên mới".into(),
        Msg::CliHelpProvider => "Nhà cung cấp sử dụng (ghi đè mặc định cấu hình)".into(),
        Msg::CliHelpModel => "Mô hình sử dụng (ghi đè mô hình nhà cung cấp trong cấu hình)".into(),
        Msg::CliHelpLang => "Đặt ngôn ngữ giao diện (ví dụ en, vi-VN, vi, zh-CN, zh)".into(),
        Msg::CliHelpConfig => "Đường dẫn tệp cấu hình".into(),
        Msg::CliHelpDir => "Thư mục làm việc (mặc định là thư mục hiện tại)".into(),
        Msg::CliHelpPrompt => "Câu lệnh chạy ở chế độ không giao diện (không tương tác)".into(),
        Msg::CliHelpPromptFile => "Đọc câu lệnh từ tệp".into(),
        Msg::CliHelpVerbose => "Hiển thị lệnh gọi công cụ, mức dùng token và tóm tắt lượt trên stderr".into(),
        Msg::CliHelpDev => "Tắt tự cập nhật cho lần chạy này".into(),
        Msg::CliHelpNoTelemetry => "Tắt đo lường cho lần gọi này".into(),
        Msg::CliHelpDangerouslySkipPermissions => "Bỏ qua mọi yêu cầu quyền -- tự phê duyệt mọi lệnh gọi công cụ".into(),
        Msg::CliHelpForce => "Cài lại ngay cả khi đã dùng phiên bản mới nhất".into(),
        Msg::CliHelpPortDaemon => "Cổng lắng nghe (mặc định: 13456)".into(),
        Msg::CliHelpClient => "Mã máy khách cho đo lường".into(),
        Msg::CliHelpIdleTimeout => "Thời gian chờ tắt khi nhàn rỗi, tính bằng giây; 0 để tắt tính năng".into(),
        Msg::CliHelpPortWebui => "Cổng (mặc định: 13457)".into(),
        Msg::CliHelpHost => "Địa chỉ liên kết (mặc định: 127.0.0.1)".into(),
        Msg::CliHelpUninstallYes => "Bỏ qua hỏi đáp; dùng quyết định mặc định theo nhóm".into(),
        Msg::CliHelpUninstallPurge => "Xóa hoàn toàn ~/.jeikcode/".into(),
        Msg::CliHelpUninstallKeepData => "Giữ nguyên toàn bộ ~/.jeikcode/".into(),
        Msg::CliHelpUninstallDryRun => "In kế hoạch; không thực hiện".into(),
        Msg::CliHelpMcpGlobal => "Ghi ~/.jeikcode/mcp.json thay vì <dir>/.mcp.json".into(),
        Msg::CliHelpMcpDir => "Thư mục cho .mcp.json của dự án".into(),
        Msg::CliHelpMcpName => "Khóa máy chủ".into(),
        Msg::CliHelpHooksTestName => "Tên hook để thử".into(),
        Msg::CliHelpPluginSpec => "ví dụ plugin@marketplace".into(),
        Msg::CliHelpMarketplaceUrl => "URL Git của kho tiện ích".into(),
        Msg::CliHelpMarketplaceName => "Tên kho tiện ích".into(),
        Msg::CliAboutHelp => "In thông báo này hoặc trợ giúp cho lệnh con đã chỉ định".into(),
        Msg::CliHelpMcpCommand => "Tệp thực thi và tham số".into(),

        Msg::ProviderInitFailed { detail } =>
            format!("khởi tạo nhà cung cấp thất bại: {detail}").into(),
        Msg::ProviderInitSourceBuild =>
            "Đây là bản dựng từ mã nguồn — không dùng được cổng JeikCode miễn phí. Dùng /provider để cấu hình mô hình với api_key riêng (ví dụ DeepSeek / GLM / OpenAI), hoặc chuyển sang bản phát hành chính thức.".into(),
        Msg::GatewayAuthUnavailable { base_url } =>
            format!(
                "base_url '{base_url}' của nhà cung cấp là cổng JeikCode mà bản dựng này không xác thực được. Dùng tệp thực thi chính thức hoặc đặt nhà cung cấp tới điểm cuối tương thích OpenAI thông thường với api_key."
            ).into(),
        Msg::StreamStalled => "esc để hủy".into(),
        Msg::ConhostScrollHint =>
            "Mẹo: console Windows cổ điển có giới hạn — không cuộn lại được khi tác vụ đang chạy, ký tự và linh vật hiển thị kém. \x1b[1;96mWindows Terminal\x1b[0m mang lại trải nghiệm đầy đủ."
                .into(),
    }
}
