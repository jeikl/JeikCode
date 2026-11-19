use super::messages::Msg;
use std::borrow::Cow;

pub(super) fn fr(msg: Msg<'_>) -> Cow<'static, str> {
    match msg {
        Msg::SessionShared => "Session partagée (synchronisation en temps réel avec le navigateur)".into(),
        Msg::SessionModelRequired => "Aucun modèle configuré: utilisez /model ou /provider pour ajouter un modèle avant de discuter.".into(),
        Msg::ServerNoServices => "Aucun service hôte JeikCode n'est installé.".into(),
        Msg::WelcomeBannerLine1 => "Bienvenue sur JeikCode — votre assistant de code IA en terminal".into(),
        Msg::WelcomeBannerLine2 => "Posez une question ou donnez une consigne. Tapez / pour voir les commandes.".into(),
        Msg::WelcomeOptionConfigureManually => "Configurer manuellement".into(),
        Msg::WelcomeOptionConfigureManuallyHint => "Saisir la clé API et l'URL personnalisée".into(),
        Msg::WelcomeOptionSkip => "Passer pour l'instant".into(),
        Msg::WelcomeOptionSkipHint => "Accéder au chat directement et configurer plus tard".into(),
        Msg::WelcomeTipsHeading => "Pour bien commencer:".into(),
        Msg::WelcomeTipModel => "Changer de modèle actif".into(),
        Msg::WelcomeTipProvider => "Ajouter un fournisseur personnalisé".into(),
        Msg::WelcomeTipResume => "Reprendre une session précédente".into(),
        Msg::WelcomeTipSkills => "Voir les compétences disponibles".into(),
        Msg::WelcomeTipPlugin => "Gérer les plugins et extensions".into(),
        Msg::WelcomeTipWebui => "Lancer l'interface web dans le navigateur".into(),
        Msg::WelcomeTipMcp => "Vérifier l'état des serveurs MCP".into(),
        Msg::WelcomeTipPlan => "Basculer en mode Plan".into(),
        Msg::WelcomeTipSession => "Démarrer une nouvelle session".into(),
        Msg::WelcomeTipLoop => "Configurer une tâche périodique ou récurrente".into(),
        Msg::WelcomeTipGoal => "Activer le mode axé sur les objectifs".into(),
        Msg::WelcomeTipInit => "Initialiser les configurations du projet".into(),
        Msg::WelcomeTipLanguage => "Changer la langue d'affichage".into(),
        Msg::ProviderPanelTabAccounts => "Comptes".into(),
        Msg::ProviderPanelTabModels => "Modèles".into(),
        Msg::ProviderPanelEmptyAccounts => "(Aucun fournisseur — appuyez sur Ctrl+A pour en ajouter)".into(),
        Msg::ProviderPanelNoMatchingAccounts => "(Aucun fournisseur correspondant)".into(),
        Msg::ProviderPanelEmptyModels => "(Aucun modèle — appuyez sur Ctrl+A pour en ajouter)".into(),
        Msg::ProviderPanelNoMatchingModels => "(Aucun modèle correspondant)".into(),
        Msg::ProviderPanelLegacyBadge => "ancien".into(),
        Msg::ProviderPanelDefaultBadge => "par défaut".into(),
        Msg::ProviderPanelModelCount { count } => format!("{count} modèle{}", if count == 1 { "" } else { "s" }).into(),
        Msg::ProviderPanelAddModelRow => "+ Ajouter un modèle".into(),
        Msg::ProviderPanelAddProviderRow => "+ Ajouter un fournisseur personnalisé".into(),
        Msg::ProviderPanelAccountsHint =>
            "Filtrer · ↑↓ naviguer · ↵ modèles · Ctrl+A ajouter · Ctrl+E modifier · Ctrl+Dx2 supprimer · Tab onglet · Esc fermer".into(),
        Msg::ProviderPanelModelsHint =>
            "Filtrer · ↑↓ naviguer · ↵ défaut/ajouter · Ctrl+A ajouter + récupérer la liste · Ctrl+E modifier · Ctrl+Dx2 supprimer · Tab onglet · Esc fermer".into(),
        Msg::ProviderPanelFilteredModelsHint { account } =>
            format!("[{account}] · ↑↓ naviguer · ↵ défaut/ajouter · Ctrl+A ajouter · Ctrl+E modifier · Ctrl+Dx2 supprimer · Tab tous · Esc fermer").into(),
        Msg::ProviderPanelModelSaved { model } => format!("Modèle \"{model}\" enregistré.").into(),
        Msg::ProviderPanelImageDirectWhileVlSet => {
            "Les images sont envoyées directement à ce modèle; désactivez l'entrée d'image pour utiliser VL.".into()
        }
        Msg::ProviderPanelAddTitle => "[Ajouter un fournisseur]".into(),
        Msg::ProviderPanelEditAccountTitle { account } =>
            format!("[Modifier le compte {account}]").into(),
        Msg::ProviderPanelAddModelTitle => "[Ajouter un modèle]".into(),
        Msg::ProviderPanelEditModelTitle => "[Modifier le modèle]".into(),
        Msg::ProviderPanelFieldVendor => "Fournisseur".into(),
        Msg::ProviderPanelFieldAccount => "Compte".into(),
        Msg::ProviderPanelFieldName => "Nom".into(),
        Msg::ProviderPanelFieldProtocol => "Protocole".into(),
        Msg::ProviderPanelRequired => "(obligatoire)".into(),
        Msg::ProviderPanelLocked => "(verrouillé)".into(),
        Msg::ProviderPanelFieldBaseUrl => "URL de base".into(),
        Msg::ProviderPanelFieldApiKey => "Clé API".into(),
        Msg::ProviderPanelFieldModel => "Modèle".into(),
        Msg::ProviderPanelFieldWindow => "Fenêtre de contexte".into(),
        Msg::ProviderPanelFieldSupportsVision => "Prend en charge les images ?".into(),
        Msg::ProviderPanelVisionYes => "Oui [✓]  (envoi d'images base64)".into(),
        Msg::ProviderPanelVisionNo => "Non [ ]  (texte seulement)".into(),
        Msg::ProviderPanelFieldReasoningModel => "Modèle de raisonnement (thinking) ?".into(),
        Msg::ProviderPanelReasoningYes => "Oui [✓]  (afficher la réflexion dans l'historique)".into(),
        Msg::ProviderPanelReasoningNo => "Non [ ]  (modèle standard)".into(),
        Msg::ProviderPanelFieldMakeDefault => "Définir par défaut".into(),
        Msg::ProviderPanelSwitchHint => "←→ changer".into(),
        Msg::ProviderPanelEnvHint { env } => format!("laisser vide pour utiliser ${env}").into(),
        Msg::ProviderPanelDefaultValue => "par défaut".into(),
        Msg::ProviderPanelKeepOriginal => "laisser vide pour conserver la valeur".into(),
        Msg::ProviderPanelProviderFormHint =>
            "Tab Suivant  ←→ Changer de fournisseur  Espace Basculer  ↵ Enregistrer  Esc Retour".into(),
        Msg::ProviderPanelAccountFormHint => "Tab Changer  ↵ Enregistrer  Esc Retour".into(),
        Msg::ProviderPanelAddAccountHint =>
            "Tab Suivant  ←→ Changer de protocole  ↵ Enregistrer  Esc Retour  (Nom requis)".into(),
        Msg::ProviderPanelEditAccountLockedHint =>
            "Tab Suivant  ↵ Enregistrer  Esc Retour  (Protocole verrouillé)".into(),
        Msg::ProviderPanelEditAccountHint =>
            "Tab Suivant  ←→ Changer de protocole  ↵ Enregistrer  Esc Retour".into(),
        Msg::ProviderPanelAccountNeedsKeyHint => "(fournisseur non configuré)".into(),
        Msg::ProviderPanelModelFormHint =>
            "Filtrer la liste  ↑↓ naviguer  Tab/↵ remplir  ←→ compte  Espace basculer  Esc retour".into(),
        Msg::ProviderPanelModelPlaceholder => "(tapez pour filtrer la liste)".into(),
        Msg::ProviderPanelUpstreamListLabel => "Modèles disponibles".into(),
        Msg::ProviderPanelUpstreamPickHint => "↑↓ choisir · Tab/↵ remplir".into(),
        Msg::ProviderPanelUpstreamLoading => "chargement…".into(),
        Msg::ProviderPanelUpstreamLoaded { n } =>
            format!("{n} modèles chargés · tapez pour filtrer · ↑↓ choisir · Tab/↵ remplir").into(),
        Msg::ProviderPanelUpstreamEmpty => "Catalogue vide — tapez directement l'ID du modèle".into(),
        Msg::ProviderPanelUpstreamFailed { error } =>
            format!("Échec de récupération ({error}) — tapez l'ID du modèle").into(),
        Msg::ProviderPanelUpstreamNoUrl => "Aucune URL amont — tapez l'ID du modèle".into(),
        Msg::ModelPickerNoModelsConfigured => "(aucun modèle configuré — utilisez /provider pour en ajouter)".into(),
        Msg::ModelPickerNoModelsMatch => "(aucun modèle correspondant)".into(),
        Msg::ModelPickerNoModelsMatchQuery { query } =>
            format!("(aucun modèle ne correspond à \"{query}\" — Retour arrière pour effacer)").into(),
        Msg::ModelSwitched { provider, model } =>
            format!("  Passé à {provider} · {model} pour cette session\n").into(),
        Msg::ModelSwitchedAndDefault { provider, model } =>
            format!("  Passé à {provider} · {model} et défini par défaut pour les nouvelles sessions\n").into(),
        Msg::LanguageSwitched { label, locale } =>
            format!("✓ Langue changée en {label} ({locale})\n").into(),
        Msg::CmdDescHelp => "Afficher l'aide et les commandes disponibles".into(),
        Msg::CmdDescModel => "Sélectionner ou changer de modèle".into(),
        Msg::CmdDescProvider => "Gérer les fournisseurs et comptes API".into(),
        Msg::CmdDescQuit => "Quitter JeikCode".into(),
        Msg::StreamStalled => "appuyez sur esc pour annuler".into(),
        Msg::CompactNothingShort => "(rien à compacter — la conversation est courte)\n".into(),
        Msg::CompactStarting => "(compactage par résumé LLM...)\n".into(),
        Msg::CompactInterrupted => "(compactage interrompu — le coding runtime a changé ou s'est arrêté)\n".into(),
        Msg::CompactUnavailableDuringSync => "Impossible de compacter pendant la synchronisation live ; lancez d'abord /sync off".into(),
        Msg::CompactUnavailableDuringResync => "Impossible de compacter tant que le runtime local n'a pas restauré la dernière conversation synchronisée".into(),
        Msg::LocalRuntimeRestorePending => "Le runtime local restaure la conversation synchronisée ; veuillez patienter".into(),
        Msg::LocalRuntimeRestoreTimedOut => "La restauration du runtime local a expiré ; la synchronisation Live est rétablie".into(),
        Msg::CompactNothingNoSavings { before, after } =>
            format!("(rien à compacter — aucune économie de tokens : {} → {})\n", before, after).into(),
        Msg::CompactDropped { messages, before, after } =>
            format!("(compacté — {} messages supprimés, {} → {} tokens)\n", messages, before, after).into(),
        Msg::Compacting => "Compactage…".into(),
        Msg::CompactingSlow => "Compactage… (lent)".into(),
        Msg::CompactMarkDrain { messages, before, after } =>
            format!("Compacté · {} message(s) résumé(s) · ~{}→~{} tok", messages, before, after).into(),
        Msg::CompactMarkStub { saved } =>
            format!("Sortie d'outil repliée · ~{} tok économisés", saved).into(),
        Msg::AgentRetryEmpty { attempt, max, wait } => if wait > 0 {
            format!("Le modèle a renvoyé une réponse vide, nouvelle tentative dans {wait}s ({attempt}/{max})…")
        } else {
            format!("Le modèle a renvoyé une réponse vide, nouvelle tentative ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryThinking { attempt, max, wait } => if wait > 0 {
            format!("Le modèle n'a renvoyé que sa réflexion, nouvelle tentative dans {wait}s ({attempt}/{max})…")
        } else {
            format!("Le modèle n'a renvoyé que sa réflexion, nouvelle tentative ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryMalformed { attempt, max, wait } => if wait > 0 {
            format!("Réponse mal formée, nouvelle tentative dans {wait}s ({attempt}/{max})…")
        } else {
            format!("Réponse mal formée, nouvelle tentative ({attempt}/{max})…")
        }.into(),
        Msg::AgentRetryFirstToken { secs, attempt, max } =>
            format!("Modèle lent : aucun jeton reçu en {secs}s, nouvelle tentative ({attempt}/{max})…").into(),
        Msg::AgentRetryApi { reason, wait, attempt, max } =>
            format!("Erreur API {reason}, nouvelle tentative dans {wait}s ({attempt}/{max})…").into(),
        Msg::AgentOverWindow { estimate_k, window_k, buffer_k } =>
            format!(
                "La requête (~{estimate_k}K tokens) atteint le seuil du contexte (fenêtre ~{window_k}K − marge {buffer_k}K) : réduisez l'entrée ou changez pour un modèle à plus grande fenêtre."
            ).into(),
        Msg::AgentContextOverflow { round, attempt } =>
            format!("Dépassement du contexte au tour {round} (tentative {attempt}) ; compactage et nouvelle tentative").into(),
        Msg::AgentStreamReconnecting { attempt, max } =>
            format!("Délai d'inactivité du flux dépassé — reconnexion ({attempt}/{max})").into(),
        Msg::AgentResponseTruncated => "Réponse tronquée : finish_reason=length".into(),
        Msg::AgentUnsupportedSnapshot { version, supported } =>
            format!("Version d'instantané {version} non prise en charge (version prise en charge : {supported}) ; démarrage à vide").into(),
        Msg::AgentModelHighLatencyTerminal { retries, secs } =>
            format!("Latence du modèle trop élevée, veuillez réessayer plus tard ({retries} tentatives consécutives sans premier jeton en {secs}s)").into(),
        Msg::AgentExhaustedMalformed { max } =>
            format!("Le modèle a renvoyé une réponse illisible {max} fois de suite (incident ponctuel du fournisseur). Vous pouvez réessayer maintenant ou plus tard.").into(),
        Msg::AgentExhaustedThinkingOverWindowIntro { max } =>
            format!("Le modèle n'a renvoyé que sa réflexion sans texte ni outil {max} fois de suite. Cette requête dépasse la fenêtre de contexte — réduisez l'entrée ou lancez /compact puis réessayez.").into(),
        Msg::AgentExhaustedThinkingOverWindowSize { max, prompt_k, window_k } =>
            format!("Le modèle n'a renvoyé que sa réflexion sans texte ni outil {max} fois de suite. La requête (~{prompt_k}K tokens) approche ou dépasse la fenêtre (~{window_k}K) ; essayez /compact ou réduisez l'entrée.").into(),
        Msg::AgentExhaustedThinkingGeneric { max } =>
            format!("Le modèle n'a renvoyé que sa réflexion sans texte ni outil {max} fois de suite. Vous pouvez réessayer maintenant ou plus tard.").into(),
        Msg::AgentExhaustedEmptyOverWindowIntro { max } =>
            format!("Le modèle a renvoyé une réponse vide {max} fois de suite. Cette requête dépasse la fenêtre de contexte — réduisez l'entrée ou lancez /compact puis réessayez.").into(),
        Msg::AgentExhaustedEmptyOverWindowSize { max, prompt_k, window_k } =>
            format!("Le modèle a renvoyé une réponse vide {max} fois de suite. La requête (~{prompt_k}K tokens) approche ou dépasse la fenêtre (~{window_k}K) ; essayez /compact ou réduisez l'entrée.").into(),
        Msg::AgentExhaustedEmptyGeneric { max } =>
            format!("Le modèle a renvoyé une réponse vide {max} fois de suite (incident ponctuel indépendant de la longueur du contexte). Vous pouvez réessayer maintenant ou plus tard.").into(),
        Msg::AgentStatusRateLimited => "Limite de débit dépassée ou quota épuisé".into(),
        Msg::AgentStatusUpstreamUnavailable => "Service distant temporairement indisponible".into(),
        Msg::AgentStatusResponseTimeout => "Délai de réponse du modèle dépassé".into(),
        Msg::AgentStatusConnectionFailed => "Échec de la connexion réseau".into(),
        Msg::AgentStatusInsufficientBalance => "Solde du compte insuffisant".into(),
        Msg::AgentStatusUnauthorized => "Clé API non autorisée ou expirée".into(),
        Msg::StreamReadRetryExhausted { attempts } =>
            format!("Connexion réseau interrompue : l'hôte distant a fermé ou réinitialisé la connexion, échec après {attempts} reconnexions automatiques. Vous pouvez réessayer.").into(),
        Msg::StreamReadPartialResponse =>
            "Réponse interrompue : la partie exploitable de la réponse a été conservée, vous pouvez continuer.".into(),
        Msg::StreamReadInterrupted =>
            "Connexion réseau interrompue : l'hôte distant a fermé ou réinitialisé la connexion. Vous pouvez réessayer.".into(),
        Msg::AgentAutoRetry { max } =>
            format!("Connexion perdue, reconnexion automatique en cours (jusqu'à {max} tentatives), sortie actuelle conservée…").into(),
        Msg::AgentRetryProgress { attempt, max } =>
            format!("Connexion interrompue, sortie actuelle conservée, tentative {attempt}/{max}").into(),
        Msg::AgentRetryStallProgress { attempt, max, has_output } => if has_output {
            format!("Flux figé par délai d'inactivité, sortie conservée, tentative {attempt}/{max}")
        } else {
            format!("Flux figé par délai d'inactivité, tentative {attempt}/{max}")
        }.into(),
        Msg::AgentRetryDropProgress { attempt, max, has_output } => if has_output {
            format!("Connexion réseau perdue, sortie conservée, tentative {attempt}/{max}")
        } else {
            format!("Connexion réseau perdue, tentative {attempt}/{max}")
        }.into(),
        Msg::AgentRetryRecovered { attempts } =>
            format!("Connexion rétablie après {attempts} tentative(s), poursuite en cours").into(),
        Msg::AgentStreamTimeoutTerminal =>
            "Délai du flux dépassé après les reconnexions automatiques ; tour interrompu".into(),
        Msg::AgentRateLimitedWaiting { secs } =>
            format!("Limite de débit atteinte, nouvelle tentative dans {secs}s…").into(),
        Msg::AgentRateLimitedPaused { detail } => if detail.trim().is_empty() {
            "Limite de débit atteinte ; mis en pause en attendant la réinitialisation ou un changement de modèle".into()
        } else {
            format!("Mis en pause par limite de débit : {detail}").into()
        },
        Msg::AgentStreamTimeoutPartialResponse =>
            "Délai du flux dépassé après une réponse partielle ; le contenu reçu a été conservé et peut être poursuivi.".into(),
        Msg::StreamReadResetHint =>
            "Cette erreur survient souvent sur un réseau d'entreprise ou via un proxy ; vérifiez vos réglages proxy, VPN ou pare-feu.".into(),
        Msg::StreamReadDetailsPrefix => "Détails : ".into(),
        Msg::AgentEchoLoopNotice { final_warning } => if final_warning {
            "Boucle d'écho possible : un motif répété de sortie et d'appels d'outils a été détecté ; invitation au modèle à changer de cap avant l'arrêt du tour.".into()
        } else {
            "Boucle d'écho possible : un motif répété de sortie et d'appels d'outils a été détecté ; invitation au modèle à changer de cap.".into()
        },
        Msg::AgentEchoLoopTerminal { rounds } =>
            format!("arrêté : le modèle a rejoué le même raisonnement, texte et motif d'appels d'outils pendant {rounds} tours consécutifs").into(),
        Msg::AgentToolLoopWarning { threshold } =>
            format!("boucle d'outils possible : le même appel ou lot en lecture seule a renvoyé les mêmes résultats {threshold} fois ; invitation au modèle à changer de cap").into(),
        Msg::AgentToolLoopTerminal { threshold } =>
            format!("boucle d'outils détectée : le même appel ou lot en lecture seule a renvoyé les mêmes résultats {threshold} fois ; arrêt avant une nouvelle requête").into(),
        Msg::AgentRepeatLoopTerminal { rounds } =>
            format!("arrêté : le modèle a répété le même motif d'appels d'outils pendant {rounds} tours consécutifs").into(),
        Msg::AgentMaxRoundsReached { cap } =>
            format!("Limite de tours atteinte ({cap}) ; exécution des outils arrêtée pour résumer l'avancement et les prochaines étapes.").into(),
        _ => super::en::en(msg),
    }
}
