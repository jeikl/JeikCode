use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn ko(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "현재 세션이 공유되었습니다 (브라우저와 실시간 동기화)".into(),
        Msg::SessionModelRequired => "모델이 설정되지 않았습니다: 대화를 시작하기 전에 /model 또는 /provider 명령어로 모델을 추가해 주세요.".into(),
        Msg::ServerNoServices => "설치된 JeikCode 서비스가 없습니다.".into(),
        Msg::WelcomeBannerLine1 => "JeikCode에 오신 것을 환영합니다 — 터미널 AI 코딩 어시스턴트".into(),
        Msg::WelcomeBannerLine2 => "질문이나 작업을 입력하여 대화를 시작하세요. / 를 입력하면 명령어 목록이 표시됩니다.".into(),
        Msg::WelcomeOptionConfigureManually => "수동 구성".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "API 키 및 엔드포인트 직접 입력".into(),
        Msg::WelcomeOptionSkip => "지금은 건너뛰기".into(),
        Msg::WelcomeOptionSkipHint => "대화 화면으로 바로 이동, 나중에 설정".into(),
        Msg::WelcomeTipsHeading => "시작 가이드:".into(),
        Msg::WelcomeTipModel => "현재 모델 전환".into(),
        Msg::WelcomeTipProvider => "사용자 정의 공급자 추가".into(),
        Msg::WelcomeTipResume => "이전 세션 확인 및 복원".into(),
        Msg::WelcomeTipSkills => "사용 가능한 스킬 목록".into(),
        Msg::WelcomeTipPlugin => "플러그인 및 마켓플레이스 관리".into(),
        Msg::WelcomeTipWebui => "웹 UI 브라우저 실행".into(),
        Msg::WelcomeTipMcp => "MCP 서버 상태 확인".into(),
        Msg::WelcomeTipPlan => "Plan 모드 확인 및 전환".into(),
        Msg::WelcomeTipSession => "새 대화 세션 시작".into(),
        Msg::WelcomeTipLoop => "주기적 또는 반복 작업 설정".into(),
        Msg::WelcomeTipGoal => "목표 기반 에이전트 모드".into(),
        Msg::WelcomeTipInit => "프로젝트 구성 초기화".into(),
        Msg::WelcomeTipLanguage => "표시 언어 변경".into(),
        Msg::ProviderPanelTabAccounts => "계정".into(),
        Msg::ProviderPanelTabModels => "모델".into(),
        Msg::ProviderPanelEmptyAccounts => "（공급자가 없습니다 — Ctrl+A를 눌러 추가）".into(),
        Msg::ProviderPanelNoMatchingAccounts => "（일치하는 공급자가 없습니다）".into(),
        Msg::ProviderPanelEmptyModels => "（모델이 없습니다 — Ctrl+A를 눌러 추가, 상위 /models 가져오기）".into(),
        Msg::ProviderPanelNoMatchingModels => "（일치하는 모델이 없습니다）".into(),
        Msg::ProviderPanelLegacyBadge => "레거시".into(),
        Msg::ProviderPanelDefaultBadge => "기본값".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count}개 모델").into(),
        Msg::ProviderPanelAddModelRow => "+ 모델 추가".into(),
        Msg::ProviderPanelAddProviderRow => "+ 사용자 정의 공급자 추가".into(),
        Msg::ProviderPanelAccountsHint =>
            "필터 · ↑↓선택 · ↵모델 · Ctrl+A추가 · Ctrl+E수정 · Ctrl+Dx2삭제 · Tab전환 · Esc닫기".into(),
        Msg::ProviderPanelModelsHint =>
            "필터 · ↑↓선택 · ↵기본/추가 · Ctrl+A모델 추가 및 상위 목록 조회 · Ctrl+E수정 · Ctrl+Dx2삭제 · Tab전환 · Esc닫기".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓선택 · ↵기본/추가 · Ctrl+A모델 추가 · Ctrl+E수정 · Ctrl+Dx2삭제 · Tab전체 · Esc닫기").into(),
        Msg::ProviderPanelModelSaved { model } => format!("모델 \"{model}\"이(가) 저장되었습니다.").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "이미지가 이 모델로 직접 전송됩니다. VL을 사용하려면 이미지 입력을 끄세요.".into()
        }
        Msg::ProviderPanelAddTitle => "[공급자 추가]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[계정 {account} 수정]").into(),
        Msg::ProviderPanelAddModelTitle => "[모델 추가]".into(),
        Msg::ProviderPanelEditModelTitle => "[모델 수정]".into(),
        Msg::ProviderPanelFieldVendor => "제공자".into(),
        Msg::ProviderPanelFieldAccount => "계정".into(),
        Msg::ProviderPanelFieldName => "이름".into(),
        Msg::ProviderPanelFieldProtocol => "프로토콜".into(),
        Msg::ProviderPanelRequired => "(필수)".into(),
        Msg::ProviderPanelLocked => "(잠김)".into(),
        Msg::ProviderPanelFieldBaseUrl => "Base URL".into(),
        Msg::ProviderPanelFieldApiKey => "API 키".into(),
        Msg::ProviderPanelFieldModel => "모델".into(),
        Msg::ProviderPanelFieldWindow => "컨텍스트 창 크기".into(),
        Msg::ProviderPanelFieldSupportsVision => "이미지 입력 지원 여부?".into(),
        Msg::ProviderPanelVisionYes => "예 [✓]  (base64 이미지 전송)".into(),
        Msg::ProviderPanelVisionNo => "아니오 [ ]  (텍스트 전용)".into(),
        Msg::ProviderPanelFieldReasoningModel => "추론 모델 여부?".into(),
        Msg::ProviderPanelReasoningYes => "예 [✓]  (추론 과정을 대화 기록에 포함)".into(),
        Msg::ProviderPanelReasoningNo => "아니오 [ ]  (일반 모델)".into(),
        Msg::ProviderPanelFieldMakeDefault => "기본값으로 설정".into(),
        Msg::ProviderPanelSwitchHint => "←→ 전환".into(),
        Msg::ProviderPanelEnvHint { env } => format!("비워둘 경우 ${env} 사용").into(),
        Msg::ProviderPanelDefaultValue => "기본값".into(),
        Msg::ProviderPanelKeepOriginal => "비워둘 경우 현재 값 유지".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab 다음  ←→ 공급자 전환  스페이스 선택  ↵ 저장  Esc 뒤로".into(),
        Msg::ProviderPanelAccountFormHint => "Tab 전환  ↵ 저장  Esc 뒤로".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab 다음  ←→ 프로토콜 전환  ↵ 저장  Esc 뒤로  (이름은 필수이며, 모델은 모델 탭에서 추가)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab 다음  ↵ 저장  Esc 뒤로  (공급자 프로토콜 고정됨)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab 다음  ←→ 프로토콜 전환  ↵ 저장  Esc 뒤로".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(이 공급자는 아직 구성되지 않았습니다)".into(),
        Msg::ProviderPanelModelFormHint =>
            "상위 목록 불러오는 중  입력하여 필터링  ↑↓선택  Tab/↵입력  ←→계정 전환  스페이스 토글  Esc뒤로".into(),
        Msg::ProviderPanelModelPlaceholder => "(입력하여 상위 목록 필터링)".into(),
        Msg::ProviderPanelUpstreamListLabel => "상위 모델 목록".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ 선택 · Tab/↵ 입력".into(),
        Msg::ProviderPanelUpstreamLoading => "로딩 중…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("{n}개의 상위 모델을 불러왔습니다 · 입력하여 필터 · ↑↓ 선택 · Tab/↵ 입력").into(),
        Msg::ProviderPanelUpstreamEmpty => "상위 모델 목록이 비어 있습니다. 모델 ID를 직접 입력하세요".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("상위 목록 조회 실패 ({error}). 모델 ID를 직접 입력하세요").into(),
        Msg::ProviderPanelUpstreamNoUrl => "상위 URL이 없습니다. 모델 ID를 직접 입력하세요".into(),
        Msg::ModelPickerNoModelsConfigured => "(구성된 모델이 없습니다 — /provider 명령어로 추가하세요)".into(),
        Msg::ModelPickerNoModelsMatch => "(일치하는 모델이 없습니다)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(\"{query}\"와(과) 일치하는 모델이 없습니다 — Backspace를 눌러 지우기)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  현재 세션이 {provider} · {model}(으)로 전환되었습니다\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  {provider} · {model}(으)로 전환되었으며 새 세션의 기본값으로 설정되었습니다\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ 언어가 {label} ({locale})(으)로 변경되었습니다\n").into(),
        Msg::CmdDescHelp => "도움말 및 사용 가능한 명령어 보기".into(),
        Msg::CmdDescModel => "현재 모델 선택 및 전환".into(),
        Msg::CmdDescProvider => "모델 공급자 및 API 계정 관리".into(),
        Msg::CmdDescQuit => "JeikCode 대화 종료".into(),
        Msg::StreamStalled => "esc를 눌러 취소".into(),
        Msg::CompactNothingShort => "（압축할 필요 없음 — 대화가 짧음）\n".into(),
        Msg::CompactStarting => "（LLM 요약으로 압축 중...）\n".into(),
        Msg::CompactInterrupted => "（압축이 중단됨 — coding runtime 이 변경되었거나 중지됨）\n".into(),
        Msg::CompactUnavailableDuringSync => "라이브 동기화 중에는 압축할 수 없습니다. 먼저 /sync off 를 실행하세요".into(),
        Msg::CompactUnavailableDuringResync => "로컬 runtime 이 최신 동기화 대화를 복원할 때까지 압축할 수 없습니다".into(),
        Msg::LocalRuntimeRestorePending => "로컬 runtime 이 동기화 대화를 복원 중입니다. 잠시 기다려 주세요".into(),
        Msg::LocalRuntimeRestoreTimedOut => "로컬 runtime 복원 시간이 초과되었습니다. Live 동기화로 다시 연결했습니다".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("（압축할 필요 없음 — 토큰을 절약할 수 없음: {} → {}）\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("（압축됨 — {}개 메시지 삭제, {} → {} tokens）\n", messages, before, after).into(),
        Msg::Compacting => "압축 중…".into(),
        Msg::CompactingSlow => "압축 중…（느림）".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("압축됨 · {}개 요약 · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("도구 출력 접힘 · ~{} tok 절약", saved).into(),
        _ => super::en::en(msg),
    }
}
