package dev.sherry.capture

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.*

class AuthSessionTest {
    private val workspace = "7c895c18-05e4-4f96-9148-37ad93b2a789"
    private val user = "7c895c18-05e4-4f96-9148-37ad93b2a781"
    private fun token(id: String = user) = """{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"user":{"id":"$id","email":"demo@example.com"}}"""
    private fun connection() = Connection(workspace, "old-access", "old-refresh", 100, user, "demo@example.com", "Personal")
    private fun client(server: MockWebServer) = AccountClient(server.url("/").toString().trimEnd('/'), "test-public-key", OkHttpClient(), { 1000L })
    private class MemoryStore(value: Connection?) : AccountSessionStore {
        val value = AtomicReference(value)
        var writes = 0
        override fun account() = value.get()
        override fun saveSignedIn(next: Connection) { value.set(next); writes++ }
        override fun replaceAccount(expected: Connection, next: Connection): Boolean = value.compareAndSet(expected, next).also { if (it) writes++ }
        override fun requireReconnect(expected: Connection) { value.compareAndSet(expected, expected.copy(needsReconnect = true)) }
    }
    @Test fun `ordinary login discovers only the authorized workspace and never saves a password`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(token()))
            s.enqueue(MockResponse().setBody("""[{"id":"$workspace","name":"Personal"}]"""))
            val c = client(s).signIn("demo@example.com", "private-password")
            assertEquals(workspace, c.workspaceId); assertEquals("new-refresh", c.refreshToken); assertEquals(4600, c.expiresAt)
            val login = s.takeRequest(); assertEquals("/auth/v1/token?grant_type=password", login.path)
            assertEquals("test-public-key", login.getHeader("apikey"))
            assertTrue(login.body.readUtf8().contains("private-password"))
            assertEquals("Bearer new-access", s.takeRequest().getHeader("Authorization"))
            assertFalse(c.toString().contains("private-password"))
        }
    }
    @Test fun `failed password and ambiguous workspace do not become connections`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(400).setBody("""{"error":"private-token-do-not-show"}"""))
            val e=assertFailsWith<AccountRequiredException>{client(s).signIn("demo@example.com","wrong")}
            assertFalse(e.message.orEmpty().contains("private-token"))
            s.enqueue(MockResponse().setBody(token()));s.enqueue(MockResponse().setBody("[]"))
            assertFailsWith<AccountRequiredException>{client(s).signIn("demo@example.com","password")}
            s.enqueue(MockResponse().setBody(token()));s.enqueue(MockResponse().setBody("""[{"id":"$workspace","name":"One"},{"id":"$user","name":"Two"}]"""))
            assertFailsWith<AccountRequiredException>{client(s).signIn("demo@example.com","password")}
        }
    }
    @Test fun `refresh rotates both tokens and rejects an identity change`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(token()))
            val next=client(s).refresh(connection());assertEquals("new-refresh",next.refreshToken);assertEquals(workspace,next.workspaceId)
            assertEquals("/auth/v1/token?grant_type=refresh_token",s.takeRequest().path)
            s.enqueue(MockResponse().setBody(token(workspace)))
            assertFailsWith<AccountRequiredException>{client(s).refresh(connection())}
        }
    }
    @Test fun `malformed auth data is rejected without displaying its private values`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody("""{"access_token":"private\nvalue"}"""))
            val e=assertFailsWith<AccountRequiredException>{client(s).signIn("demo@example.com","password")}
            assertFalse(e.message.orEmpty().contains("private"));assertEquals(1,s.requestCount)
            s.enqueue(MockResponse().setBody("[]"))
            assertFailsWith<AccountUnavailableException>{client(s).signIn("demo@example.com","password")}
            s.enqueue(MockResponse().setBody(token()));s.enqueue(MockResponse().setBody("{}"))
            assertFailsWith<AccountUnavailableException>{client(s).signIn("demo@example.com","password")}
        }
    }
    @Test fun `concurrent upload and UI refresh use one token rotation`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(token()).setBodyDelay(100,TimeUnit.MILLISECONDS))
            val store=MemoryStore(connection());val manager=AccountManager(store,client(s)){1000L}
            val threads=Executors.newFixedThreadPool(2)
            try { val tasks=(1..2).map{threads.submit<Connection?>{manager.current()}};assertTrue(tasks.all{it.get(3,TimeUnit.SECONDS)?.accessToken=="new-access"});assertEquals(1,s.requestCount);assertEquals(1,store.writes) }
            finally {threads.shutdownNow()}
        }
    }
    @Test fun `temporary refresh failure retains a usable reconnectable record`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setResponseCode(503));val old=connection();val store=MemoryStore(old);val manager=AccountManager(store,client(s)){1000L}
            assertFailsWith<AccountUnavailableException>{manager.current()};assertEquals(old,store.account());assertFalse(store.account()!!.needsReconnect)
            s.enqueue(MockResponse().setResponseCode(400));assertFailsWith<AccountRequiredException>{manager.current()};assertTrue(store.account()!!.needsReconnect)
        }
    }
    @Test fun `an in-flight refresh cannot sign back in after sign out`() {
        MockWebServer().use { s ->
            s.enqueue(MockResponse().setBody(token()).setBodyDelay(150,TimeUnit.MILLISECONDS));val store=MemoryStore(connection());val manager=AccountManager(store,client(s)){1000L};val t=Executors.newSingleThreadExecutor()
            try {val future=t.submit<Connection?>{manager.current()};s.takeRequest(2,TimeUnit.SECONDS);store.value.set(null);assertNull(future.get(3,TimeUnit.SECONDS));assertNull(store.account())}finally{t.shutdownNow()}
        }
    }
}
