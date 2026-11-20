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
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("Модель вернула пустой ответ, повтор через {wait}с ({attempt}/{max})…")
        } else {
            format!("Модель вернула пустой ответ, повторная попытка ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("Модель вернула только размышления, повтор через {wait}с ({attempt}/{max})…")
        } else {
            format!("Модель вернула только размышления, повторная попытка ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("Некорректный формат ответа, повтор через {wait}с ({attempt}/{max})…")
        } else {
            format!("Некорректный формат ответа, повторная попытка ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("Высокая задержка модели: нет ответа в течение {secs}с, повтор ({attempt}/{max})…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("Ошибка API {reason}, повтор через {wait}с ({attempt}/{max})…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "Запрос ~{estimate_k}K tokens достиг порога контекста (окно ~{window_k}K − запас {buffer_k}K): сократите ввод или выберите модель с большим окном."
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("Переполнение контекста на раунде {round} (попытка {attempt}); выполняется сжатие и повтор").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("Тайм-аут простоя потока — переподключение ({attempt}/{max})").into(),
        Msg::AgentResponseTruncated => "Ответ обрезан по лимиту длины: finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("Неподдерживаемая версия снимка {version} (поддерживается {supported}); запуск с пустой сессией").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("Слишком высокая задержка модели, попробуйте позже ({retries} попыток подряд без первого токена за {secs}с)").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("Модель {max} раз подряд вернула нечитаемый ответ (временный сбой сервера). Можно повторить сразу или позже.").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("Модель {max} раз подряд вернула только размышления без текста и вызовов инструментов. Запрос превышает контекстное окно — сократите ввод или выполните /compact.").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("Модель {max} раз подряд вернула только размышления без текста и вызовов инструментов. Текущий запрос ~{prompt_k}K tokens близок к лимиту окна (~{window_k}K); выполните /compact или сократите ввод.").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("Модель {max} раз подряд вернула только размышления без текста и вызовов инструментов. Можно повторить сразу или позже.").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("Модель {max} раз подряд вернула пустой ответ. Запрос превышает контекстное окно — сократите ввод или выполните /compact.").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("Модель {max} раз подряд вернула пустой ответ. Текущий запрос ~{prompt_k}K tokens близок к лимиту окна (~{window_k}K); выполните /compact или сократите ввод.").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("Модель {max} раз подряд вернула пустой ответ (временный сбой сервера, не связанный с длиной контекста). Можно повторить сразу или позже.").into(),
        Msg::AgentStatusRateLimited => "Превышен лимит частоты запросов или исчерпана квота".into(),
        Msg::AgentStatusUpstreamUnavailable => "Вышестоящий сервис временно недоступен".into(),
        Msg::AgentStatusResponseTimeout => "Время ожидания ответа модели истекло".into(),
        Msg::AgentStatusConnectionFailed => "Сбой сетевого подключения".into(),
        Msg::AgentStatusInsufficientBalance => "Недостаточно средств на счёте".into(),
        Msg::AgentStatusUnauthorized => "Ключ API не авторизован или истёк".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("Сетевое соединение прервано: удалённый узел закрыл или сбросил соединение, не удалось переподключиться за {attempts} попыток. Можно повторить.").into(),
        Msg::StreamReadPartialResponse =>
            "Ответ прерван: безопасная часть ответа сохранена, можно продолжить.".into(),
        Msg::StreamReadInterrupted =>
            "Сетевое соединение прервано: удалённый узел закрыл или сбросил соединение. Можно повторить.".into(),
        Msg::AgentAutoRetry { max } =>
            format!("Соединение прервано, выполняется автоматическое переподключение (до {max} попыток), текущий вывод сохранён…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("Соединение прервано, текущий вывод сохранён, повтор {attempt}/{max}").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("Поток завис по тайм-ауту, текущий вывод сохранён, повтор {attempt}/{max}")
        } else {
            format!("Поток завис по тайм-ауту, повтор {attempt}/{max}")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("Сетевое соединение прервано, текущий вывод сохранён, повтор {attempt}/{max}")
        } else {
            format!("Сетевое соединение прервано, повтор {attempt}/{max}")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("Соединение восстановлено после {attempts} повторов, продолжаем").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "Ответ потока по-прежнему превышает тайм-аут после автоматических переподключений; ход завершён".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("Сработало ограничение частоты, автоповтор через {secs}с…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "Достигнут лимит запросов, выполнение приостановлено; дождитесь сброса или переключите модель".into()
        } else {
            format!("Приостановлено из-за лимита запросов: {detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "Тайм-аут потока после частичного ответа; полученная часть сохранена, можно продолжить.".into(),
        Msg::StreamReadResetHint =>
            "Эта ошибка часто возникает в корпоративных сетях или при использовании прокси; проверьте настройки прокси, VPN и брандмауэра.".into(),
        Msg::StreamReadDetailsPrefix => "Подробности: ".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "Возможный цикл повторов: обнаружен повторяющийся шаблон вывода и вызовов инструментов; модели предложено сменить курс перед остановкой хода.".into()
        } else {
            "Возможный цикл повторов: обнаружен повторяющийся шаблон вывода и вызовов инструментов; модели предложено сменить курс.".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("остановлено: модель воспроизводила один и тот же шаблон рассуждений, текста и вызовов инструментов {rounds} раундов подряд").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("возможен цикл инструментов: один и тот же вызов или пакет только для чтения вернул одинаковый результат {threshold} раз(а); модели предложено сменить курс").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("обнаружен цикл инструментов: один и тот же вызов или пакет только для чтения вернул одинаковый результат {threshold} раз(а); остановка до следующего запроса").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("остановлено: модель повторяла один и тот же шаблон вызовов инструментов {rounds} раундов подряд").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("Достигнут лимит раундов ({cap}); вызовы инструментов остановлены для подведения итогов и следующих шагов.").into(),
        _ => super::en::en(msg),
    }
}
