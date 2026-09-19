package com.jeikcode.jetbrains.ui

import com.jeikcode.jetbrains.daemon.ConnectionState
import com.jeikcode.jetbrains.services.JeikCodeProjectService
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.event.MouseEvent
import java.beans.PropertyChangeListener
import javax.swing.SwingUtilities

class JeikCodeStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = JeikCodeStatusBarWidget.ID

    override fun getDisplayName(): String = "JeikCode"

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = JeikCodeStatusBarWidget(project)

    override fun disposeWidget(widget: StatusBarWidget) {
        widget.dispose()
    }

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

private class JeikCodeStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private val service = JeikCodeProjectService.getInstance(project)
    private var statusBar: StatusBar? = null
    private val listener = PropertyChangeListener {
        SwingUtilities.invokeLater {
            statusBar?.updateWidget(ID)
        }
    }

    init {
        service.addConnectionListener(listener)
    }

    override fun ID(): String = ID

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
    }

    override fun dispose() {
        service.removeConnectionListener(listener)
        statusBar = null
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String =
        when (service.connectionState) {
            is ConnectionState.Ready -> "JeikCode"
            ConnectionState.Idle -> "JeikCode ○"
            ConnectionState.CheckingDaemon,
            ConnectionState.StartingDaemon,
            ConnectionState.Connecting,
            ConnectionState.SyncingProject,
            ConnectionState.CheckingProvider -> "JeikCode ..."
            is ConnectionState.SetupRequired,
            is ConnectionState.ProviderMissing,
            is ConnectionState.Error -> "JeikCode !"
        }

    override fun getTooltipText(): String =
        when (val state = service.connectionState) {
            is ConnectionState.Ready -> "JeikCode: Connected (${state.daemonVersion}). Click to open chat."
            ConnectionState.Idle -> "JeikCode: Not connected. Click to open chat."
            ConnectionState.CheckingDaemon -> "JeikCode: Checking daemon..."
            ConnectionState.StartingDaemon -> "JeikCode: Starting daemon..."
            ConnectionState.Connecting -> "JeikCode: Connecting..."
            ConnectionState.SyncingProject -> "JeikCode: Syncing project..."
            ConnectionState.CheckingProvider -> "JeikCode: Checking provider..."
            is ConnectionState.SetupRequired -> "JeikCode: Setup required - ${state.reason}"
            is ConnectionState.ProviderMissing -> "JeikCode: Provider missing"
            is ConnectionState.Error -> "JeikCode: ${state.message}"
        }

    override fun getAlignment(): Float = 0.5f

    override fun getClickConsumer(): Consumer<MouseEvent>? =
        Consumer {
            openJeikCodeChatTab(project)
        }

    companion object {
        const val ID = "JeikCodeStatus"
    }
}
