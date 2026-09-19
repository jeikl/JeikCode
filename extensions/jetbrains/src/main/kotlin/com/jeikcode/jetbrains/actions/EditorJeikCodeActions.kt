package com.jeikcode.jetbrains.actions

import com.jeikcode.jetbrains.security.PathSensitivity
import com.jeikcode.jetbrains.security.SensitivePathClassifier
import com.jeikcode.jetbrains.settings.JeikCodeSettingsState
import com.jeikcode.jetbrains.ui.ChatContextItem
import com.jeikcode.jetbrains.ui.createJeikCodeChatContent
import com.jeikcode.jetbrains.ui.selectedJeikCodeChatPanel
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager

private const val MAX_CONTEXT_CHARS = 120_000

internal object EditorJeikCodeActions {
    private val settings = JeikCodeSettingsState.getInstance()

    fun canSendSelectedText(editor: Editor?): Boolean =
        settings.state.allowSelectedTextContext && editor?.selectionModel?.hasSelection() == true

    fun sendSelectionCommand(project: Project, editor: Editor, instruction: String) {
        if (!settings.state.allowSelectedTextContext) {
            Messages.showWarningDialog(project, "Selected text context is disabled in JeikCode settings.", "JeikCode")
            return
        }
        val selection = editor.selectionModel.selectedText?.takeIf { it.isNotBlank() } ?: return
        val virtualFile = FileDocumentManager.getInstance().getFile(editor.document)
        val path = virtualFile?.path.orEmpty()

        if (!confirmPath(project, path, "JeikCode will not send this sensitive file selection.", "This selection is from a sensitive file. Send it to the configured model provider?")) {
            return
        }

        val displayPath = project.relativePath(path)
            .takeIf { settings.state.sendRelativePathWithSelection }
            ?: path
        val language = virtualFile?.extension ?: "text"
        val startLine = editor.document.getLineNumber(editor.selectionModel.selectionStart) + 1
        val endLine = editor.document.getLineNumber(editor.selectionModel.selectionEnd) + 1
        val context = ChatContextItem(
            path = path,
            displayName = displayPath,
            language = language,
            content = selection,
            selection = selection,
            startLine = startLine,
            endLine = endLine,
        )

        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("JeikCode") ?: return
        toolWindow.activate {
            val panel = selectedJeikCodeChatPanel(project)
                ?: createJeikCodeChatContent(project, toolWindow, closeable = true)
            panel.composePrompt(instruction, context)
        }
    }

    fun addEditorContext(project: Project, editor: Editor) {
        val virtualFile = FileDocumentManager.getInstance().getFile(editor.document) ?: return
        val path = virtualFile.path

        if (!confirmPath(project, path, "JeikCode will not attach this sensitive file.", "This file may contain sensitive information. Attach it to the next JeikCode message?")) {
            return
        }

        val selectedText = editor.selectionModel.selectedText
            ?.takeIf { settings.state.allowSelectedTextContext }
            ?.takeIf { it.isNotBlank() }
        val content = selectedText ?: editor.document.text
        if (content.isBlank()) return
        if (content.length > MAX_CONTEXT_CHARS) {
            Messages.showWarningDialog(project, "This context is too large to attach. Select a smaller range.", "JeikCode")
            return
        }

        val relative = project.relativePath(path)
        val displayName = if (settings.state.sendRelativePathWithSelection) relative else path
        val startLine = if (selectedText != null) {
            editor.document.getLineNumber(editor.selectionModel.selectionStart) + 1
        } else {
            null
        }
        val endLine = if (selectedText != null) {
            editor.document.getLineNumber(editor.selectionModel.selectionEnd) + 1
        } else {
            null
        }

        val toolWindow = ToolWindowManager.getInstance(project).getToolWindow("JeikCode") ?: return
        toolWindow.activate {
            val panel = selectedJeikCodeChatPanel(project)
                ?: createJeikCodeChatContent(project, toolWindow, closeable = true)
            panel.addContext(
                ChatContextItem(
                    path = path,
                    displayName = displayName,
                    language = virtualFile.extension ?: "text",
                    content = content,
                    selection = selectedText,
                    startLine = startLine,
                    endLine = endLine,
                )
            )
        }
    }

    private fun confirmPath(project: Project, path: String, blockMessage: String, strongConfirmMessage: String): Boolean =
        when (SensitivePathClassifier.classify(path)) {
            PathSensitivity.Block -> {
                Messages.showWarningDialog(project, blockMessage, "JeikCode")
                false
            }
            PathSensitivity.StrongConfirm -> {
                val choice = Messages.showYesNoDialog(
                    project,
                    strongConfirmMessage,
                    "JeikCode",
                    Messages.getWarningIcon(),
                )
                choice == Messages.YES
            }
            PathSensitivity.Warn,
            PathSensitivity.Normal -> true
        }

    private fun Project.relativePath(path: String): String =
        basePath?.let { base ->
            if (path.startsWith(base)) path.removePrefix(base).trimStart('/', '\\') else path
        } ?: path
}
