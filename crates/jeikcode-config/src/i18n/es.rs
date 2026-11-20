use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn es(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "Sesión compartida (sincronización en tiempo real con el navegador)".into(),
        Msg::SessionModelRequired => "Ningún modelo configurado: use /model o /provider para añadir un modelo antes de chatear.".into(),
        Msg::ServerNoServices => "No hay servicios de JeikCode instalados.".into(),
        Msg::WelcomeBannerLine1 => "Bienvenido a JeikCode — su asistente de programación IA en terminal".into(),
        Msg::WelcomeBannerLine2 => "Escriba una pregunta o tarea para comenzar. Escriba / para ver la lista de comandos.".into(),
        Msg::WelcomeOptionConfigureManually => "Configurar manualmente".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "Introducir clave API y URL personalizada".into(),
        Msg::WelcomeOptionSkip => "Omitir por ahora".into(),
        Msg::WelcomeOptionSkipHint => "Ir directamente al chat, configurar más tarde".into(),
        Msg::WelcomeTipsHeading => "Consejos para empezar:".into(),
        Msg::WelcomeTipModel => "Cambiar de modelo activo".into(),
        Msg::WelcomeTipProvider => "Añadir un proveedor personalizado".into(),
        Msg::WelcomeTipResume => "Ver y reanudar sesiones anteriores".into(),
        Msg::WelcomeTipSkills => "Ver habilidades disponibles".into(),
        Msg::WelcomeTipPlugin => "Administrar complementos y marketplaces".into(),
        Msg::WelcomeTipWebui => "Iniciar la interfaz web en el navegador".into(),
        Msg::WelcomeTipMcp => "Ver estado de los servidores MCP".into(),
        Msg::WelcomeTipPlan => "Cambiar o ver modo Plan".into(),
        Msg::WelcomeTipSession => "Iniciar una nueva sesión".into(),
        Msg::WelcomeTipLoop => "Configurar una tarea periódica".into(),
        Msg::WelcomeTipGoal => "Activar modo orientado a objetivos".into(),
        Msg::WelcomeTipInit => "Inicializar configuración del proyecto".into(),
        Msg::WelcomeTipLanguage => "Cambiar idioma de la interfaz".into(),
        Msg::ProviderPanelTabAccounts => "Cuentas".into(),
        Msg::ProviderPanelTabModels => "Modelos".into(),
        Msg::ProviderPanelEmptyAccounts => "(Sin proveedores — presione Ctrl+A para añadir uno)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(No se encontraron proveedores coincidentes)".into(),
        Msg::ProviderPanelEmptyModels => "(Sin modelos — presione Ctrl+A para añadir uno)".into(),
        Msg::ProviderPanelNoMatchingModels => "(No se encontraron modelos coincidentes)".into(),
        Msg::ProviderPanelLegacyBadge => "heredado".into(),
        Msg::ProviderPanelDefaultBadge => "predeterminado".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} modelo{}", if count == 1 { "" } else { "s" }).into(),
        Msg::ProviderPanelAddModelRow => "+ Añadir modelo".into(),
        Msg::ProviderPanelAddProviderRow => "+ Añadir proveedor personalizado".into(),
        Msg::ProviderPanelAccountsHint =>
            "Filtrar · ↑↓ seleccionar · ↵ modelos · Ctrl+A añadir · Ctrl+E editar · Ctrl+Dx2 eliminar · Tab cambiar · Esc cerrar".into(),
        Msg::ProviderPanelModelsHint =>
            "Filtrar · ↑↓ seleccionar · ↵ pred./añadir · Ctrl+A añadir + obtener lista · Ctrl+E editar · Ctrl+Dx2 eliminar · Tab cambiar · Esc cerrar".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ seleccionar · ↵ pred./añadir · Ctrl+A añadir · Ctrl+E editar · Ctrl+Dx2 eliminar · Tab todos · Esc cerrar").into(),
        Msg::ProviderPanelModelSaved { model } => format!("Modelo \"{model}\" guardado.").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "Las imágenes se envían directamente a este modelo; desactive la entrada de imágenes para usar VL.".into()
        }
        Msg::ProviderPanelAddTitle => "[Añadir proveedor]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[Editar cuenta {account}]").into(),
        Msg::ProviderPanelAddModelTitle => "[Añadir modelo]".into(),
        Msg::ProviderPanelEditModelTitle => "[Editar modelo]".into(),
        Msg::ProviderPanelFieldVendor => "Proveedor".into(),
        Msg::ProviderPanelFieldAccount => "Cuenta".into(),
        Msg::ProviderPanelFieldName => "Nombre".into(),
        Msg::ProviderPanelFieldProtocol => "Protocolo".into(),
        Msg::ProviderPanelRequired => "(obligatorio)".into(),
        Msg::ProviderPanelLocked => "(bloqueado)".into(),
        Msg::ProviderPanelFieldBaseUrl => "URL base".into(),
        Msg::ProviderPanelFieldApiKey => "Clave API".into(),
        Msg::ProviderPanelFieldModel => "Modelo".into(),
        Msg::ProviderPanelFieldWindow => "Ventana de contexto".into(),
        Msg::ProviderPanelFieldSupportsVision => "¿Soporta imágenes?".into(),
        Msg::ProviderPanelVisionYes => "Sí [✓]  (enviar imágenes base64)".into(),
        Msg::ProviderPanelVisionNo => "No [ ]  (solo texto)".into(),
        Msg::ProviderPanelFieldReasoningModel => "¿Es modelo de razonamiento (thinking)?".into(),
        Msg::ProviderPanelReasoningYes => "Sí [✓]  (incluir razonamiento en historial)".into(),
        Msg::ProviderPanelReasoningNo => "No [ ]  (modelo estándar)".into(),
        Msg::ProviderPanelFieldMakeDefault => "Establecer como predeterminado".into(),
        Msg::ProviderPanelSwitchHint => "←→ cambiar".into(),
        Msg::ProviderPanelEnvHint { env } => format!("en blanco usa ${env}").into(),
        Msg::ProviderPanelDefaultValue => "predeterminado".into(),
        Msg::ProviderPanelKeepOriginal => "en blanco conserva el valor actual".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab Siguiente  ←→ Cambiar proveedor  Espacio Alternar  ↵ Guardar  Esc Volver".into(),
        Msg::ProviderPanelAccountFormHint => "Tab Cambiar  ↵ Guardar  Esc Volver".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab Siguiente  ←→ Cambiar protocolo  ↵ Guardar  Esc Volver  (Nombre obligatorio)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab Siguiente  ↵ Guardar  Esc Volver  (Protocolo bloqueado)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab Siguiente  ←→ Cambiar protocolo  ↵ Guardar  Esc Volver".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(proveedor aún no configurado)".into(),
        Msg::ProviderPanelModelFormHint =>
            "Filtrar lista  ↑↓ seleccionar  Tab/↵ rellenar  ←→ cuenta  Espacio alternar  Esc volver".into(),
        Msg::ProviderPanelModelPlaceholder => "(escriba para filtrar lista)".into(),
        Msg::ProviderPanelUpstreamListLabel => "Modelos del proveedor".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ elegir · Tab/↵ rellenar".into(),
        Msg::ProviderPanelUpstreamLoading => "cargando…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("{n} modelos cargados · escriba para filtrar · ↑↓ elegir · Tab/↵ rellenar").into(),
        Msg::ProviderPanelUpstreamEmpty => "Catálogo vacío — escriba el ID del modelo".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("Error al obtener lista ({error}) — escriba el ID del modelo").into(),
        Msg::ProviderPanelUpstreamNoUrl => "Sin URL del proveedor — escriba el ID del modelo".into(),
        Msg::ModelPickerNoModelsConfigured => "(sin modelos configurados — use /provider para añadir)".into(),
        Msg::ModelPickerNoModelsMatch => "(ningún modelo coincide)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(ningún modelo coincide con \"{query}\" — Retroceso para borrar)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  Cambiado a {provider} · {model} para esta sesión\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  Cambiado a {provider} · {model}; establecido como predeterminado para nuevas sesiones\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ Idioma cambiado a {label} ({locale})\n").into(),
        Msg::CmdDescHelp => "Mostrar ayuda y comandos disponibles".into(),
        Msg::CmdDescModel => "Seleccionar o cambiar el modelo actual".into(),
        Msg::CmdDescProvider => "Gestionar proveedores y cuentas de API".into(),
        Msg::CmdDescQuit => "Salir de JeikCode".into(),
        Msg::StreamStalled => "presione esc para cancelar".into(),
        Msg::CompactNothingShort => "(nada que compactar — la conversación es corta)\n".into(),
        Msg::CompactStarting => "(compactando con resumen LLM...)\n".into(),
        Msg::CompactInterrupted => "(compactación interrumpida — el coding runtime cambió o se detuvo)\n".into(),
        Msg::CompactUnavailableDuringSync => "No se puede compactar durante la sincronización live; ejecuta /sync off primero".into(),
        Msg::CompactUnavailableDuringResync => "No se puede compactar hasta que el runtime local restaure la última conversación sincronizada".into(),
        Msg::LocalRuntimeRestorePending => "El runtime local está restaurando la conversación sincronizada; espera".into(),
        Msg::LocalRuntimeRestoreTimedOut => "La restauración del runtime local agotó el tiempo; se restauró la sincronización Live".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(nada que compactar — no ahorraría tokens: {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("(compactado — {} mensajes descartados, {} → {} tokens)\n", messages, before, after).into(),
        Msg::Compacting => "Compactando…".into(),
        Msg::CompactingSlow => "Compactando… (lento)".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("Compactado · {} mensaje(s) resumido(s) · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("Salida de herramienta plegada · ~{} tok ahorrados", saved).into(),
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("El modelo devolvió una respuesta vacía, reintentando en {wait}s ({attempt}/{max})…")
        } else {
            format!("El modelo devolvió una respuesta vacía, reintentando ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("El modelo solo devolvió razonamiento, reintentando en {wait}s ({attempt}/{max})…")
        } else {
            format!("El modelo solo devolvió razonamiento, reintentando ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("Respuesta con formato inválido, reintentando en {wait}s ({attempt}/{max})…")
        } else {
            format!("Respuesta con formato inválido, reintentando ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("Modelo lento: sin respuesta en {secs}s, reintentando ({attempt}/{max})…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("Error de API {reason}, reintentando en {wait}s ({attempt}/{max})…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "La solicitud (~{estimate_k}K tokens) alcanzó el límite de contexto (ventana ~{window_k}K − margen {buffer_k}K): reduce la entrada o cambia a un modelo con mayor ventana."
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("Desbordamiento de contexto en la ronda {round} (intento {attempt}); compactando y reintentando").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("Tiempo de espera inactivo del flujo — reconectando ({attempt}/{max})").into(),
        Msg::AgentResponseTruncated => "Respuesta truncada: finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("Versión de instantánea {version} no compatible (compatible: {supported}); iniciando sesión vacía").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("La latencia del modelo es demasiado alta, inténtalo más tarde ({retries} intentos consecutivos sin respuesta inicial en {secs}s)").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("El modelo devolvió respuestas no analizables {max} veces seguidas (fallo puntual del proveedor). Puedes reintentar ahora o más tarde.").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("El modelo solo devolvió razonamiento sin texto ni herramientas {max} veces seguidas. Esta solicitud supera la ventana de contexto; reduce la entrada o usa /compact y reintenta.").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("El modelo solo devolvió razonamiento sin texto ni herramientas {max} veces seguidas. La solicitud (~{prompt_k}K tokens) se acerca o supera la ventana (~{window_k}K); prueba /compact o reduce la entrada.").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("El modelo solo devolvió razonamiento sin texto ni herramientas {max} veces seguidas. Puedes reintentar ahora o más tarde.").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("El modelo devolvió respuestas vacías {max} veces seguidas. Esta solicitud supera la ventana de contexto; reduce la entrada o usa /compact y reintenta.").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("El modelo devolvió respuestas vacías {max} veces seguidas. La solicitud (~{prompt_k}K tokens) se acerca o supera la ventana (~{window_k}K); prueba /compact o reduce la entrada.").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("El modelo devolvió respuestas vacías {max} veces seguidas (fallo puntual del proveedor, sin relación con la longitud del contexto). Puedes reintentar ahora o más tarde.").into(),
        Msg::AgentStatusRateLimited => "Límite de frecuencia superado o cuota agotada".into(),
        Msg::AgentStatusUpstreamUnavailable => "Servicio remoto temporalmente no disponible".into(),
        Msg::AgentStatusResponseTimeout => "Tiempo de espera de respuesta del modelo agotado".into(),
        Msg::AgentStatusConnectionFailed => "Error de conexión de red".into(),
        Msg::AgentStatusInsufficientBalance => "Saldo de cuenta insuficiente".into(),
        Msg::AgentStatusUnauthorized => "Clave API no autorizada o caducada".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("Conexión de red interrumpida: el servidor remoto cerró o reinició la conexión y falló tras {attempts} reconexiones automáticas. Puedes reintentar.").into(),
        Msg::StreamReadPartialResponse =>
            "Respuesta interrumpida: se conservó la parte segura de la respuesta, puedes continuar.".into(),
        Msg::StreamReadInterrupted =>
            "Conexión de red interrumpida: el servidor remoto cerró o reinició la conexión. Puedes reintentar.".into(),
        Msg::AgentAutoRetry { max } =>
            format!("Conexión perdida, reconectando automáticamente (hasta {max} intentos), salida actual conservada…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("Conexión interrumpida, salida actual conservada, reintento {attempt}/{max}").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("Flujo detenido por inactividad, salida conservada, reintento {attempt}/{max}")
        } else {
            format!("Flujo detenido por inactividad, reintento {attempt}/{max}")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("Conexión de red caída, salida conservada, reintento {attempt}/{max}")
        } else {
            format!("Conexión de red caída, reintento {attempt}/{max}")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("Conexión restablecida tras {attempts} reintento(s), continuando").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "El flujo volvió a agotar el tiempo de espera tras las reconexiones automáticas; turno detenido".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("Límite de velocidad alcanzado, reintento automático en {secs}s…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "Límite de velocidad alcanzado; en pausa hasta que se restablezca o cambies de modelo".into()
        } else {
            format!("En pausa por límite de velocidad: {detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "Tiempo de espera del flujo agotado tras respuesta parcial; se conservó lo recibido y puedes continuar.".into(),
        Msg::StreamReadResetHint =>
            "Este error es común en redes corporativas o con proxy; revisa la configuración de proxy, VPN y cortafuegos.".into(),
        Msg::StreamReadDetailsPrefix => "Detalles: ".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "Posible bucle de repetición: se detectó el mismo patrón de salida y llamadas a herramientas; pidiendo al modelo que cambie de rumbo antes de detener el turno.".into()
        } else {
            "Posible bucle de repetición: se detectó el mismo patrón de salida y llamadas a herramientas; pidiendo al modelo que cambie de rumbo.".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("detenido: el modelo reprodujo el mismo patrón de razonamiento, texto y llamadas a herramientas durante {rounds} rondas consecutivas").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("posible bucle de herramientas: la misma llamada o lote de solo lectura devolvió los mismos resultados {threshold} veces; pidiendo al modelo que cambie de rumbo").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("bucle de herramientas detectado: la misma llamada o lote de solo lectura devolvió los mismos resultados {threshold} veces; deteniendo antes de otra solicitud").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("detenido: el modelo repitió el mismo patrón de llamadas a herramientas durante {rounds} rondas consecutivas").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("Se alcanzó el límite de rondas ({cap}); se detuvo la ejecución de herramientas para resumir el progreso y los siguientes pasos.").into(),
        _ => super::en::en(msg),
    }
}
