package com.jeikcode.jetbrains.security

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class JeikCodeTokenFactoryTest {

    @Test
    fun `createToken returns a 43 character string`() {
        val token = JeikCodeTokenFactory.createToken()
        assertEquals(43, token.length)
    }

    @Test
    fun `createToken contains no padding characters`() {
        val token = JeikCodeTokenFactory.createToken()
        assertFalse('=' in token)
    }

    @Test
    fun `createToken contains only URL-safe Base64 characters`() {
        val validChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val token = JeikCodeTokenFactory.createToken()
        assertTrue(token.all { it in validChars })
    }

    @Test
    fun `createToken produces different values on subsequent calls`() {
        val token1 = JeikCodeTokenFactory.createToken()
        val token2 = JeikCodeTokenFactory.createToken()
        assertFalse(token1 == token2)
    }

    @Test
    fun `createToken does not contain URL-unsafe characters`() {
        val token = JeikCodeTokenFactory.createToken()
        assertFalse('/' in token)
        assertFalse('+' in token)
    }
}
