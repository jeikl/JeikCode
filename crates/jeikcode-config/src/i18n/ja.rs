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
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("モデルが空の応答を返しました。{wait}秒後に再試行します（{attempt}/{max}）…")
        } else {
            format!("モデルが空の応答を返しました。再試行しています（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("モデルが思考のみを返しました。{wait}秒後に再試行します（{attempt}/{max}）…")
        } else {
            format!("モデルが思考のみを返しました。再試行しています（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("応答形式が不正です。{wait}秒後に再試行します（{attempt}/{max}）…")
        } else {
            format!("応答形式が不正です。再試行しています（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("モデルの応答が遅延しています：{secs}秒以内に応答がないため再試行します（{attempt}/{max}）…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("API エラー {reason}、{wait}秒後に再試行します（{attempt}/{max}）…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "リクエストは約 {estimate_k}K tokens でコンテキスト上限に近づいています（上限 ~{window_k}K − 余裕 {buffer_k}K）。入力を削るか、より大きなコンテキストのモデルへ切り替えてください。"
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("第 {round} ラウンドでコンテキストが溢れました（試行 {attempt} 回目）。圧縮して再試行しています").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("ストリームがアイドルタイムアウトしました — 再接続中（{attempt}/{max}）").into(),
        Msg::AgentResponseTruncated => "応答が上限で打ち切られました：finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("未対応のスナップショット形式 {version}（対応形式 {supported}）のため、空のセッションで開始します").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("モデルの遅延が高すぎます。しばらくしてから再試行してください（{retries} 回連続で {secs} 秒以内に応答なし）").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("モデルが解析不能な応答を {max} 回連続で返しました（上流の一時的な障害）。そのまま再試行するか、少し待ってからやり直してください。").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("モデルが本文やツール呼び出しを返さず思考のみを {max} 回連続で返しました。リクエストがコンテキスト上限を超えているため、入力を減らすか /compact を実行して再試行してください。").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("モデルが本文やツール呼び出しを返さず思考のみを {max} 回連続で返しました。現在のリクエストは約 {prompt_k}K tokens で上限（約 {window_k}K）付近のため、/compact または入力削減をお試しください。").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("モデルが本文やツール呼び出しを返さず思考のみを {max} 回連続で返しました。そのまま再試行するか、時間をおいてやり直してください。").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("モデルが空の応答を {max} 回連続で返しました。リクエストがコンテキスト上限を超えているため、入力を減らすか /compact を実行して再試行してください。").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("モデルが空の応答を {max} 回連続で返しました。現在のリクエストは約 {prompt_k}K tokens で上限（約 {window_k}K）付近のため、/compact または入力削減をお試しください。").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("モデルが空の応答を {max} 回連続で返しました（コンテキスト長とは無関係な上流の一時障害）。そのまま再試行するか、時間をおいてやり直してください。").into(),
        Msg::AgentStatusRateLimited => "レート制限または利用上限に達しました".into(),
        Msg::AgentStatusUpstreamUnavailable => "上流サービスが一時的に利用できません".into(),
        Msg::AgentStatusResponseTimeout => "モデルの応答がタイムアウトしました".into(),
        Msg::AgentStatusConnectionFailed => "ネットワーク接続に失敗しました".into(),
        Msg::AgentStatusInsufficientBalance => "アカウント残高が不足しています".into(),
        Msg::AgentStatusUnauthorized => "API キーが無効または期限切れです".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("ネットワーク接続が切断されました：リモート側で接続が閉じられ、{attempts} 回の自動再接続に失敗しました。再試行できます。").into(),
        Msg::StreamReadPartialResponse =>
            "応答が途中で中断されました：安全に保存できる途中出力は保持されています。このまま続行できます。".into(),
        Msg::StreamReadInterrupted =>
            "ネットワーク接続が切断されました：リモート側で接続が閉じられるかリセットされました。再試行できます。".into(),
        Msg::AgentAutoRetry { max } =>
            format!("接続が切断されました。現在の出力を保持したまま自動再接続しています（最大 {max} 回）…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("接続が切断されました。現在の出力を保持したまま再試行しています（{attempt}/{max}）").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("ストリームがタイムアウトしました。現在の出力を保持して再試行しています（{attempt}/{max}）")
        } else {
            format!("ストリームがタイムアウトしました。再試行しています（{attempt}/{max}）")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("ネットワーク接続が切断されました。現在の出力を保持して再試行しています（{attempt}/{max}）")
        } else {
            format!("ネットワーク接続が切断されました。再試行しています（{attempt}/{max}）")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("接続が回復しました（{attempts} 回の再試行後に続行）").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "自動再接続後もストリーム応答がタイムアウトしたため、このターンを終了しました".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("レート制限に達しました。{secs} 秒後に自動再試行します…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "レート制限の上限に達したため一時停止しました。リセットを待つかモデルを切り替えて続行してください".into()
        } else {
            format!("レート制限により一時停止しました：{detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "一部応答の出力後にストリームがタイムアウトしました。途中までの内容は保持されているため続行できます。".into(),
        Msg::StreamReadResetHint =>
            "このエラーは社内ネットワークやプロキシ環境でよく発生します。プロキシ、VPN、ファイアウォール設定をご確認ください。".into(),
        Msg::StreamReadDetailsPrefix => "詳細：".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "反復ループの可能性：同じ出力とツール呼び出しが繰り返されています。このターンを停止する前に方針変更を促しています。".into()
        } else {
            "反復ループの可能性：同じ出力とツール呼び出しが繰り返されています。方針変更を促しています。".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("停止しました：モデルが {rounds} ラウンド連続で同じ推論・テキストとツール呼び出しパターンを繰り返しました").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("ツールループの可能性：同じ呼び出しまたは読み取り専用バッチが {threshold} 回連続で同じ結果を返しました。方針変更を促しています").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("ツールループを検出：同じ呼び出しまたは読み取り専用バッチが {threshold} 回連続で同じ結果を返したため、次のリクエスト前に停止しました").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("停止しました：モデルが {rounds} ラウンド連続で同じツール呼び出しパターンを繰り返しました").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("最大ラウンド上限（{cap} ラウンド）に達したため、ツール呼び出しを停止して進捗と次のステップを要約します。").into(),
        _ => super::en::en(msg),
    }
}
