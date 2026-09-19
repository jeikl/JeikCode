package com.jeikcode.jetbrains.settings

import kotlin.test.Test
import kotlin.test.assertEquals

class JeikCodeSettingsStateTest {

    @Test
    fun `normalized replaces blank host with default`() {
        val settings = JeikCodeSettings(host = "  ")
        val result = settings.normalized()
        assertEquals("127.0.0.1", result.host)
    }

    @Test
    fun `normalized replaces empty host with default`() {
        val settings = JeikCodeSettings(host = "")
        val result = settings.normalized()
        assertEquals("127.0.0.1", result.host)
    }

    @Test
    fun `normalized replaces zero port with default`() {
        val settings = JeikCodeSettings(port = 0)
        val result = settings.normalized()
        assertEquals(13456, result.port)
    }

    @Test
    fun `normalized replaces negative port with default`() {
        val settings = JeikCodeSettings(port = -1)
        val result = settings.normalized()
        assertEquals(13456, result.port)
    }

    @Test
    fun `normalized replaces zero timeout with default`() {
        val settings = JeikCodeSettings(requestTimeoutMs = 0)
        val result = settings.normalized()
        assertEquals(30_000, result.requestTimeoutMs)
    }

    @Test
    fun `normalized replaces negative timeout with default`() {
        val settings = JeikCodeSettings(requestTimeoutMs = -100)
        val result = settings.normalized()
        assertEquals(30_000, result.requestTimeoutMs)
    }

    @Test
    fun `normalized replaces zero font size with default`() {
        val settings = JeikCodeSettings(chatFontSize = 0)
        val result = settings.normalized()
        assertEquals(13, result.chatFontSize)
    }

    @Test
    fun `normalized replaces negative font size with default`() {
        val settings = JeikCodeSettings(chatFontSize = -5)
        val result = settings.normalized()
        assertEquals(13, result.chatFontSize)
    }

    @Test
    fun `normalized preserves valid values`() {
        val settings = JeikCodeSettings(
            host = "192.168.1.1",
            port = 8080,
            requestTimeoutMs = 5000,
            chatFontSize = 16,
        )
        val result = settings.normalized()
        assertEquals("192.168.1.1", result.host)
        assertEquals(8080, result.port)
        assertEquals(5000, result.requestTimeoutMs)
        assertEquals(16, result.chatFontSize)
    }

    @Test
    fun `normalized preserves autoStart setting`() {
        assertEquals(false, JeikCodeSettings(autoStart = false).normalized().autoStart)
        assertEquals(true, JeikCodeSettings(autoStart = true).normalized().autoStart)
    }

    @Test
    fun `normalized preserves context level`() {
        val settings = JeikCodeSettings(contextLevel = JeikCodeContextLevel.ProjectContext)
        assertEquals(JeikCodeContextLevel.ProjectContext, settings.normalized().contextLevel)
    }

    @Test
    fun `update applies normalization via getState`() {
        val state = JeikCodeSettingsState()
        state.update { it.host = "  " }
        val result = state.getState()
        assertEquals("127.0.0.1", result.host)
    }
}
