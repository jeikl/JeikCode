use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn ar(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "تمت مشاركة الجلسة الحالية (مزامنة مباشرة مع المتصفح)".into(),
        Msg::SessionModelRequired => "لم يتم تكوين أي نموذج: استخدم /model أو /provider لإضافة نموذج قبل بدء المحادثة.".into(),
        Msg::ServerNoServices => "لا توجد خدمات JeikCode مثبتة.".into(),
        Msg::WelcomeBannerLine1 => "مرحبًا بك في JeikCode — مساعد البرمجة بالذكاء الاصطناعي في الطرفية".into(),
        Msg::WelcomeBannerLine2 => "اكتب سؤالاً أو مهمة للبدء. اكتب / لعرض قائمة الأوامر.".into(),
        Msg::WelcomeOptionConfigureManually => "تكوين يدوي".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "إدخال مفتاح API وعنوان URL المخصص".into(),
        Msg::WelcomeOptionSkip => "تخطي الآن".into(),
        Msg::WelcomeOptionSkipHint => "الانتقال مباشرة إلى الدردشة والتكوين لاحقًا".into(),
        Msg::WelcomeTipsHeading => "نصائح للبدء:".into(),
        Msg::WelcomeTipModel => "تبديل النموذج النشط".into(),
        Msg::WelcomeTipProvider => "إضافة مزود مخصص".into(),
        Msg::WelcomeTipResume => "استئناف جلسة سابقة".into(),
        Msg::WelcomeTipSkills => "عرض المهارات المتاحة".into(),
        Msg::WelcomeTipPlugin => "إدارة الإضافات والأسواق".into(),
        Msg::WelcomeTipWebui => "تشغيل واجهة الويب في المتصفح".into(),
        Msg::WelcomeTipMcp => "التحقق من حالة خوادم MCP".into(),
        Msg::WelcomeTipPlan => "التبديل إلى وضع الخطة (Plan)".into(),
        Msg::WelcomeTipSession => "بدء جلسة جديدة".into(),
        Msg::WelcomeTipLoop => "إعداد مهمة دورية أو متكررة".into(),
        Msg::WelcomeTipGoal => "تفعيل وضع الأهداف".into(),
        Msg::WelcomeTipInit => "تهيئة تكوين المشروع".into(),
        Msg::WelcomeTipLanguage => "تغيير لغة العرض".into(),
        Msg::ProviderPanelTabAccounts => "الحسابات".into(),
        Msg::ProviderPanelTabModels => "النماذج".into(),
        Msg::ProviderPanelEmptyAccounts => "(لا يوجد مزودون — اضغط على Ctrl+A للإضافة)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(لا يوجد مزود مطابق)".into(),
        Msg::ProviderPanelEmptyModels => "(لا توجد نماذج — اضغط على Ctrl+A للإضافة)".into(),
        Msg::ProviderPanelNoMatchingModels => "(لا يوجد نموذج مطابق)".into(),
        Msg::ProviderPanelLegacyBadge => "قديم".into(),
        Msg::ProviderPanelDefaultBadge => "افتراضي".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} نماذج").into(),
        Msg::ProviderPanelAddModelRow => "+ إضافة نموذج".into(),
        Msg::ProviderPanelAddProviderRow => "+ إضافة مزود مخصص".into(),
        Msg::ProviderPanelAccountsHint =>
            "تصفية · ↑↓ تنقل · ↵ النماذج · Ctrl+A إضافة · Ctrl+E تعديل · Ctrl+Dx2 حذف · Tab تبديل · Esc إغلاق".into(),
        Msg::ProviderPanelModelsHint =>
            "تصفية · ↑↓ تنقل · ↵ افتراضي/إضافة · Ctrl+A إضافة وجلب القائمة · Ctrl+E تعديل · Ctrl+Dx2 حذف · Tab تبديل · Esc إغلاق".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ تنقل · ↵ افتراضي/إضافة · Ctrl+A إضافة · Ctrl+E تعديل · Ctrl+Dx2 حذف · Tab الكل · Esc إغلاق").into(),
        Msg::ProviderPanelModelSaved { model } => format!("تم حفظ النموذج \"{model}\".").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "يتم إرسال الصور مباشرة إلى هذا النموذج؛ عطل إدخال الصور لاستخدام VL.".into()
        }
        Msg::ProviderPanelAddTitle => "[إضافة مزود]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[تعديل الحساب {account}]").into(),
        Msg::ProviderPanelAddModelTitle => "[إضافة نموذج]".into(),
        Msg::ProviderPanelEditModelTitle => "[تعديل النموذج]".into(),
        Msg::ProviderPanelFieldVendor => "المزود".into(),
        Msg::ProviderPanelFieldAccount => "الحساب".into(),
        Msg::ProviderPanelFieldName => "الاسم".into(),
        Msg::ProviderPanelFieldProtocol => "البروتوكول".into(),
        Msg::ProviderPanelRequired => "(مطلوب)".into(),
        Msg::ProviderPanelLocked => "(مقفل)".into(),
        Msg::ProviderPanelFieldBaseUrl => "عنوان URL الأساسي".into(),
        Msg::ProviderPanelFieldApiKey => "مفتاح API".into(),
        Msg::ProviderPanelFieldModel => "النموذج".into(),
        Msg::ProviderPanelFieldWindow => "نافذة السياق".into(),
        Msg::ProviderPanelFieldSupportsVision => "هل يدعم الصور؟".into(),
        Msg::ProviderPanelVisionYes => "نعم [✓]  (إرسال صور base64)".into(),
        Msg::ProviderPanelVisionNo => "لا [ ]  (نص فقط)".into(),
        Msg::ProviderPanelFieldReasoningModel => "هل هو نموذج تفكير؟".into(),
        Msg::ProviderPanelReasoningYes => "نعم [✓]  (تضمين التفكير في السجل)".into(),
        Msg::ProviderPanelReasoningNo => "لا [ ]  (نموذج قياسي)".into(),
        Msg::ProviderPanelFieldMakeDefault => "تعيين كافتراضي".into(),
        Msg::ProviderPanelSwitchHint => "←→ تبديل".into(),
        Msg::ProviderPanelEnvHint { env } => format!("فارغ يستخدم ${env}").into(),
        Msg::ProviderPanelDefaultValue => "افتراضي".into(),
        Msg::ProviderPanelKeepOriginal => "فارغ للاحتفاظ بالقيمة الحالية".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab التالي  ←→ تغيير المزود  مسافة تبديل  ↵ حفظ  Esc رجوع".into(),
        Msg::ProviderPanelAccountFormHint => "Tab تبديل  ↵ حفظ  Esc رجوع".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab التالي  ←→ تغيير البروتوكول  ↵ حفظ  Esc رجوع  (الاسم مطلوب)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab التالي  ↵ حفظ  Esc رجوع  (البروتوكول مقفل)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab التالي  ←→ تغيير البروتوكول  ↵ حفظ  Esc رجوع".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(المزود غير مهيأ بعد)".into(),
        Msg::ProviderPanelModelFormHint =>
            "تصفية القائمة  ↑↓ تنقل  Tab/↵ ملء  ←→ الحساب  مسافة تبديل  Esc رجوع".into(),
        Msg::ProviderPanelModelPlaceholder => "(اكتب لتصفية القائمة)".into(),
        Msg::ProviderPanelUpstreamListLabel => "نماذج المزود".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ اختيار · Tab/↵ ملء".into(),
        Msg::ProviderPanelUpstreamLoading => "جارٍ التحميل…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("تم تحميل {n} نماذج · اكتب للتصفية · ↑↓ اختيار · Tab/↵ ملء").into(),
        Msg::ProviderPanelUpstreamEmpty => "القائمة فارغة — اكتب معرف النموذج مباشرة".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("فشل جلب القائمة ({error}) — اكتب معرف النموذج").into(),
        Msg::ProviderPanelUpstreamNoUrl => "لا يوجد عنوان URL — اكتب معرف النموذج".into(),
        Msg::ModelPickerNoModelsConfigured => "(لا توجد نماذج مجهزة — استخدم /provider للإضافة)".into(),
        Msg::ModelPickerNoModelsMatch => "(لا يوجد نموذج مطابق)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(لا توجد نماذج مطابقة لـ \"{query}\" — مسافة للخلف للمسح)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  تم التبديل إلى {provider} · {model} لهذه الجلسة\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  تم التبديل إلى {provider} · {model} وتعيينه كافتراضي للجلسات الجديدة\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ تم تغيير اللغة إلى {label} ({locale})\n").into(),
        Msg::CmdDescHelp => "عرض المساعدة والأوامر المتاحة".into(),
        Msg::CmdDescModel => "اختيار النموذج الحالي أو تغييره".into(),
        Msg::CmdDescProvider => "إدارة مزودي النماذج وحسابات API".into(),
        Msg::CmdDescQuit => "إنهاء JeikCode".into(),
        Msg::StreamStalled => "اضغط على esc للإلغاء".into(),
        Msg::CompactNothingShort => "(لا شيء لضغطه — المحادثة قصيرة)\n".into(),
        Msg::CompactStarting => "(جارٍ الضغط بملخص LLM...)\n".into(),
        Msg::CompactInterrupted => "(تمت مقاطعة الضغط — تغيّر coding runtime أو توقف)\n".into(),
        Msg::CompactUnavailableDuringSync => "لا يمكن الضغط أثناء المزامنة الحية؛ نفّذ /sync off أولاً".into(),
        Msg::CompactUnavailableDuringResync => "لا يمكن الضغط حتى يستعيد runtime المحلي آخر محادثة متزامنة".into(),
        Msg::LocalRuntimeRestorePending => "يقوم runtime المحلي باستعادة المحادثة المتزامنة؛ يُرجى الانتظار".into(),
        Msg::LocalRuntimeRestoreTimedOut => "انتهت مهلة استعادة runtime المحلي؛ تمت استعادة المزامنة الحية".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(لا شيء لضغطه — لن يوفّر tokens: {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("(تم الضغط — حُذفت {} رسائل، {} → {} tokens)\n", messages, before, after).into(),
        Msg::Compacting => "جارٍ الضغط…".into(),
        Msg::CompactingSlow => "جارٍ الضغط… (بطيء)".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("تم الضغط · تم تلخيص {} رسالة · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("تم طيّ مخرجات الأداة · توفير ~{} tok", saved).into(),
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("أعاد النموذج استجابة فارغة، ستتم إعادة المحاولة خلال {wait} ثانية ({attempt}/{max})…")
        } else {
            format!("أعاد النموذج استجابة فارغة، جارٍ إعادة المحاولة ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("أعاد النموذج التفكير فقط، ستتم إعادة المحاولة خلال {wait} ثانية ({attempt}/{max})…")
        } else {
            format!("أعاد النموذج التفكير فقط، جارٍ إعادة المحاولة ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("تنسيق الاستجابة غير صالح، ستتم إعادة المحاولة خلال {wait} ثانية ({attempt}/{max})…")
        } else {
            format!("تنسيق الاستجابة غير صالح، جارٍ إعادة المحاولة ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("استجابة النموذج بطيئة: لم تصل أي بيانات خلال {secs} ثانية، جارٍ إعادة المحاولة ({attempt}/{max})…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("خطأ API {reason}، ستتم إعادة المحاولة خلال {wait} ثانية ({attempt}/{max})…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "وصل الطلب (~{estimate_k}K tokens) إلى حد السياق (النافذة ~{window_k}K − الاحتياطي {buffer_k}K): اختصر الإدخال أو انتقل إلى نموذج بنافذة أكبر."
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("تجاوز السياق في الجولة {round} (المحاولة {attempt})؛ جارٍ الضغط وإعادة المحاولة").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("انتهت مهلة سكون البث — جارٍ إعادة الاتصال ({attempt}/{max})").into(),
        Msg::AgentResponseTruncated => "تم اقتطاع الاستجابة: finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("إصدار اللقطة {version} غير مدعوم (المدعوم {supported})؛ جارٍ البدء بجلسة فارغة").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("زمن استجابة النموذج مرتفع جدًا، يُرجى المحاولة لاحقًا ({retries} محاولات متتالية دون أول استجابة خلال {secs} ثانية)").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("أعاد النموذج استجابات غير قابلة للتحليل {max} مرات متتالية (عطل مؤقت من المزوّد). يمكنك إعادة المحاولة الآن أو لاحقًا.").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("أعاد النموذج التفكير فقط دون نص أو أدوات {max} مرات متتالية. يتجاوز هذا الطلب نافذة السياق — اختصر الإدخال أو استخدم /compact ثم أعد المحاولة.").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("أعاد النموذج التفكير فقط دون نص أو أدوات {max} مرات متتالية. الطلب الحالي ~{prompt_k}K tokens قريب من نافذة النموذج (~{window_k}K)؛ يُنصح باستخدام /compact أو اختصار الإدخال.").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("أعاد النموذج التفكير فقط دون نص أو أدوات {max} مرات متتالية. يمكنك إعادة المحاولة الآن أو لاحقًا.").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("أعاد النموذج استجابات فارغة {max} مرات متتالية. يتجاوز هذا الطلب نافذة السياق — اختصر الإدخال أو استخدم /compact ثم أعد المحاولة.").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("أعاد النموذج استجابات فارغة {max} مرات متتالية. الطلب الحالي ~{prompt_k}K tokens قريب من نافذة النموذج (~{window_k}K)؛ يُنصح باستخدام /compact أو اختصار الإدخال.").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("أعاد النموذج استجابات فارغة {max} مرات متتالية (عطل مؤقت من المزوّد لا يتعلق بطول السياق). يمكنك إعادة المحاولة الآن أو لاحقًا.").into(),
        Msg::AgentStatusRateLimited => "تم تجاوز حد معدل الطلبات أو نفاد الحصة".into(),
        Msg::AgentStatusUpstreamUnavailable => "الخدمة البعيدة غير متاحة مؤقتًا".into(),
        Msg::AgentStatusResponseTimeout => "انتهت مهلة استجابة النموذج".into(),
        Msg::AgentStatusConnectionFailed => "فشل الاتصال بالشبكة".into(),
        Msg::AgentStatusInsufficientBalance => "رصيد الحساب غير كافٍ".into(),
        Msg::AgentStatusUnauthorized => "مفتاح API غير مصرح به أو منتهي الصلاحية".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("انقطع اتصال الشبكة: أغلق المضيف البعيد الاتصال أو أعاد ضبطه وفشلت إعادة الاتصال بعد {attempts} محاولات. يمكنك إعادة المحاولة.").into(),
        Msg::StreamReadPartialResponse =>
            "انقطعت الاستجابة: تم الاحتفاظ بالجزء الآمن من الاستجابة ويمكنك المتابعة.".into(),
        Msg::StreamReadInterrupted =>
            "انقطع اتصال الشبكة: أغلق المضيف البعيد الاتصال أو أعاد ضبطه. يمكنك إعادة المحاولة.".into(),
        Msg::AgentAutoRetry { max } =>
            format!("انقطع الاتصال، جارٍ إعادة الاتصال تلقائيًا (حتى {max} محاولات) مع الاحتفاظ بالمخرجات الحالية…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("انقطع الاتصال مع الاحتفاظ بالمخرجات الحالية، إعادة المحاولة {attempt}/{max}").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("توقف البث بسبب انتهاء المهلة مع الاحتفاظ بالمخرجات الحالية، إعادة المحاولة {attempt}/{max}")
        } else {
            format!("توقف البث بسبب انتهاء المهلة، إعادة المحاولة {attempt}/{max}")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("انقطع اتصال الشبكة مع الاحتفاظ بالمخرجات الحالية، إعادة المحاولة {attempt}/{max}")
        } else {
            format!("انقطع اتصال الشبكة، إعادة المحاولة {attempt}/{max}")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("تمت استعادة الاتصال بعد {attempts} محاولة، جارٍ المتابعة").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "استمرت مهلة البث في الانتهاء بعد محاولات إعادة الاتصال التلقائي؛ تم إنهاء هذه الجولة".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("تم بلوغ حد المعدل، ستتم إعادة المحاولة تلقائيًا بعد {secs} ثانية…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "تم بلوغ حصة حد المعدل وتوقف التنفيذ مؤقتًا؛ انتظر إعادة التعيين أو بدّل النموذج للمتابعة".into()
        } else {
            format!("تم الإيقاف المؤقت بسبب حد المعدل: {detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "انتهت مهلة البث بعد استجابة جزئية؛ تم الاحتفاظ بالجزء المستلم ويمكنك المتابعة.".into(),
        Msg::StreamReadResetHint =>
            "يحدث هذا الخطأ غالبًا في شبكات الشركات أو بيئات الوكيل؛ يُرجى التحقق من إعدادات الوكيل أو VPN أو جدار الحماية.".into(),
        Msg::StreamReadDetailsPrefix => "التفاصيل: ".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "احتمال حلقة تكرار: تم رصد تكرار نفس المخرجات واستدعاءات الأدوات؛ يُطلب من النموذج تغيير المسار قبل إيقاف هذه الجولة.".into()
        } else {
            "احتمال حلقة تكرار: تم رصد تكرار نفس المخرجات واستدعاءات الأدوات؛ يُطلب من النموذج تغيير المسار.".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("تم الإيقاف: أعاد النموذج نفس نمط التفكير والنص واستدعاء الأدوات لمدة {rounds} جولات متتالية").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("احتمال حلقة أدوات: أعاد الاستدعاء نفسه أو دفعة القراءة فقط نفس النتيجة {threshold} مرات؛ يُطلب من النموذج تغيير المسار").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("تم اكتشاف حلقة أدوات: أعاد الاستدعاء نفسه أو دفعة القراءة فقط نفس النتيجة {threshold} مرات؛ تم الإيقاف قبل إرسال طلب جديد").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("تم الإيقاف: كرر النموذج نفس نمط استدعاءات الأدوات لمدة {rounds} جولات متتالية").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("تم بلوغ الحد الأقصى للجولات ({cap})؛ تم إيقاف استدعاء الأدوات لتلخيص التقدم والخطوات التالية.").into(),
        _ => super::en::en(msg),
    }
}
