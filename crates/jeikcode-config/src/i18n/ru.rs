use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn ru(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "Текущая сессия открыта для общего доступа (синхронизация с браузером)".into(),
        Msg::SessionModelRequired => "Модель не настроена: используйте /model или /provider для добавления перед началом диалога.".into(),
        Msg::ServerNoServices => "Службы JeikCode не установлены.".into(),
        Msg::WelcomeBannerLine1 => "Добро пожаловать в JeikCode — ваш ИИ-ассистент в терминале".into(),
        Msg::WelcomeBannerLine2 => "Введите вопрос или задачу для начала диалога. Введите / для списка команд.".into(),
        Msg::WelcomeOptionConfigureManually => "Настроить вручную".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "Указать API-ключ и адрес эндпоинта".into(),
        Msg::WelcomeOptionSkip => "Пропустить".into(),
        Msg::WelcomeOptionSkipHint => "Перейти в чат, настроить позже".into(),
        Msg::WelcomeTipsHeading => "С чего начать:".into(),
        Msg::WelcomeTipModel => "Переключить текущую модель".into(),
        Msg::WelcomeTipProvider => "Добавить кастомного провайдера".into(),
        Msg::WelcomeTipResume => "Открыть список прошлых сессий".into(),
        Msg::WelcomeTipSkills => "Список доступных навыков".into(),
        Msg::WelcomeTipPlugin => "Управление плагинами и каталогами".into(),
        Msg::WelcomeTipWebui => "Запустить веб-интерфейс в браузере".into(),
        Msg::WelcomeTipMcp => "Проверить статус MCP-серверов".into(),
        Msg::WelcomeTipPlan => "Режим планирования (Plan)".into(),
        Msg::WelcomeTipSession => "Начать новую сессию".into(),
        Msg::WelcomeTipLoop => "Настроить периодическую задачу".into(),
        Msg::WelcomeTipGoal => "Режим выполнения цели".into(),
        Msg::WelcomeTipInit => "Инициализировать конфигурацию проекта".into(),
        Msg::WelcomeTipLanguage => "Сменить язык интерфейса".into(),
        Msg::ProviderPanelTabAccounts => "Аккаунты".into(),
        Msg::ProviderPanelTabModels => "Модели".into(),
        Msg::ProviderPanelEmptyAccounts => "(Нет провайдеров — нажмите Ctrl+A для добавления)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(Провайдеры не найдены)".into(),
        Msg::ProviderPanelEmptyModels => "(Нет моделей — нажмите Ctrl+A для добавления)".into(),
        Msg::ProviderPanelNoMatchingModels => "(Модели не найдены)".into(),
        Msg::ProviderPanelLegacyBadge => "устар.".into(),
        Msg::ProviderPanelDefaultBadge => "по умолч.".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} мод.").into(),
        Msg::ProviderPanelAddModelRow => "+ Добавить модель".into(),
        Msg::ProviderPanelAddProviderRow => "+ Добавить кастомного провайдера".into(),
        Msg::ProviderPanelAccountsHint =>
            "Фильтр · ↑↓ выбор · ↵ модели · Ctrl+A добавить · Ctrl+E изменить · Ctrl+Dx2 удалить · Tab перекл. · Esc закрыть".into(),
        Msg::ProviderPanelModelsHint =>
            "Фильтр · ↑↓ выбор · ↵ по умолч./добавить · Ctrl+A добавить · Ctrl+E изменить · Ctrl+Dx2 удалить · Tab перекл. · Esc закрыть".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ выбор · ↵ по умолч. · Ctrl+A добавить · Ctrl+E изменить · Ctrl+Dx2 удалить · Tab все · Esc закрыть").into(),
        Msg::ProviderPanelModelSaved { model } => format!("Модель \"{model}\" сохранена.").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "Изображения отправляются напрямую в эту модель. Отключите ввод изображений для использования VL.".into()
        }
        Msg::ProviderPanelAddTitle => "[Добавить провайдера]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[Изменить аккаунт {account}]").into(),
        Msg::ProviderPanelAddModelTitle => "[Добавить модель]".into(),
        Msg::ProviderPanelEditModelTitle => "[Изменить модель]".into(),
        Msg::ProviderPanelFieldVendor => "Провайдер".into(),
        Msg::ProviderPanelFieldAccount => "Аккаунт".into(),
        Msg::ProviderPanelFieldName => "Имя".into(),
        Msg::ProviderPanelFieldProtocol => "Протокол".into(),
        Msg::ProviderPanelRequired => "(обязательно)".into(),
        Msg::ProviderPanelLocked => "(заблокировано)".into(),
        Msg::ProviderPanelFieldBaseUrl => "Base URL".into(),
        Msg::ProviderPanelFieldApiKey => "API-ключ".into(),
        Msg::ProviderPanelFieldModel => "Модель".into(),
        Msg::ProviderPanelFieldWindow => "Контекстное окно".into(),
        Msg::ProviderPanelFieldSupportsVision => "Поддержка изображений?".into(),
        Msg::ProviderPanelVisionYes => "Да [✓]  (отправка base64)".into(),
        Msg::ProviderPanelVisionNo => "Нет [ ]  (только текст)".into(),
        Msg::ProviderPanelFieldReasoningModel => "Модель рассуждений (thinking)?".into(),
        Msg::ProviderPanelReasoningYes => "Да [✓]  (выводить рассуждения в историю)".into(),
        Msg::ProviderPanelReasoningNo => "Нет [ ]  (обычная модель)".into(),
        Msg::ProviderPanelFieldMakeDefault => "Сделать по умолчанию".into(),
        Msg::ProviderPanelSwitchHint => "←→ переключить".into(),
        Msg::ProviderPanelEnvHint { env } => format!("пусто использует ${env}").into(),
        Msg::ProviderPanelDefaultValue => "по умолчанию".into(),
        Msg::ProviderPanelKeepOriginal => "оставьте пустым для сохранения значения".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab след.  ←→ провайдер  Пробел перекл.  ↵ Сохранить  Esc Назад".into(),
        Msg::ProviderPanelAccountFormHint => "Tab перекл.  ↵ Сохранить  Esc Назад".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab след.  ←→ протокол  ↵ Сохранить  Esc Назад  (Имя обязательно)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab след.  ↵ Сохранить  Esc Назад  (Протокол заблокирован)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab след.  ←→ протокол  ↵ Сохранить  Esc Назад".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(провайдер ещё не настроен)".into(),
        Msg::ProviderPanelModelFormHint =>
            "Фильтр списка  ↑↓ выбор  Tab/↵ ввод  ←→ аккаунт  Пробел перекл.  Esc назад".into(),
        Msg::ProviderPanelModelPlaceholder => "(введите для фильтрации моделей)".into(),
        Msg::ProviderPanelUpstreamListLabel => "Модели провайдера".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ выбор · Tab/↵ ввод".into(),
        Msg::ProviderPanelUpstreamLoading => "загрузка…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("Загружено {n} моделей · ↑↓ выбор · Tab/↵ ввод").into(),
        Msg::ProviderPanelUpstreamEmpty => "Список моделей пуст — введите ID вручную".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("Ошибка получения списка ({error}) — введите ID вручную").into(),
        Msg::ProviderPanelUpstreamNoUrl => "Нет адреса эндпоинта — введите ID вручную".into(),
        Msg::ModelPickerNoModelsConfigured => "(модели не настроены — добавьте через /provider)".into(),
        Msg::ModelPickerNoModelsMatch => "(нет совпадений)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(нет моделей по запросу \"{query}\" — Backspace для очистки)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  Переключено на {provider} · {model} для текущей сессии\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  Переключено на {provider} · {model} и установлено по умолчанию\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ Язык изменён на {label} ({locale})\n").into(),
        Msg::CmdDescHelp => "Показать справку и доступные команды".into(),
        Msg::CmdDescModel => "Выбрать или сменить текущую модель".into(),
        Msg::CmdDescProvider => "Управление провайдерами и аккаунтами API".into(),
        Msg::CmdDescQuit => "Выйти из JeikCode".into(),
        Msg::StreamStalled => "нажмите esc для отмены".into(),
        Msg::CompactNothingShort => "(нечего сжимать — разговор короткий)\n".into(),
        Msg::CompactStarting => "(сжатие с помощью LLM-сводки...)\n".into(),
        Msg::CompactInterrupted => "(сжатие прервано — coding runtime изменился или остановлен)\n".into(),
        Msg::CompactUnavailableDuringSync => "Нельзя сжимать при активной live-синхронизации; сначала выполните /sync off".into(),
        Msg::CompactUnavailableDuringResync => "Нельзя сжимать, пока локальный runtime не восстановит последний синхронизированный диалог".into(),
        Msg::LocalRuntimeRestorePending => "Локальный runtime восстанавливает синхронизированный диалог; подождите".into(),
        Msg::LocalRuntimeRestoreTimedOut => "Восстановление локального runtime истекло по времени; Live-синхронизация восстановлена".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(нечего сжимать — экономии токенов не будет: {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("(сжато — удалено {} сообщений, {} → {} tokens)\n", messages, before, after).into(),
        Msg::Compacting => "Сжатие…".into(),
        Msg::CompactingSlow => "Сжатие… (медленно)".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("Сжато · {} сообщ. суммировано · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("Вывод инструментов свёрнут · сэкономлено ~{} tok", saved).into(),
        _ => super::en::en(msg),
    }
}
