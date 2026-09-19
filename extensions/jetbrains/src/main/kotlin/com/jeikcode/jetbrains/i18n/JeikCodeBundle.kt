package com.jeikcode.jetbrains.i18n

import java.text.MessageFormat
import java.util.Locale
import java.util.ResourceBundle

internal object JeikCodeBundle {
    private const val BUNDLE = "messages.JeikCodeBundle"

    fun message(key: String, vararg params: Any): String =
        message(Locale.getDefault(), key, *params)

    fun message(locale: Locale, key: String, vararg params: Any): String {
        val bundleLocale = if (locale.language.equals("zh", ignoreCase = true)) Locale.CHINESE else Locale.ROOT
        val pattern = ResourceBundle.getBundle(BUNDLE, bundleLocale).getString(key)
        if (params.isEmpty()) return pattern
        return MessageFormat(pattern, locale).format(params)
    }
}
