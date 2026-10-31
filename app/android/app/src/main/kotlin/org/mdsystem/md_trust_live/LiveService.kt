package org.mdsystem.md_trust_live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.security.SecureRandom
import java.util.UUID
import java.math.BigInteger
import java.nio.ByteBuffer

/** User-visible signed heartbeat service, independent of the Flutter UI lifecycle. */
class LiveService : Service() {
    companion object { @Volatile var active = false }
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private var state: JSONObject? = null
    private var pending: JSONObject? = null
    private var started = false
    private var stopping = false
    private var wakeLock: PowerManager.WakeLock? = null
    private lateinit var protocol: TrustProtocol
    private val prefs by lazy { getSharedPreferences("mdtl", MODE_PRIVATE) }

    override fun onCreate() {
        // Establish a visible notification before performing network work.
        super.onCreate()
        active = true
        protocol = TrustProtocol(this)
        startForeground(2101, localizedNotification())
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MDTL:LiveSession")
    }

    private fun localizedNotification(): Notification {
        // Match the app's manual locale while retaining Android's automatic fallback.
        val configuration = android.content.res.Configuration(resources.configuration)
        val language = prefs.getString("language", "auto") ?: "auto"
        if (language != "auto") configuration.setLocale(java.util.Locale.forLanguageTag(language))
        val localized = createConfigurationContext(configuration)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("mdtl_live", localized.getString(R.string.mdtl_active), NotificationManager.IMPORTANCE_LOW))
        val stopIntent = PendingIntent.getService(this, 2, Intent(this, LiveService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val openIntent = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Builder(this, "mdtl_live").setContentTitle("MD Trust Live")
            .setContentText(localized.getString(R.string.mdtl_intro))
            .setSmallIcon(android.R.drawable.ic_lock_lock).setContentIntent(openIntent).setOngoing(true)
            .addAction(Notification.Action.Builder(null, localized.getString(R.string.mdtl_stop), stopIntent).build()).build()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Only explicit user starts resume a session; do not restart silently after kill.
        if (intent?.action == "LANGUAGE_CHANGED") {
            getSystemService(NotificationManager::class.java).notify(2101, localizedNotification())
        } else if (intent?.action == "STOP") {
            stopping = true
            worker.execute {
                try {
                    val current = state ?: protocol.request("/v1/session/start", JSONObject())
                    if (current.getInt("next_seq") > 0) {
                        protocol.request("/v1/events", protocol.event(current, "SESSION_END", JSONObject().put("reason", "user_stop")))
                    }
                    prefs.edit().putString("status", "Session ended").apply()
                } catch (error: Exception) {
                    prefs.edit().putString("status", "Stopped locally; server will mark signal offline").apply()
                    Log.w("MDTL", "Session end request failed: ${error.javaClass.simpleName}")
                } finally { stopSelf() }
            }
        } else if (intent?.action?.startsWith("giveaway") == true) {
            worker.execute {
                try { giveaway(intent.action!!, intent.getStringExtra("prize") ?: "") }
                catch (error: Exception) { prefs.edit().putString("status", error.message ?: "Giveaway failed").apply() }
            }
        } else if (!started) {
            started = true
            prefs.edit().putBoolean("running", true).putString("status", "Connecting").apply()
            worker.scheduleWithFixedDelay({ pulse() }, 0, 5, TimeUnit.SECONDS)
        }
        return START_NOT_STICKY
    }

    private fun pulse() {
        // Persist exact unacknowledged events, recover the authoritative head on errors.
        if (stopping) return
        try {
            if (wakeLock?.isHeld != true) wakeLock?.acquire(10 * 60 * 1000L)
            if (state == null) {
                state = protocol.request("/v1/session/start", JSONObject())
                pending = prefs.getString("pending", null)?.let { JSONObject(it) }
            }
            val current = state!!
            if (pending == null) {
                val first = current.getInt("next_seq") == 0
                val payload = if (first) JSONObject().put("app_ver", "0.1.0").put("device_id", prefs.getString("device", "")).put("geo_enabled", false) else JSONObject().put("net", "android")
                pending = protocol.event(current, if (first) "SESSION_START" else "PULSE", payload)
                prefs.edit().putString("pending", pending.toString()).commit()
            }
            val response = protocol.request("/v1/events", pending!!)
            response.put("session_id", current.getString("session_id"))
            acknowledge(pending!!)
            state = response; pending = null
            prefs.edit().remove("pending").putInt("seq", response.getInt("next_seq"))
                .putString("head", response.getString("head_hash")).putString("status", "Signed pulse acknowledged").apply()
        } catch (error: Exception) {
            prefs.edit().putString("status", error.message?.take(180) ?: "Connection unavailable").apply()
            Log.w("MDTL", "Pulse failed: ${error.javaClass.simpleName}")
            try {
                val fresh = protocol.request("/v1/session/challenge", JSONObject())
                val old = pending?.getJSONObject("header")
                // A committed event is recognized by its head; stale unsent pulses are rebuilt.
                val nonceEvent = old?.optString("type") in listOf("SESSION_START", "PULSE")
                val stalePulse = old != null && nonceEvent && System.currentTimeMillis() - old.getLong("client_ts_ms") > 30000
                // A pending event from a closed session must never enter a new session.
                val previousSession = old != null && old.getString("session_id") != fresh.getString("session_id")
                if (old == null || previousSession || fresh.getInt("next_seq") > old.getInt("seq") || stalePulse) {
                    if (pending != null && fresh.getString("head_hash") == pending!!.getString("event_hash")) acknowledge(pending!!)
                    pending = null; prefs.edit().remove("pending").apply()
                }
                state = fresh
            } catch (_: Exception) { /* Keep exact pending bytes until connectivity returns. */ }
        }
    }

    private fun acknowledge(event: JSONObject) {
        // Persist business progress only after a matching server acknowledgement.
        val type = event.getJSONObject("header").getString("type")
        val phase = mapOf("GIVEAWAY_OPEN" to "OPEN", "GIVEAWAY_LOCK" to "LOCKED", "GIVEAWAY_REVEAL" to "REVEALED", "GIVEAWAY_RESULT" to "COMPLETE")[type]
        if (phase != null) {
            val edit = prefs.edit().putString("giveaway_phase", phase)
            if (phase == "COMPLETE") edit.putString("giveaway_result", "Winner: " + event.getJSONObject("payload").getString("winner_user_key"))
            edit.commit()
        }
    }

    private fun sendEvent(type: String, payload: JSONObject) {
        // Serialize giveaway events on the same worker and chain as heartbeats.
        check(pending == null) { "Wait for the pending event to be acknowledged" }
        val current = state ?: throw IllegalStateException("Wait for the session to connect")
        pending = protocol.event(current, type, payload)
        prefs.edit().putString("pending", pending.toString()).commit()
        val response = protocol.request("/v1/events", pending!!)
        response.put("session_id", current.getString("session_id"))
        acknowledge(pending!!); state = response; pending = null
        prefs.edit().remove("pending").putInt("seq", response.getInt("next_seq"))
            .putString("head", response.getString("head_hash")).putString("status", "$type acknowledged").apply()
    }

    private fun giveaway(action: String, prize: String) {
        // Store commit-reveal seed privately and independently recompute the index.
        check(state != null && state!!.getInt("next_seq") > 0) { "Wait for the first pulse" }
        check(pending == null) { "A network retry is pending" }
        if (action == "giveawayOpen") {
            require(prize.isNotBlank() && prize.length <= 200) { "Enter a prize of 1–200 characters" }
            check(prefs.getString("giveaway_phase", "NONE") in listOf("NONE", "COMPLETE")) { "Finish the current giveaway first" }
            val seed = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val id = UUID.randomUUID().toString()
            prefs.edit().putString("giveaway_id", id).putString("giveaway_seed", seed.joinToString("") { "%02x".format(it) }).commit()
            sendEvent("GIVEAWAY_OPEN", JSONObject().put("giveaway_id", id).put("prize", prize).put("seed_commit", protocol.hash(seed)))
        } else {
            val id = prefs.getString("giveaway_id", null) ?: throw IllegalStateException("Open a giveaway first")
            if (action == "giveawayLock") {
                val locked = protocol.request("/v1/giveaway/lock-request", JSONObject().put("giveaway_id", id))
                prefs.edit().putString("giveaway_lock", locked.toString()).commit()
                sendEvent("GIVEAWAY_LOCK", locked)
            } else if (action == "giveawayDraw") {
                val seed = prefs.getString("giveaway_seed", null) ?: throw IllegalStateException("Local seed unavailable")
                if (prefs.getString("giveaway_phase", "") == "LOCKED") sendEvent("GIVEAWAY_REVEAL", JSONObject().put("giveaway_id", id).put("seed", seed))
                check(prefs.getString("giveaway_phase", "") == "REVEALED") { "Lock the participant list first" }
                val locked = JSONObject(prefs.getString("giveaway_lock", "{}")!!)
                val bytes = (seed + locked.getString("entries_hash")).chunked(2).map { it.toInt(16).toByte() }.toByteArray()
                val count = locked.getLong("entries_count")
                val index = BigInteger(protocol.hash(bytes + ByteBuffer.allocate(8).putLong(count).array()), 16).mod(BigInteger.valueOf(count)).toInt()
                val result = protocol.request("/v1/giveaway/result-preview", JSONObject().put("giveaway_id", id))
                check(result.getInt("winner_index") == index) { "Server draw disagrees with local computation" }
                sendEvent("GIVEAWAY_RESULT", result)
            }
        }
    }

    override fun onDestroy() {
        // Release CPU wake lock and executor when the user stops the service.
        active = false; stopping = true; worker.shutdownNow()
        if (wakeLock?.isHeld == true) wakeLock?.release()
        prefs.edit().putBoolean("running", false).apply()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? {
        // Flutter communicates through the activity's channel, not a bound service.
        return null
    }
}
