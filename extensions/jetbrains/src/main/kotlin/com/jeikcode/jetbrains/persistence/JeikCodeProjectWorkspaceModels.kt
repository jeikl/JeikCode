package com.jeikcode.jetbrains.persistence

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
@State(name = "JeikCodeProjectWorkspace", storages = [Storage("jeikcodeWorkspace.xml")])
class JeikCodeProjectWorkspaceState : PersistentStateComponent<JeikCodeProjectWorkspace> {
    private var workspace = JeikCodeProjectWorkspace()

    override fun getState(): JeikCodeProjectWorkspace = workspace

    override fun loadState(state: JeikCodeProjectWorkspace) {
        workspace = state.normalized()
    }

    fun update(block: (JeikCodeProjectWorkspace) -> Unit) {
        val next = workspace.copy(tabs = workspace.tabs.map { it.copy() }.toMutableList())
        block(next)
        workspace = next.normalized()
    }

    fun upsertTab(tab: WorkspaceTabState) {
        update { workspace ->
            val normalizedTab = tab.normalized()
            val index = workspace.tabs.indexOfFirst { it.tabId == normalizedTab.tabId }
            if (index >= 0) {
                workspace.tabs[index] = normalizedTab
            } else {
                workspace.tabs += normalizedTab
            }
            if (workspace.selectedTabId == null) {
                workspace.selectedTabId = normalizedTab.tabId
            }
        }
    }

    fun selectTab(tabId: String) {
        update { workspace ->
            if (workspace.tabs.any { it.tabId == tabId }) {
                workspace.selectedTabId = tabId
            }
        }
    }

    fun removeTab(tabId: String) {
        update { workspace ->
            workspace.tabs.removeAll { it.tabId == tabId }
            if (workspace.selectedTabId == tabId) {
                workspace.selectedTabId = workspace.tabs.firstOrNull()?.tabId
            }
        }
    }

    companion object {
        fun getInstance(project: Project): JeikCodeProjectWorkspaceState =
            project.getService(JeikCodeProjectWorkspaceState::class.java)
    }
}

data class JeikCodeProjectWorkspace(
    var selectedTabId: String? = null,
    var tabs: MutableList<WorkspaceTabState> = mutableListOf(),
)

data class WorkspaceTabState(
    var tabId: String = "",
    var sessionId: String? = null,
    var projectHash: String? = null,
    var workingDir: String? = null,
    var title: String = "Chat",
    var draft: String = "",
)

data class PersistedContextItem(
    var path: String = "",
    var displayName: String = "",
    var selectionStartLine: Int? = null,
    var selectionEndLine: Int? = null,
)

internal fun JeikCodeProjectWorkspace.normalized(): JeikCodeProjectWorkspace {
    val normalizedTabs = tabs
        .map { it.normalized() }
        .distinctBy { it.tabId }
        .toMutableList()
    tabs = normalizedTabs
    selectedTabId = selectedTabId?.takeIf { selected -> normalizedTabs.any { it.tabId == selected } }
        ?: normalizedTabs.firstOrNull()?.tabId
    return this
}

internal fun WorkspaceTabState.normalized(): WorkspaceTabState {
    tabId = tabId.trim()
    sessionId = sessionId?.trim()?.takeIf { it.isNotEmpty() }
    projectHash = projectHash?.trim()?.takeIf { it.isNotEmpty() }
    workingDir = workingDir?.trim()?.takeIf { it.isNotEmpty() }
    title = title.trim().ifBlank { "Chat" }
    return this
}
