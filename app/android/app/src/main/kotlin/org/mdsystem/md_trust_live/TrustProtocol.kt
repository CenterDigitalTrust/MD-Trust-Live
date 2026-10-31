package org.mdsystem.md_trust_live

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** MDTL transport and signing; derived from MDFP's MIT Keystore approach. */
class TrustProtocol(context: Context) {
    private val prefs = context.getSharedPreferences("mdtl", Context.MODE_PRIVATE)
    private val alias = "mdtl_device_key_v1"
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    init {
        // Preserve the existing identity across restarts and network retries.
        if (!keyStore.containsAlias(alias)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256).build())
            generator.generateKeyPair()
        }
    }

    fun canonical(value: Any?): String {
        // Match TypeScript key order and JSON escaping with integer-only numbers.
        return when (value) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
                canonical(it) + ":" + canonical(value.get(it))
            }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            is String -> buildString {
                append('"')
                var i = 0
                while (i < value.length) {
                    val c = value[i]
                    when (c) {
                        '"' -> append("\\\"")
                        '\\' -> append("\\\\")
                        '\b' -> append("\\b")
                        '\u000c' -> append("\\f")
                        '\n' -> append("\\n")
                        '\r' -> append("\\r")
                        '\t' -> append("\\t")
                        else -> {
                            if (c.code < 32) append("\\u%04x".format(c.code))
                            else if (Character.isHighSurrogate(c)) {
                                require(i + 1 < value.length && Character.isLowSurrogate(value[i + 1])) { "Unpaired surrogate" }
                                append(c); append(value[++i])
                            } else { require(!Character.isLowSurrogate(c)) { "Unpaired surrogate" }; append(c) }
                        }
                    }
                    i++
                }
                append('"')
            }
            is Boolean -> value.toString()
            is Int, is Long -> {
                val n = (value as Number).toLong()
                require(n in -9007199254740991L..9007199254740991L) { "Unsafe integer" }
                n.toString()
            }
            else -> throw IllegalArgumentException("Unsupported canonical value")
        }
    }

    fun hash(data: ByteArray): String {
        // Standard SHA-256 digest encoded without locale-dependent formatting.
        return MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }
    }

    fun sign(text: String): String {
        // The private key remains in Android Keystore; output is DER/base64.
        val signer = Signature.getInstance("SHA256withECDSA")
        signer.initSign(keyStore.getKey(alias, null) as PrivateKey)
        signer.update(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    }

    fun pair(base: String, code: String): JSONObject {
        // Require HTTPS so pairing proof and future authorization stay encrypted.
        require(URL(base).protocol == "https") { "The server URL must use HTTPS" }
        require(code.matches(Regex("[0-9]{6}"))) { "Enter the six-digit pairing code" }
        val spki = Base64.encodeToString(keyStore.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP)
        val response = post(base.trimEnd('/'), "/v1/pair/complete", JSONObject().put("code", code).put("spki", spki).put("signature", sign("MDTL1-PAIR\n$code")), false)
        prefs.edit().putString("base", base.trimEnd('/')).putString("device", response.getString("device_id"))
            .putString("channel", response.getString("channel_id")).apply()
        return response
    }

    fun request(path: String, body: JSONObject): JSONObject {
        // All device operations use the same signed canonical request envelope.
        val base = prefs.getString("base", null) ?: throw IllegalStateException("Pair a device first")
        return post(base, path, body, true)
    }

    private fun post(base: String, path: String, body: JSONObject, authorized: Boolean): JSONObject {
        // Bounded connection, response size and explicit HTTP failure handling.
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"; connection.connectTimeout = 8000; connection.readTimeout = 8000
            connection.instanceFollowRedirects = false; connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            val encoded = canonical(body)
            if (authorized) {
                val now = System.currentTimeMillis()
                val signature = sign("MDTL1-REQ\nPOST\n$path\n$now\n" + hash(encoded.toByteArray(Charsets.UTF_8)))
                connection.setRequestProperty("Authorization", "MDTL1 device_id=${prefs.getString("device", "")},ts=$now,sig=$signature")
            }
            connection.outputStream.use { it.write(encoded.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText().take(65536) } ?: "{}"
            if (status !in 200..299) throw IllegalStateException("Server HTTP $status: " + runCatching { JSONObject(text).optString("error") }.getOrDefault("Request failed"))
            return JSONObject(text)
        } finally { connection.disconnect() }
    }

    fun event(state: JSONObject, type: String, payload: JSONObject): JSONObject {
        // Bind the next event to the acknowledged chain head and current challenge.
        val header = JSONObject().put("v", 1).put("channel_id", prefs.getString("channel", ""))
            .put("session_id", state.getString("session_id")).put("seq", state.getInt("next_seq"))
            .put("type", type).put("client_ts_ms", System.currentTimeMillis()).put("prev_hash", state.getString("head_hash"))
            .put("payload_hash", hash(canonical(payload).toByteArray(Charsets.UTF_8)))
            .put("challenge", if (type == "SESSION_END") "" else state.getJSONObject("next_challenge").getString("nonce"))
        val signature = sign("MDTL1\n" + canonical(header))
        return JSONObject().put("header", header).put("payload", payload).put("signature", signature)
            .put("event_hash", hash(("MDTL1-EVT\n" + canonical(header) + "\n" + signature).toByteArray(Charsets.UTF_8)))
    }

    fun snapshot(): Map<String, Any> {
        // Expose operational status only; no private credentials cross the UI bridge.
        return mapOf("paired" to prefs.contains("device"), "channel" to (prefs.getString("channel", "") ?: ""),
            "status" to (prefs.getString("status", "Ready") ?: "Ready"), "seq" to prefs.getInt("seq", 0),
            "hash" to (prefs.getString("head", "") ?: ""), "running" to LiveService.active,
            "giveaway_phase" to (prefs.getString("giveaway_phase", "NONE") ?: "NONE"),
            "giveaway_result" to (prefs.getString("giveaway_result", "") ?: ""))
    }
}
