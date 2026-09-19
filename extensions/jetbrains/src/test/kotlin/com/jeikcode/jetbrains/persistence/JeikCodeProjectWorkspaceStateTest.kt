package com.jeikcode.jetbrains.persistence

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class JeikCodeProjectWorkspaceStateTest {
    @Test
    fun `normalized selects first tab when selected tab is missing`() {
        val workspace = JeikCodeProjectWorkspace(
            selectedTabId = "missing",
            tabs = mutableListOf(WorkspaceTabState(tabId = "tab-1")),
        ).normalized()

        assertEquals("tab-1", workspace.selectedTabId)
    }

    @Test
    fun `normalized removes duplicate tab ids`() {
        val workspace = JeikCodeProjectWorkspace(
            tabs = mutableListOf(
                WorkspaceTabState(tabId = "tab-1", title = "One"),
                WorkspaceTabState(tabId = "tab-1", title = "Duplicate"),
            ),
        ).normalized()

        assertEquals(1, workspace.tabs.size)
        assertEquals("One", workspace.tabs.single().title)
    }

    @Test
    fun `tab normalization trims optional identifiers and title`() {
        val tab = WorkspaceTabState(
            tabId = " tab-1 ",
            sessionId = " ",
            projectHash = " hash ",
            workingDir = " /repo ",
            title = " ",
        ).normalized()

        assertEquals("tab-1", tab.tabId)
        assertNull(tab.sessionId)
        assertEquals("hash", tab.projectHash)
        assertEquals("/repo", tab.workingDir)
        assertEquals("Chat", tab.title)
    }

    @Test
    fun `upsert tab inserts then replaces existing tab`() {
        val state = JeikCodeProjectWorkspaceState()

        state.upsertTab(WorkspaceTabState(tabId = "tab-1", title = "First"))
        state.upsertTab(WorkspaceTabState(tabId = "tab-1", title = "Updated"))

        assertEquals(1, state.state.tabs.size)
        assertEquals("Updated", state.state.tabs.single().title)
        assertEquals("tab-1", state.state.selectedTabId)
    }

    @Test
    fun `remove selected tab selects next tab`() {
        val state = JeikCodeProjectWorkspaceState()
        state.upsertTab(WorkspaceTabState(tabId = "tab-1"))
        state.upsertTab(WorkspaceTabState(tabId = "tab-2"))
        state.selectTab("tab-1")

        state.removeTab("tab-1")

        assertEquals("tab-2", state.state.selectedTabId)
        assertEquals(listOf("tab-2"), state.state.tabs.map { it.tabId })
    }
}
