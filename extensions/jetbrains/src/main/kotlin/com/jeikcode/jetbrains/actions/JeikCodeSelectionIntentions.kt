package com.jeikcode.jetbrains.actions

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile

abstract class JeikCodeSelectionIntention(
    private val title: String,
    private val instruction: String?,
) : IntentionAction {
    override fun getText(): String = title

    override fun getFamilyName(): String = "JeikCode"

    override fun isAvailable(project: Project, editor: Editor, file: PsiFile): Boolean =
        if (instruction == null) editor.selectionModel.hasSelection() || editor.document.text.isNotBlank()
        else EditorJeikCodeActions.canSendSelectedText(editor)

    override fun invoke(project: Project, editor: Editor, file: PsiFile) {
        if (instruction == null) {
            EditorJeikCodeActions.addEditorContext(project, editor)
        } else {
            EditorJeikCodeActions.sendSelectionCommand(project, editor, instruction)
        }
    }

    override fun startInWriteAction(): Boolean = false
}

class ExplainSelectionIntention : JeikCodeSelectionIntention(
    "JeikCode：解释选中内容",
    "请解释这段代码。它做了什么，为什么这样实现？",
)

class FixSelectionIntention : JeikCodeSelectionIntention(
    "JeikCode：修复选中内容",
    "请修复这段代码中的错误或问题。",
)

class OptimizeSelectionIntention : JeikCodeSelectionIntention(
    "JeikCode：优化选中内容",
    "请优化这段代码，提升性能和可读性。",
)

class AddContextIntention : JeikCodeSelectionIntention(
    "JeikCode：添加选中内容/文件为上下文",
    null,
)
