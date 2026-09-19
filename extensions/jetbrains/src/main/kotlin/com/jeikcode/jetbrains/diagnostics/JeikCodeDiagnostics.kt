package com.jeikcode.jetbrains.diagnostics

import com.jeikcode.jetbrains.security.SecretRedactor
import com.intellij.openapi.application.ApplicationInfo
import com.intellij.openapi.project.Project

object JeikCodeDiagnostics {
    fun summary(project: Project, rawDetails: String = ""): String {
        val text = buildString {
            appendLine("JeikCode JetBrains diagnostics")
            appendLine("IDE: ${ApplicationInfo.getInstance().fullVersion}")
            appendLine("Project: ${project.name}")
            if (rawDetails.isNotBlank()) {
                appendLine("Details:")
                appendLine(rawDetails)
            }
        }
        return SecretRedactor.redact(text)
    }
}

