package com.jeikcode.jetbrains.ui

import com.jeikcode.jetbrains.i18n.JeikCodeBundle
import java.util.Locale

internal data class GearMenuLabels(
    val connectStart: String,
    val provider: String,
    val createProvider: String,
    val editProvider: String,
    val deleteProvider: String,
    val thinkingSettings: String,
    val sessionHistory: String,
    val renameSession: String,
    val deleteSession: String,
    val refreshSessions: String,
    val openChanges: String,
    val diagnostics: String,
    val settings: String,
)

internal fun gearMenuLabels(locale: Locale = Locale.getDefault()): GearMenuLabels =
    GearMenuLabels(
        connectStart = JeikCodeBundle.message(locale, "gear.connectStart"),
        provider = JeikCodeBundle.message(locale, "gear.provider"),
        createProvider = JeikCodeBundle.message(locale, "gear.createProvider"),
        editProvider = JeikCodeBundle.message(locale, "gear.editProvider"),
        deleteProvider = JeikCodeBundle.message(locale, "gear.deleteProvider"),
        thinkingSettings = JeikCodeBundle.message(locale, "gear.thinkingSettings"),
        sessionHistory = JeikCodeBundle.message(locale, "gear.sessionHistory"),
        renameSession = JeikCodeBundle.message(locale, "gear.renameSession"),
        deleteSession = JeikCodeBundle.message(locale, "gear.deleteSession"),
        refreshSessions = JeikCodeBundle.message(locale, "gear.refreshSessions"),
        openChanges = JeikCodeBundle.message(locale, "gear.openChanges"),
        diagnostics = JeikCodeBundle.message(locale, "gear.diagnostics"),
        settings = JeikCodeBundle.message(locale, "gear.settings"),
    )
