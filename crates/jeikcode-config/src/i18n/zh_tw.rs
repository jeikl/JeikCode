use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn zh_tw(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "已共用目前工作階段（與瀏覽器即時互通）".into(),
        Msg::SessionModelRequired => "未設定模型：請先使用 /model 或 /provider 新增提供商和模型後再開始對話。".into(),
        Msg::ServerNoServices => "沒有已安裝的 JeikCode 服務。".into(),
        Msg::WelcomeBannerLine1 => "歡迎使用 JeikCode — 你的終端 AI 程式助手".into(),
        Msg::WelcomeBannerLine2 => "直接輸入問題或任務即可開始對話；輸入 / 可開啟指令清單。".into(),
        Msg::WelcomeOptionConfigureManually => "手動設定".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "手動輸入 API 金鑰與 Base URL".into(),
        Msg::WelcomeOptionSkip => "暫時跳過".into(),
        Msg::WelcomeOptionSkipHint => "直接進入對話介面，稍後設定".into(),
        Msg::WelcomeTipsHeading => "上手提示：".into(),
        Msg::WelcomeTipModel => "切換目前使用的模型".into(),
        Msg::WelcomeTipProvider => "新增自訂模型".into(),
        Msg::WelcomeTipResume => "檢視並繼續歷史工作階段".into(),
        Msg::WelcomeTipSkills => "瀏覽可用技能".into(),
        Msg::WelcomeTipPlugin => "管理外掛程式與市場".into(),
        Msg::WelcomeTipWebui => "啟動網頁介面".into(),
        Msg::WelcomeTipMcp => "檢視 MCP 伺服器狀態".into(),
        Msg::WelcomeTipPlan => "檢視或切換 Plan 模式".into(),
        Msg::WelcomeTipSession => "開始全新工作階段".into(),
        Msg::WelcomeTipLoop => "設定定時或循環任務".into(),
        Msg::WelcomeTipGoal => "設定目標驅動模式".into(),
        Msg::WelcomeTipInit => "初始化專案配置".into(),
        Msg::WelcomeTipLanguage => "切換顯示語言".into(),
        Msg::ProviderPanelTabAccounts => "帳號".into(),
        Msg::ProviderPanelTabModels => "模型".into(),
        Msg::ProviderPanelEmptyAccounts => "（尚無 Provider — 按 Ctrl+A 新增）".into(),
        Msg::ProviderPanelNoMatchingAccounts => "（無相符的 Provider）".into(),
        Msg::ProviderPanelEmptyModels => "（尚無模型 — 按 Ctrl+A 新增，將取得上游 /models）".into(),
        Msg::ProviderPanelNoMatchingModels => "（無相符的模型）".into(),
        Msg::ProviderPanelLegacyBadge => "舊版".into(),
        Msg::ProviderPanelDefaultBadge => "預設".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} 個模型").into(),
        Msg::ProviderPanelAddModelRow => "＋ 新增模型".into(),
        Msg::ProviderPanelAddProviderRow => "＋ 新增自訂 provider".into(),
        Msg::ProviderPanelAccountsHint =>
            "篩選 · ↑↓選擇 · ↵模型 · Ctrl+A新增 · Ctrl+E編輯 · Ctrl+Dx2 刪除 · Tab切換 · Esc關閉".into(),
        Msg::ProviderPanelModelsHint =>
            "篩選 · ↑↓選擇 · ↵預設/新增 · Ctrl+A新增模型並取得上游清單 · Ctrl+E編輯 · Ctrl+Dx2 刪除 · Tab切換 · Esc關閉".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("〔{account}〕· ↑↓選擇 · ↵預設/新增 · Ctrl+A新增模型並取得上游清單 · Ctrl+E編輯 · Ctrl+Dx2 刪除 · Tab全部 · Esc關閉").into(),
        Msg::ProviderPanelModelSaved { model } => format!("已儲存模型「{model}」。").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "圖片將直發本模型；要用 VL 請關閉「支援圖片輸入」。".into()
        }
        Msg::ProviderPanelAddTitle => "【新增 Provider】".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("【編輯帳號 {account}】").into(),
        Msg::ProviderPanelAddModelTitle => "【新增模型】".into(),
        Msg::ProviderPanelEditModelTitle => "【編輯模型】".into(),
        Msg::ProviderPanelFieldVendor => "廠商".into(),
        Msg::ProviderPanelFieldAccount => "帳號".into(),
        Msg::ProviderPanelFieldName => "名稱".into(),
        Msg::ProviderPanelFieldProtocol => "協定".into(),
        Msg::ProviderPanelRequired => "(必填)".into(),
        Msg::ProviderPanelLocked => "(鎖定)".into(),
        Msg::ProviderPanelFieldBaseUrl => "Base URL".into(),
        Msg::ProviderPanelFieldApiKey => "API 金鑰".into(),
        Msg::ProviderPanelFieldModel => "模型".into(),
        Msg::ProviderPanelFieldWindow => "上下文視窗".into(),
        Msg::ProviderPanelFieldSupportsVision => "支援圖片輸入？".into(),
        Msg::ProviderPanelVisionYes => "是 [✓]  （將傳送 base64 圖片）".into(),
        Msg::ProviderPanelVisionNo => "否 [ ]  （僅文字）".into(),
        Msg::ProviderPanelFieldReasoningModel => "是否為思考模型？".into(),
        Msg::ProviderPanelReasoningYes => "是 [✓]  （多輪將回傳思考過程）".into(),
        Msg::ProviderPanelReasoningNo => "否 [ ]  （一般模型/不回傳思考）".into(),
        Msg::ProviderPanelFieldMakeDefault => "設為預設".into(),
        Msg::ProviderPanelSwitchHint => "←→ 切換".into(),
        Msg::ProviderPanelEnvHint { env } => format!("留空使用 ${env}").into(),
        Msg::ProviderPanelDefaultValue => "預設".into(),
        Msg::ProviderPanelKeepOriginal => "留空保留原值".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab 下一項  ←→ 切廠商  空格 勾選  ↵ 儲存  Esc 返回".into(),
        Msg::ProviderPanelAccountFormHint => "Tab 切換  ↵ 儲存  Esc 返回".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab 下一項  ←→ 切協定  ↵ 儲存  Esc 返回  （名稱必填；模型至模型頁新增）".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab 下一項  ↵ 儲存  Esc 返回  （廠商協定已鎖定）".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab 下一項  ←→ 切協定  ↵ 儲存  Esc 返回".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(該 provider 尚未設定)".into(),
        Msg::ProviderPanelModelFormHint =>
            "開啟即取得上游清單  輸入篩選  ↑↓選擇  Tab/↵填入  ←→切帳號（模型框為空時）  空格切換  Esc返回".into(),
        Msg::ProviderPanelModelPlaceholder => "(輸入篩選上游清單)".into(),
        Msg::ProviderPanelUpstreamListLabel => "上游模型清單".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ 選擇 · Tab/↵ 填入".into(),
        Msg::ProviderPanelUpstreamLoading => "載入中…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("已載入 {n} 個上游模型 · 輸入即篩選 · ↑↓ 選擇 · Tab/↵ 填入").into(),
        Msg::ProviderPanelUpstreamEmpty => "上游無模型清單，可直接輸入模型 id".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("上游清單請求失敗（{error}），可直接輸入模型 id").into(),
        Msg::ProviderPanelUpstreamNoUrl => "無可用上游位址，可直接輸入模型 id".into(),
        Msg::ModelPickerNoModelsConfigured => "(未設定模型 — 請使用 /provider 新增)".into(),
        Msg::ModelPickerNoModelsMatch => "(無相符模型)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(無相符 “{query}” 的模型 — 按 Backspace 清除)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  目前工作階段已切換至 {provider} · {model}\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  已切換至 {provider} · {model}，並設為新工作階段的預設值\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ 語言已切換至 {label} ({locale})\n").into(),
        Msg::CmdDescHelp => "顯示幫助資訊與所有可用指令".into(),
        Msg::CmdDescModel => "選擇或切換目前模型".into(),
        Msg::CmdDescProvider => "管理模型提供商與 API 帳號".into(),
        Msg::CmdDescQuit => "結束 JeikCode 對話".into(),
        Msg::StreamStalled => "按 esc 可取消".into(),
        Msg::CompactNothingShort => "（無需壓縮 — 對話較短）\n".into(),
        Msg::CompactStarting => "（正在使用 LLM 摘要進行壓縮...）\n".into(),
        Msg::CompactInterrupted => "（壓縮已中斷 — coding runtime 已變更或停止）\n".into(),
        Msg::CompactUnavailableDuringSync => "同步模式下 /compact 暫不可用；請先執行 /sync off".into(),
        Msg::CompactUnavailableDuringResync => "本地 runtime 尚未恢復最新同步會話，暫不能執行 /compact".into(),
        Msg::LocalRuntimeRestorePending => "本地 runtime 正在恢復同步會話，請稍候".into(),
        Msg::LocalRuntimeRestoreTimedOut => "本地 runtime 恢復逾時，已重新接回 Live 同步".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("（無需壓縮 — 壓縮後不會節省 token：{} → {}）\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("（已壓縮 — 捨棄 {} 條訊息，{} → {} tokens）\n", messages, before, after).into(),
        Msg::Compacting => "正在壓縮…".into(),
        Msg::CompactingSlow => "正在壓縮…（較慢）".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("已壓縮 · 摘要 {} 條 · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("已摺疊工具輸出 · 節省 ~{} tok", saved).into(),
        Msg::CompactThresholdStatus { summary, effective, path } =>
            format!(
                "  自動壓縮閾值：{summary}\n  \
                 目前模型生效：{effective}\n  \
                 設定檔：{path}\n  \
                 用法：/compact threshold <350k | 35% | 0.35 | off | default>\n"
            )
            .into(),
        Msg::CompactThresholdUpdated { summary, effective, path } =>
            format!(
                "  已更新自動壓縮閾值 → {summary}\n  \
                 目前模型生效：{effective}\n  \
                 已儲存至：{path}\n"
            )
            .into(),
        Msg::CompactThresholdInvalid { input } =>
            format!(
                "無效的自動壓縮閾值「{input}」。請使用百分比（10%-100% 或 0.1-1.0）、Token 數（>= 8000，例如 350k）、'off' 或 'default'。"
            )
            .into(),
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("模型回傳空回應，{wait} 秒後重試（{attempt}/{max}）…")
        } else {
            format!("模型回傳空回應，正在重試（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("模型只回傳了思考，{wait} 秒後重試（{attempt}/{max}）…")
        } else {
            format!("模型只回傳了思考，正在重試（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("回應格式異常，{wait} 秒後重試（{attempt}/{max}）…")
        } else {
            format!("回應格式異常，正在重試（{attempt}/{max}）…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("模型延遲過高：{secs} 秒內無回應，正在重試（{attempt}/{max}）…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("API 錯誤 {reason}，{wait} 秒後重試（{attempt}/{max}）…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "請求約 {estimate_k}K tokens 已達內容視窗水位（視窗約 {window_k}K − 緩衝 {buffer_k}K）：請精簡輸入或改用更大視窗的模型。"
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("第 {round} 輪內容視窗溢位（第 {attempt} 次嘗試）；正在壓縮並重試").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("串流閒置逾時 — 正在重新連線（{attempt}/{max}）").into(),
        Msg::AgentResponseTruncated => "回應已截斷：finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("不支援的快照版本 {version}（核心支援 {supported}）；將以空白工作階段啟動").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("模型延遲過高，請稍後再試（連續 {retries} 次在 {secs} 秒內未收到首個回應）").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("模型連續 {max} 次回傳無法解析的回應（上游偶發異常）。可直接重試，或稍後再試。").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("模型連續 {max} 次只回傳思考、未給出正文或工具呼叫。如前所述，本次請求已超過模型內容視窗——請精簡輸入或執行 /compact 後重試。").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("模型連續 {max} 次只回傳思考、未給出正文或工具呼叫。目前請求約 {prompt_k}K tokens，已接近或超過模型視窗（約 {window_k}K），建議執行 /compact 或精簡輸入後重試。").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("模型連續 {max} 次只回傳思考、未給出正文或工具呼叫。可直接重試，或稍後再試。").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("模型連續 {max} 次回傳空回應。如前所述，本次請求已超過模型內容視窗——請精簡輸入或執行 /compact 後重試。").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("模型連續 {max} 次回傳空回應。目前請求約 {prompt_k}K tokens，已接近或超過模型視窗（約 {window_k}K），建議執行 /compact 或精簡輸入後重試。").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("模型連續 {max} 次回傳空回應（上游偶發異常，與內容長度無關）。可直接重試，或稍後再試。").into(),
        Msg::AgentStatusRateLimited => "請求過於頻繁或額度已用盡".into(),
        Msg::AgentStatusUpstreamUnavailable => "上游服務暫時無法使用".into(),
        Msg::AgentStatusResponseTimeout => "模型回應逾時".into(),
        Msg::AgentStatusConnectionFailed => "網路連線失敗".into(),
        Msg::AgentStatusInsufficientBalance => "帳戶餘額不足".into(),
        Msg::AgentStatusUnauthorized => "API 金鑰未授權或已失效".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("網路連線中斷：遠端關閉或重設了連線，自動重新連線 {attempts} 次後仍失敗，可重試。").into(),
        Msg::StreamReadPartialResponse =>
            "回應中斷：已保留可安全儲存的部分回覆，可繼續。".into(),
        Msg::StreamReadInterrupted =>
            "網路連線中斷：遠端關閉或重設了連線，可重試。".into(),
        Msg::AgentAutoRetry { max } =>
            format!("連線中斷，正在自動重新連線（最多 {max} 次），已保留目前輸出…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("連線中斷，已保留目前輸出，重試 {attempt}/{max} 次").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("串流閒置逾時，已保留目前輸出，重試 {attempt}/{max} 次")
        } else {
            format!("串流閒置逾時，正在重試 {attempt}/{max} 次")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("網路連線中斷，已保留目前輸出，重試 {attempt}/{max} 次")
        } else {
            format!("網路連線中斷，正在重試 {attempt}/{max} 次")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("連線已恢復（重試 {attempts} 次後繼續）").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "自動重新連線後串流回應仍逾時，已終止本輪".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("觸發速率限制，{secs} 秒後自動重試…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "達到速率限制額度，已暫停，請等待重設或切換模型後繼續".into()
        } else {
            format!("達到速率限制已暫停：{detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "串流在已產生部分回覆後逾時；已保留部分回覆，可繼續。".into(),
        Msg::StreamReadResetHint =>
            "此錯誤常見於公司網路或代理環境，請檢查代理、VPN 或防火牆設定後重試。".into(),
        Msg::StreamReadDetailsPrefix => "詳細資訊：".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "疑似複讀死迴圈：偵測到連續重複相同的輸出與工具呼叫，已提示模型最後一次調整方向，否則將終止本輪。".into()
        } else {
            "疑似複讀死迴圈：偵測到連續重複相同的輸出與工具呼叫，已提示模型調整方向。".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("已停止：模型連續 {rounds} 輪複讀相同的推理、文字與工具呼叫模式").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("疑似工具呼叫迴圈：相同呼叫或唯讀批次處理連續 {threshold} 次回傳相同結果，已提示模型調整策略").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("偵測到工具呼叫死迴圈：相同呼叫或唯讀批次處理連續 {threshold} 次回傳相同結果，已在下次請求前停止").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("已停止：模型連續 {rounds} 輪重複相同的工具呼叫模式").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("已達到最大輪次上限（{cap} 輪）；已停止呼叫工具並產生進度總結與後續建議。").into(),
        _ => super::zh_cn::zh_cn(msg),
    }
}
