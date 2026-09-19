package com.jeikcode.jetbrains.actions

import com.jeikcode.jetbrains.ui.JeikCodeChatPanel
import com.jeikcode.jetbrains.ui.openJeikCodeChatTab
import com.jeikcode.jetbrains.ui.selectedJeikCodeChatPanel
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.ActionUpdateThread

class OpenChatAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.getData(CommonDataKeys.PROJECT) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.getData(CommonDataKeys.PROJECT) ?: return
        openJeikCodeChatTab(project)
    }
}

internal fun findChatPanel(project: com.intellij.openapi.project.Project): JeikCodeChatPanel? {
    return selectedJeikCodeChatPanel(project)
}
