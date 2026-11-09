use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn ja(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "現在のセッションを共有しました（ブラウザとリアルタイム同期）".into(),
        Msg::SessionModelRequired => "モデルが設定されていません: 対話を開始する前に /model または /provider でモデルを設定してください。".into(),
        Msg::ServerNoServices => "インストールされている JeikCode サービスはありません。".into(),
        Msg::WelcomeBannerLine1 => "JeikCode へようこそ — ターミナル AI コーディングアシスタント".into(),
        Msg::WelcomeBannerLine2 => "質問やタスクを入力して対話を開始できます。/ でコマンド一覧を表示します。".into(),
        Msg::WelcomeOptionConfigureManually => "手動で設定する".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "APIキーとエンドポイントを手動入力".into(),
        Msg::WelcomeOptionSkip => "今はスキップ".into(),
        Msg::WelcomeOptionSkipHint => "直接チャットに入り、後で設定する".into(),
        Msg::WelcomeTipsHeading => "おすすめのコマンド:".into(),
        Msg::WelcomeTipModel => "モデルを切り替える".into(),
        Msg::WelcomeTipProvider => "カスタムプロバイダーを追加".into(),
        Msg::WelcomeTipResume => "過去のセッションを再開".into(),
        Msg::WelcomeTipSkills => "利用可能なスキル一覧".into(),
        Msg::WelcomeTipPlugin => "プラグインとマーケットプレイスの管理".into(),
        Msg::WelcomeTipWebui => "ブラウザ WebUI を起動".into(),
        Msg::WelcomeTipMcp => "MCP サーバー状態を表示".into(),
        Msg::WelcomeTipPlan => "Plan モードの表示・切替".into(),
        Msg::WelcomeTipSession => "新しいセッションを開始".into(),
        Msg::WelcomeTipLoop => "定期実行・ループタスクの設定".into(),
        Msg::WelcomeTipGoal => "目標駆動モードの設定".into(),
        Msg::WelcomeTipInit => "プロジェクト設定を初期化".into(),
        Msg::WelcomeTipLanguage => "表示言語を切り替える".into(),
        Msg::ProviderPanelTabAccounts => "アカウント".into(),
        Msg::ProviderPanelTabModels => "モデル".into(),
        Msg::ProviderPanelEmptyAccounts => "（プロバイダーがありません — Ctrl+A で追加）".into(),
        Msg::ProviderPanelNoMatchingAccounts => "（一致するプロバイダーがありません）".into(),
        Msg::ProviderPanelEmptyModels => "（モデルがありません — Ctrl+A で追加、上流 /models を取得）".into(),
        Msg::ProviderPanelNoMatchingModels => "（一致するモデルがありません）".into(),
        Msg::ProviderPanelLegacyBadge => "レガシー".into(),
        Msg::ProviderPanelDefaultBadge => "デフォルト".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} 個のモデル").into(),
        Msg::ProviderPanelAddModelRow => "+ モデルを追加".into(),
        Msg::ProviderPanelAddProviderRow => "+ カスタムプロバイダーを追加".into(),
        Msg::ProviderPanelAccountsHint =>
            "絞り込み · ↑↓選択 · ↵モデル · Ctrl+A追加 · Ctrl+E編集 · Ctrl+Dx2削除 · Tab切替 · Esc閉じる".into(),
        Msg::ProviderPanelModelsHint =>
            "絞り込み · ↑↓選択 · ↵デフォルト/追加 · Ctrl+Aモデル追加と上流リスト取得 · Ctrl+E編集 · Ctrl+Dx2削除 · Tab切替 · Esc閉じる".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓選択 · ↵デフォルト/追加 · Ctrl+Aモデル追加 · Ctrl+E編集 · Ctrl+Dx2削除 · Tab全て · Esc閉じる").into(),
        Msg::ProviderPanelModelSaved { model } => format!("モデル「{model}」を保存しました。").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "画像はこのモデルに直接送信されます。VLを使用する場合は画像入力を無効にしてください。".into()
        }
        Msg::ProviderPanelAddTitle => "[プロバイダーを追加]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[アカウント {account} を編集]").into(),
        Msg::ProviderPanelAddModelTitle => "[モデルを追加]".into(),
        Msg::ProviderPanelEditModelTitle => "[モデルを編集]".into(),
        Msg::ProviderPanelFieldVendor => "プロバイダー".into(),
        Msg::ProviderPanelFieldAccount => "アカウント".into(),
        Msg::ProviderPanelFieldName => "名前".into(),
        Msg::ProviderPanelFieldProtocol => "プロトコル".into(),
        Msg::ProviderPanelRequired => "(必須)".into(),
        Msg::ProviderPanelLocked => "(ロック)".into(),
        Msg::ProviderPanelFieldBaseUrl => "Base URL".into(),
        Msg::ProviderPanelFieldApiKey => "APIキー".into(),
        Msg::ProviderPanelFieldModel => "モデル".into(),
        Msg::ProviderPanelFieldWindow => "コンテキストウィンドウ".into(),
        Msg::ProviderPanelFieldSupportsVision => "画像入力をサポート？".into(),
        Msg::ProviderPanelVisionYes => "はい [✓]  （base64画像を送信）".into(),
        Msg::ProviderPanelVisionNo => "いいえ [ ]  （テキストのみ）".into(),
        Msg::ProviderPanelFieldReasoningModel => "思考モデルですか？".into(),
        Msg::ProviderPanelReasoningYes => "はい [✓]  （思考プロセスを履歴に含める）".into(),
        Msg::ProviderPanelReasoningNo => "いいえ [ ]  （標準モデル）".into(),
        Msg::ProviderPanelFieldMakeDefault => "デフォルトに設定".into(),
        Msg::ProviderPanelSwitchHint => "←→ 切替".into(),
        Msg::ProviderPanelEnvHint { env } => format!("空欄の場合は ${env} を使用").into(),
        Msg::ProviderPanelDefaultValue => "デフォルト".into(),
        Msg::ProviderPanelKeepOriginal => "空欄の場合は現在の値を維持".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab 次へ  ←→ プロバイダー切替  スペース 選択  ↵ 保存  Esc 戻る".into(),
        Msg::ProviderPanelAccountFormHint => "Tab 切替  ↵ 保存  Esc 戻る".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab 次へ  ←→ プロトコル切替  ↵ 保存  Esc 戻る  (名前は必須。モデルはモデルタブで追加)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab 次へ  ↵ 保存  Esc 戻る  (プロバイダープロトコルは固定)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab 次へ  ←→ プロトコル切替  ↵ 保存  Esc 戻る".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(このプロバイダーは未設定です)".into(),
        Msg::ProviderPanelModelFormHint =>
            "上流リスト取得中  入力して絞り込み  ↑↓選択  Tab/↵入力  ←→アカウント切替  スペース切替  Esc戻る".into(),
        Msg::ProviderPanelModelPlaceholder => "(入力して上流リストを絞り込み)".into(),
        Msg::ProviderPanelUpstreamListLabel => "上流モデルリスト".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ 選択 · Tab/↵ 入力".into(),
        Msg::ProviderPanelUpstreamLoading => "読み込み中…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("{n} 個の上流モデルを読み込みました · 入力して絞り込み · ↑↓ 選択 · Tab/↵ 入力").into(),
        Msg::ProviderPanelUpstreamEmpty => "上流モデルがありません。モデルIDを直接入力してください".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("上流リストの取得に失敗しました ({error})。モデルIDを直接入力してください").into(),
        Msg::ProviderPanelUpstreamNoUrl => "上流URLがありません。モデルIDを直接入力してください".into(),
        Msg::ModelPickerNoModelsConfigured => "(モデルが設定されていません — /provider で追加してください)".into(),
        Msg::ModelPickerNoModelsMatch => "(一致するモデルがありません)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(「{query}」に一致するモデルがありません — Backspace で消去)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  現在のセッションを {provider} · {model} に切り替えました\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  {provider} · {model} に切り替え、今後のデフォルトに設定しました\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ 言語を {label} ({locale}) に切り替えました\n").into(),
        Msg::CmdDescHelp => "ヘルプと利用可能なコマンドを表示".into(),
        Msg::CmdDescModel => "現在のモデルを選択・切り替える".into(),
        Msg::CmdDescProvider => "モデルプロバイダーとAPIアカウントの管理".into(),
        Msg::CmdDescQuit => "JeikCode を終了する".into(),
        Msg::StreamStalled => "esc でキャンセル".into(),
        Msg::CompactNothingShort => "（圧縮不要 — 会話が短い）\n".into(),
        Msg::CompactStarting => "（LLM 要約で圧縮中...）\n".into(),
        Msg::CompactInterrupted => "（圧縮は中断されました — coding runtime が変更または停止）\n".into(),
        Msg::CompactUnavailableDuringSync => "ライブ同期中は圧縮できません。/sync off を先に実行してください".into(),
        Msg::CompactUnavailableDuringResync => "ローカル runtime が最新の同期会話を復元するまで圧縮できません".into(),
        Msg::LocalRuntimeRestorePending => "ローカル runtime が同期会話を復元中です。しばらくお待ちください".into(),
        Msg::LocalRuntimeRestoreTimedOut => "ローカル runtime の復元がタイムアウトしました。Live 同期に再接続しました".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("（圧縮不要 — トークンを節約できません：{} → {}）\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("（圧縮しました — {} 件のメッセージを破棄、{} → {} tokens）\n", messages, before, after).into(),
        Msg::Compacting => "圧縮中…".into(),
        Msg::CompactingSlow => "圧縮中…（遅い）".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("圧縮済み · {} 件を要約 · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("ツール出力を折りたたみました · ~{} tok 節約", saved).into(),
        _ => super::en::en(msg),
    }
}
