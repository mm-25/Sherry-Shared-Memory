package dev.sherry.capture

import dev.sherry.capture.core.CaptureFactory
import dev.sherry.capture.core.CaptureJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

@Serializable
data class Connection(
    val workspaceId: String,
    val accessToken: String,
    val refreshToken: String? = null,
    val expiresAt: Long = 0,
    val userId: String? = null,
    val email: String = "",
    val workspaceName: String = "Personal space",
    val needsReconnect: Boolean = false,
)

class AccountRequiredException(message: String = "Sign in to Sherry again. Your waiting messages are safe.") : Exception(message)
class AccountUnavailableException : Exception("Sherry could not connect right now. Your waiting messages are safe; try again.")

/** Public-client account calls only. Never stores passwords or logs response bodies/tokens. */
class AccountClient(
    private val baseUrl: String = SUPABASE_URL,
    private val publicKey: String = PUBLIC_KEY,
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(15, TimeUnit.SECONDS).build(),
    private val nowSeconds: () -> Long = { Instant.now().epochSecond },
) {
    fun signIn(email: String, password: String): Connection {
        require(email.isNotBlank() && email.length <= 320 && password.isNotEmpty()) { "Enter your email and password." }
        val session = token("password", buildJsonObject { put("email", email.trim()); put("password", password) })
        val access = (session["access_token"] as? JsonPrimitive)?.contentOrNull ?: throw AccountRequiredException()
        if (!validToken(access)) throw AccountRequiredException()
        val rows = request("/rest/v1/workspaces?select=id,name&limit=2", access = access) as? JsonArray ?: throw AccountUnavailableException()
        if (rows.size != 1) throw AccountRequiredException(if (rows.isEmpty())
            "This account has no Sherry workspace. Open the Sherry website to check your account."
            else "This account has more than one workspace. This app currently supports one Sherry workspace.")
        val workspace = rows.single() as? JsonObject ?: throw AccountUnavailableException()
        val id = workspace["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
        if (!CaptureFactory.validWorkspace(id)) throw AccountRequiredException()
        return parse(session, Connection(id, access, workspaceName = workspace["name"]?.jsonPrimitive?.contentOrNull?.take(200) ?: "Personal space"))
    }

    fun refresh(previous: Connection): Connection {
        val refresh = previous.refreshToken?.takeIf { it.isNotBlank() } ?: throw AccountRequiredException()
        val next = parse(token("refresh_token", buildJsonObject { put("refresh_token", refresh) }), previous)
        if (previous.userId == null || next.userId != previous.userId) throw AccountRequiredException()
        return next
    }

    fun signOut(connection: Connection) {
        request("/auth/v1/logout?scope=local", access = connection.accessToken, body = buildJsonObject {})
    }

    private fun token(grant: String, body: JsonObject): JsonObject =
        request("/auth/v1/token?grant_type=$grant", body = body) as? JsonObject ?: throw AccountUnavailableException()

    private fun validToken(value: String) = value.isNotBlank() && value.length <= 16_000 && value.none { it.code < 33 || it.code > 126 }

    private fun parse(value: JsonObject, previous: Connection): Connection {
        val access = value["access_token"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val refresh = value["refresh_token"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val user = value["user"] as? JsonObject ?: throw AccountRequiredException()
        val id = user["id"]?.jsonPrimitive?.contentOrNull.orEmpty()
        val ttl = value["expires_in"]?.jsonPrimitive?.longOrNull
        val expiry = value["expires_at"]?.jsonPrimitive?.longOrNull ?: ttl?.let { nowSeconds() + it }
        if (!validToken(access) || !validToken(refresh) || !CaptureFactory.validWorkspace(id) ||
            expiry == null || expiry <= nowSeconds() || expiry > nowSeconds() + 86400) throw AccountRequiredException()
        return previous.copy(accessToken = access, refreshToken = refresh, expiresAt = expiry,
            userId = id, email = user["email"]?.jsonPrimitive?.contentOrNull?.take(320) ?: previous.email, needsReconnect = false)
    }

    private fun request(path: String, access: String? = null, body: JsonObject? = null): JsonElement {
        val request = Request.Builder().url(baseUrl + path).header("apikey", publicKey)
        access?.let { request.header("Authorization", "Bearer $it") }
        if (body != null) request.post(body.toString().toRequestBody("application/json".toMediaType())) else request.get()
        try {
            client.newCall(request.build()).execute().use { response ->
                if (response.code in listOf(400, 401, 403)) throw AccountRequiredException("The email, password or session was not accepted. Sign in to Sherry again.")
                if (!response.isSuccessful) throw AccountUnavailableException()
                if (response.code == 204) return JsonNull
                val source = response.body?.source() ?: throw AccountUnavailableException()
                source.request(65_537)
                if (source.buffer.size > 65_536) throw AccountUnavailableException()
                return CaptureJson.parseToJsonElement(source.buffer.readUtf8())
            }
        } catch (error: AccountRequiredException) { throw error }
        catch (error: AccountUnavailableException) { throw error }
        catch (_: Exception) { throw AccountUnavailableException() }
    }

    companion object {
        const val SUPABASE_URL = "https://zwpzmmfpgjaaikacoqas.supabase.co"
        const val PUBLIC_KEY = "sb_publishable_mEtfpCKWHYDKARfWNNO5BA_ouWQWmfN"
    }
}

interface AccountSessionStore {
    fun account(): Connection?
    fun saveSignedIn(next: Connection)
    fun replaceAccount(expected: Connection, next: Connection): Boolean
    fun requireReconnect(expected: Connection)
}

/** One refresh lock is shared by the UI and all upload workers. CAS prevents restoring a signed-out account. */
class AccountManager(
    private val store: AccountSessionStore,
    private val client: AccountClient = AccountClient(),
    private val nowSeconds: () -> Long = { Instant.now().epochSecond },
) {
    private val lock = ReentrantLock()
    fun signIn(email: String, password: String) = lock.withLock { store.saveSignedIn(client.signIn(email, password)) }
    fun current(forceRefresh: Boolean = false): Connection? = lock.withLock {
        val previous = store.account() ?: return null
        if (previous.needsReconnect) throw AccountRequiredException()
        if (!forceRefresh && (previous.expiresAt == 0L || previous.expiresAt > nowSeconds() + 120)) return previous
        try {
            val next = client.refresh(previous)
            if (store.replaceAccount(previous, next)) next else store.account()
        } catch (error: AccountRequiredException) {
            store.requireReconnect(previous)
            throw error
        }
    }
    fun requireReconnect(connection: Connection) = store.requireReconnect(connection)
    fun revoke(connection: Connection) { runCatching { client.signOut(connection) } }
}
