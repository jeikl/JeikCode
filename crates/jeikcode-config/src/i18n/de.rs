use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn de(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "Aktuelle Sitzung freigegeben (Echtzeit-Synchronisierung mit dem Browser)".into(),
        Msg::SessionModelRequired => "Kein Modell konfiguriert: Verwenden Sie /model oder /provider, um vor dem Chat ein Modell hinzuzufügen.".into(),
        Msg::ServerNoServices => "Keine JeikCode-Hostdienste installiert.".into(),
        Msg::WelcomeBannerLine1 => "Willkommen bei JeikCode — Ihrem Terminal-KI-Programmierassistenten".into(),
        Msg::WelcomeBannerLine2 => "Geben Sie eine Frage oder Aufgabe ein, um zu beginnen. Geben Sie / für Befehle ein.".into(),
        Msg::WelcomeOptionConfigureManually => "Manuell konfigurieren".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "API-Schlüssel und benutzerdefinierte URL eingeben".into(),
        Msg::WelcomeOptionSkip => "Vorerst überspringen".into(),
        Msg::WelcomeOptionSkipHint => "Direkt zum Chat, später konfigurieren".into(),
        Msg::WelcomeTipsHeading => "Erste Schritte:".into(),
        Msg::WelcomeTipModel => "Aktives Modell wechseln".into(),
        Msg::WelcomeTipProvider => "Benutzerdefinierten Anbieter hinzufügen".into(),
        Msg::WelcomeTipResume => "Frühere Sitzungen anzeigen und fortsetzen".into(),
        Msg::WelcomeTipSkills => "Verfügbare Skills anzeigen".into(),
        Msg::WelcomeTipPlugin => "Plugins und Marktplätze verwalten".into(),
        Msg::WelcomeTipWebui => "Web-UI im Browser starten".into(),
        Msg::WelcomeTipMcp => "Status der MCP-Server prüfen".into(),
        Msg::WelcomeTipPlan => "Plan-Modus umschalten".into(),
        Msg::WelcomeTipSession => "Neue Sitzung starten".into(),
        Msg::WelcomeTipLoop => "Wiederkehrende Aufgabe einrichten".into(),
        Msg::WelcomeTipGoal => "Zielorientierten Modus aktivieren".into(),
        Msg::WelcomeTipInit => "Projektkonfiguration initialisieren".into(),
        Msg::WelcomeTipLanguage => "Anzeigesprache ändern".into(),
        Msg::ProviderPanelTabAccounts => "Konten".into(),
        Msg::ProviderPanelTabModels => "Modelle".into(),
        Msg::ProviderPanelEmptyAccounts => "(Keine Anbieter — drücken Sie Strg+A zum Hinzufügen)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(Keine passenden Anbieter)".into(),
        Msg::ProviderPanelEmptyModels => "(Keine Modelle — drücken Sie Strg+A zum Hinzufügen)".into(),
        Msg::ProviderPanelNoMatchingModels => "(Keine passenden Modelle)".into(),
        Msg::ProviderPanelLegacyBadge => "Legacy".into(),
        Msg::ProviderPanelDefaultBadge => "Standard".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} Modell{}", if count == 1 { "" } else { "e" }).into(),
        Msg::ProviderPanelAddModelRow => "+ Modell hinzufügen".into(),
        Msg::ProviderPanelAddProviderRow => "+ Benutzerdefinierten Anbieter hinzufügen".into(),
        Msg::ProviderPanelAccountsHint =>
            "Filter · ↑↓ auswählen · ↵ Modelle · Strg+A hinzufügen · Strg+E bearbeiten · Strg+Dx2 löschen · Tab wechseln · Esc schließen".into(),
        Msg::ProviderPanelModelsHint =>
            "Filter · ↑↓ auswählen · ↵ Standard/hinzufügen · Strg+A hinzufügen + abrufen · Strg+E bearbeiten · Strg+Dx2 löschen · Tab wechseln · Esc schließen".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ auswählen · ↵ Standard/hinzufügen · Strg+A hinzufügen · Strg+E bearbeiten · Strg+Dx2 löschen · Tab alle · Esc schließen").into(),
        Msg::ProviderPanelModelSaved { model } => format!("Modell \"{model}\" gespeichert.").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "Bilder gehen direkt an dieses Modell; deaktivieren Sie die Bildeingabe, um VL zu nutzen.".into()
        }
        Msg::ProviderPanelAddTitle => "[Anbieter hinzufügen]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[Konto {account} bearbeiten]").into(),
        Msg::ProviderPanelAddModelTitle => "[Modell hinzufügen]".into(),
        Msg::ProviderPanelEditModelTitle => "[Modell bearbeiten]".into(),
        Msg::ProviderPanelFieldVendor => "Anbieter".into(),
        Msg::ProviderPanelFieldAccount => "Konto".into(),
        Msg::ProviderPanelFieldName => "Name".into(),
        Msg::ProviderPanelFieldProtocol => "Protokoll".into(),
        Msg::ProviderPanelRequired => "(erforderlich)".into(),
        Msg::ProviderPanelLocked => "(gesperrt)".into(),
        Msg::ProviderPanelFieldBaseUrl => "Basis-URL".into(),
        Msg::ProviderPanelFieldApiKey => "API-Schlüssel".into(),
        Msg::ProviderPanelFieldModel => "Modell".into(),
        Msg::ProviderPanelFieldWindow => "Kontextfenster".into(),
        Msg::ProviderPanelFieldSupportsVision => "Bildeingabe unterstützen?".into(),
        Msg::ProviderPanelVisionYes => "Ja [✓]  (Base64-Bilder senden)".into(),
        Msg::ProviderPanelVisionNo => "Nein [ ]  (nur Text)".into(),
        Msg::ProviderPanelFieldReasoningModel => "Denkmodell (Thinking)?".into(),
        Msg::ProviderPanelReasoningYes => "Ja [✓]  (Gedankengang im Verlauf anzeigen)".into(),
        Msg::ProviderPanelReasoningNo => "Nein [ ]  (Standardmodell)".into(),
        Msg::ProviderPanelFieldMakeDefault => "Als Standard festlegen".into(),
        Msg::ProviderPanelSwitchHint => "←→ wechseln".into(),
        Msg::ProviderPanelEnvHint { env } => format!("leer verwendet ${env}").into(),
        Msg::ProviderPanelDefaultValue => "Standard".into(),
        Msg::ProviderPanelKeepOriginal => "leer behält aktuellen Wert bei".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab Weiter  ←→ Anbieter wechseln  Leertaste Umschalten  ↵ Speichern  Esc Zurück".into(),
        Msg::ProviderPanelAccountFormHint => "Tab Wechseln  ↵ Speichern  Esc Zurück".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab Weiter  ←→ Protokoll wechseln  ↵ Speichern  Esc Zurück  (Name erforderlich)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab Weiter  ↵ Speichern  Esc Zurück  (Protokoll gesperrt)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab Weiter  ←→ Protokoll wechseln  ↵ Speichern  Esc Zurück".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(Anbieter noch nicht konfiguriert)".into(),
        Msg::ProviderPanelModelFormHint =>
            "Liste filtern  ↑↓ auswählen  Tab/↵ einfügen  ←→ Konto  Leertaste umschalten  Esc zurück".into(),
        Msg::ProviderPanelModelPlaceholder => "(tippen, um Liste zu filtern)".into(),
        Msg::ProviderPanelUpstreamListLabel => "Verfügbare Modelle".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ wählen · Tab/↵ einfügen".into(),
        Msg::ProviderPanelUpstreamLoading => "wird geladen…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("{n} Modelle geladen · tippen zum Filtern · ↑↓ wählen · Tab/↵ einfügen").into(),
        Msg::ProviderPanelUpstreamEmpty => "Katalog leer — Modell-ID direkt eingeben".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("Fehler beim Abrufen ({error}) — Modell-ID eingeben").into(),
        Msg::ProviderPanelUpstreamNoUrl => "Keine URL vorhanden — Modell-ID eingeben".into(),
        Msg::ModelPickerNoModelsConfigured => "(keine Modelle konfiguriert — mit /provider hinzufügen)".into(),
        Msg::ModelPickerNoModelsMatch => "(keine übereinstimmenden Modelle)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(keine Modelle für \"{query}\" gefunden — Rücktaste zum Löschen)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  Zu {provider} · {model} für diese Sitzung gewechselt\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  Zu {provider} · {model} gewechselt und als Standard für neue Sitzungen festgelegt\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ Sprache zu {label} ({locale}) gewechselt\n").into(),
        Msg::CmdDescHelp => "Hilfe und verfügbare Befehle anzeigen".into(),
        Msg::CmdDescModel => "Aktuelles Modell auswählen oder wechseln".into(),
        Msg::CmdDescProvider => "Modellanbieter und API-Konten verwalten".into(),
        Msg::CmdDescQuit => "JeikCode beenden".into(),
        Msg::StreamStalled => "Esc zum Abbrechen drücken".into(),
        Msg::CompactNothingShort => "(nichts zu komprimieren — Unterhaltung ist kurz)\n".into(),
        Msg::CompactStarting => "(Komprimierung mit LLM-Zusammenfassung...)\n".into(),
        Msg::CompactInterrupted => "(Komprimierung unterbrochen — die coding runtime wurde geändert oder gestoppt)\n".into(),
        Msg::CompactUnavailableDuringSync => "Während der Live-Synchronisierung kann nicht komprimiert werden; führe zuerst /sync off aus".into(),
        Msg::CompactUnavailableDuringResync => "Komprimieren ist erst möglich, wenn die lokale Runtime die zuletzt synchronisierte Unterhaltung wiederhergestellt hat".into(),
        Msg::LocalRuntimeRestorePending => "Die lokale Runtime stellt die synchronisierte Unterhaltung wieder her; bitte warten".into(),
        Msg::LocalRuntimeRestoreTimedOut => "Zeitüberschreitung bei der Wiederherstellung der lokalen Runtime; Live-Synchronisierung wiederhergestellt".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(nichts zu komprimieren — würde keine Tokens sparen: {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("(komprimiert — {} Nachrichten verworfen, {} → {} tokens)\n", messages, before, after).into(),
        Msg::Compacting => "Komprimiere…".into(),
        Msg::CompactingSlow => "Komprimiere… (langsam)".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("Komprimiert · {} Nachricht(en) zusammengefasst · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("Tool-Ausgabe eingeklappt · ~{} tok gespart", saved).into(),
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("Modell lieferte eine leere Antwort, neuer Versuch in {wait}s ({attempt}/{max})…")
        } else {
            format!("Modell lieferte eine leere Antwort, neuer Versuch ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("Modell lieferte nur Denkprozesse, neuer Versuch in {wait}s ({attempt}/{max})…")
        } else {
            format!("Modell lieferte nur Denkprozesse, neuer Versuch ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("Ungültiges Antwortformat, neuer Versuch in {wait}s ({attempt}/{max})…")
        } else {
            format!("Ungültiges Antwortformat, neuer Versuch ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("Modell reagiert langsam: kein Token innerhalb von {secs}s, neuer Versuch ({attempt}/{max})…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("API-Fehler {reason}, neuer Versuch in {wait}s ({attempt}/{max})…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "Anfrage (~{estimate_k}K Tokens) erreicht die Kontextgrenze (Fenster ~{window_k}K − Puffer {buffer_k}K): Eingabe kürzen oder ein Modell mit größerem Fenster wählen."
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("Kontextüberlauf in Runde {round} (Versuch {attempt}); komprimiere und versuche es erneut").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("Stream-Zeitüberschreitung bei Leerlauf — verbinde neu ({attempt}/{max})").into(),
        Msg::AgentResponseTruncated => "Antwort abgeschnitten: finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("Nicht unterstützte Snapshot-Version {version} (unterstützt: {supported}); starte mit leerer Sitzung").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("Modelllatenz zu hoch, bitte später erneut versuchen ({retries} Versuche in Folge ohne erstes Token in {secs}s)").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("Modell lieferte {max} Mal hintereinander unlesbare Antworten (vorübergehender Anbieterfehler). Du kannst es direkt oder später erneut versuchen.").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("Modell lieferte {max} Mal hintereinander nur Denkprozesse ohne Text oder Tool-Aufrufe. Diese Anfrage überschreitet das Kontextfenster — Eingabe kürzen oder /compact ausführen.").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("Modell lieferte {max} Mal hintereinander nur Denkprozesse ohne Text oder Tool-Aufrufe. Aktuelle Anfrage ~{prompt_k}K Tokens nahe am Fenster (~{window_k}K); nutze /compact oder kürze die Eingabe.").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("Modell lieferte {max} Mal hintereinander nur Denkprozesse ohne Text oder Tool-Aufrufe. Du kannst es direkt oder später erneut versuchen.").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("Modell lieferte {max} Mal hintereinander leere Antworten. Diese Anfrage überschreitet das Kontextfenster — Eingabe kürzen oder /compact ausführen.").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("Modell lieferte {max} Mal hintereinander leere Antworten. Aktuelle Anfrage ~{prompt_k}K Tokens nahe am Fenster (~{window_k}K); nutze /compact oder kürze die Eingabe.").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("Modell lieferte {max} Mal hintereinander leere Antworten (vorübergehender Anbieterfehler, unabhängig von der Kontextlänge). Du kannst es direkt oder später erneut versuchen.").into(),
        Msg::AgentStatusRateLimited => "Anfragelimit überschritten oder Kontingent erschöpft".into(),
        Msg::AgentStatusUpstreamUnavailable => "Anbieterdienst vorübergehend nicht verfügbar".into(),
        Msg::AgentStatusResponseTimeout => "Zeitüberschreitung bei der Modellantwort".into(),
        Msg::AgentStatusConnectionFailed => "Netzwerkverbindung fehlgeschlagen".into(),
        Msg::AgentStatusInsufficientBalance => "Kontoguthaben nicht ausreichend".into(),
        Msg::AgentStatusUnauthorized => "API-Schlüssel nicht autorisiert oder abgelaufen".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("Netzwerkverbindung unterbrochen: Gegenstelle hat die Verbindung geschlossen oder zurückgesetzt, Wiederverbindung nach {attempts} Versuchen fehlgeschlagen. Du kannst es erneut versuchen.").into(),
        Msg::StreamReadPartialResponse =>
            "Antwort unterbrochen: der bisher sichere Teil der Antwort wurde erhalten, du kannst fortfahren.".into(),
        Msg::StreamReadInterrupted =>
            "Netzwerkverbindung unterbrochen: Gegenstelle hat die Verbindung geschlossen oder zurückgesetzt. Du kannst es erneut versuchen.".into(),
        Msg::AgentAutoRetry { max } =>
            format!("Verbindung getrennt, automatische Wiederverbindung läuft (bis zu {max} Versuche), aktuelle Ausgabe erhalten…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("Verbindung unterbrochen, aktuelle Ausgabe erhalten, Versuch {attempt}/{max}").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("Stream-Zeitüberschreitung, aktuelle Ausgabe erhalten, Versuch {attempt}/{max}")
        } else {
            format!("Stream-Zeitüberschreitung, Versuch {attempt}/{max}")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("Netzwerkverbindung abgebrochen, aktuelle Ausgabe erhalten, Versuch {attempt}/{max}")
        } else {
            format!("Netzwerkverbindung abgebrochen, Versuch {attempt}/{max}")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("Verbindung nach {attempts} Versuch(en) wiederhergestellt, fahre fort").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "Stream-Zeitüberschreitung auch nach automatischen Wiederverbindungen; Runde beendet".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("Ratenlimit erreicht, automatischer neuer Versuch in {secs}s…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "Ratenlimit erreicht; pausiert bis zum Zurücksetzen oder Modellwechsel".into()
        } else {
            format!("Wegen Ratenlimit pausiert: {detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "Stream-Zeitüberschreitung nach Teilantwort; die Teilantwort wurde erhalten und kann fortgesetzt werden.".into(),
        Msg::StreamReadResetHint =>
            "Dieser Fehler tritt häufig in Firmennetzen oder mit Proxy auf; bitte Proxy-, VPN- und Firewall-Einstellungen prüfen.".into(),
        Msg::StreamReadDetailsPrefix => "Details: ".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "Mögliche Wiederholungsschleife: Dasselbe Ausgabe- und Werkzeugmuster wurde erneut erkannt; das Modell wird vor dem Abbruch dieser Runde zum Kurswechsel aufgefordert.".into()
        } else {
            "Mögliche Wiederholungsschleife: Dasselbe Ausgabe- und Werkzeugmuster wurde erkannt; das Modell wird zum Kurswechsel aufgefordert.".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("gestoppt: das Modell hat dasselbe Denk-, Text- und Werkzeugaufrufmuster {rounds} Runden in Folge wiederholt").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("mögliche Werkzeugschleife: derselbe Aufruf oder schreibgeschützte Stapel hat {threshold}-mal dasselbe Ergebnis geliefert; fordere das Modell zum Kurswechsel auf").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("Werkzeugschleife erkannt: derselbe Aufruf oder schreibgeschützte Stapel hat {threshold}-mal dasselbe Ergebnis geliefert; Abbruch vor einer weiteren Modellantfrage").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("gestoppt: das Modell hat dasselbe Werkzeugaufrufmuster {rounds} Runden in Folge wiederholt").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("Rundenlimit ({cap}) erreicht; Werkzeugausführung gestoppt, um den Fortschritt und die nächsten Schritte zusammenzufassen.").into(),
        _ => super::en::en(msg),
    }
}
