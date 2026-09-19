package com.jeikcode.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

enum class JeikCodeContextLevel {
    Minimal,
    CurrentFile,
    ProjectContext,
}

data class JeikCodeSettings(
    var daemonBinaryPath: String = "",
    var host: String = "127.0.0.1",
    var port: Int = 13456,
    var autoStart: Boolean = true,
    var requestTimeoutMs: Int = 30_000,
    var autoSaveBeforeRead: Boolean = true,
    var contextLevel: JeikCodeContextLevel = JeikCodeContextLevel.Minimal,
    var allowSelectedTextContext: Boolean = true,
    var sendRelativePathWithSelection: Boolean = true,
    var sendWithCtrlEnter: Boolean = false,
    var chatFontSize: Int = 13,
    var welcomePageShown: Boolean = false,
)

@Service(Service.Level.APP)
@State(name = "JeikCodeSettings", storages = [Storage("jeikcode.xml")])
class JeikCodeSettingsState : PersistentStateComponent<JeikCodeSettings> {
    private var state = JeikCodeSettings()

    override fun getState(): JeikCodeSettings = state

    override fun loadState(state: JeikCodeSettings) {
        this.state = state.normalized()
    }

    fun update(block: (JeikCodeSettings) -> Unit) {
        val next = state.copy()
        block(next)
        state = next.normalized()
    }

    companion object {
        fun getInstance(): JeikCodeSettingsState =
            ApplicationManager.getApplication().getService(JeikCodeSettingsState::class.java)
    }
}

internal fun JeikCodeSettings.normalized(): JeikCodeSettings {
    if (host.isBlank()) host = "127.0.0.1"
    if (port <= 0) port = 13456
    if (requestTimeoutMs <= 0) requestTimeoutMs = 30_000
    if (chatFontSize <= 0) chatFontSize = 13
    return this
}
