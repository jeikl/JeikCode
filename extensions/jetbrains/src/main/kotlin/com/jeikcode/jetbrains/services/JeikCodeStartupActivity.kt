package com.jeikcode.jetbrains.services

import com.jeikcode.jetbrains.settings.JeikCodeSettingsState
import com.jeikcode.jetbrains.ui.openJeikCodeWelcomePage
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity

class JeikCodeStartupActivity : StartupActivity.DumbAware {
    override fun runActivity(project: Project) {
        JeikCodeProjectService.getInstance(project).startBackgroundHealthChecks()
        showWelcomePageOnce(project)
    }

    private fun showWelcomePageOnce(project: Project) {
        val settings = JeikCodeSettingsState.getInstance()
        if (settings.state.welcomePageShown) return
        settings.update { it.welcomePageShown = true }
        ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) {
                openJeikCodeWelcomePage(project)
            }
        }
    }
}
