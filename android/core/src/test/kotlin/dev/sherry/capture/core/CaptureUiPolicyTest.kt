package dev.sherry.capture.core

import kotlin.test.*

class CaptureUiPolicyTest {
    @Test fun `upgrade preserves a legacy pause instead of beginning capture`() {
        assertFalse(captureMasterEnabled(true, true, 0))
        assertTrue(captureMasterEnabled(true, false, 0))
        assertFalse(captureMasterEnabled(false, false, 0))
    }
    @Test fun `new capture control is independent of delivery pause`() {
        assertTrue(captureMasterEnabled(true, true, 1))
        assertFalse(captureMasterEnabled(false, false, 1))
    }
    @Test fun `recent messages survive receipt and replay without copies`() {
        val capture = CaptureFactory.share(Provider.CHATGPT, "A useful message", "Atlas", "user")
        val first = rememberRecent(emptyList(), listOf(capture), null)
        val replay = rememberRecent(first, listOf(capture), null)
        assertEquals(1, replay.size)
        assertEquals("A useful message", replay.single().text)
        assertEquals("pending", replay.single().delivery)
    }
    @Test fun `recent history keeps the newest fifty and a bounded text footprint`() {
        val captures = (1..70).map { CaptureFactory.share(Provider.CHATGPT, "Message $it", "Atlas") }
        val recent = rememberRecent(emptyList(), captures, null)
        assertEquals(50, recent.size)
        assertEquals(captures.takeLast(50).map { it.id }, recent.map { it.id })
        val large = (1..50).map { CaptureFactory.share(Provider.CHATGPT, "界".repeat(15_000), "Atlas") }
        assertTrue(rememberRecent(emptyList(), large, null).sumOf { it.text.toByteArray().size } <= 2_000_000)
    }
    @Test fun `old waiting records projected later cannot evict the fifty newly captured messages`() {
        fun saved(number:Int,day:String)=CaptureFactory.share(Provider.CHATGPT,"Message $number","Atlas").let { capture->
            capture.copy(event=capture.event.copy(capturedAt="2026-10-$day"+"T12:00:00Z"))
        }
        val fresh=(1..50).map{saved(it,"28")}
        val older=(51..70).map{saved(it,"02")}
        val recent=rememberRecent(emptyList(),fresh,null)
        val projected=rememberRecent(recent,older,null)
        assertEquals(fresh.map{it.id},projected.map{it.id})
        assertEquals(50,projected.size)
    }

    @Test fun `Test shows newest source turns first even when older history was captured later`() {
        val rows=listOf(
            RecentCapture("question",Provider.CHATGPT,"a","Active chat","user","Question","2026-10-28T11:00:00Z",sequence=500001),
            RecentCapture("older",Provider.CHATGPT,"a","Active chat","user","Backfilled history","2026-10-28T12:00:00Z",sequence=500000),
            RecentCapture("reply",Provider.CHATGPT,"a","Active chat","assistant","Reply","2026-10-28T10:00:00Z",sequence=500002))
        assertEquals(listOf("reply","question","older"),recentConversationGroups(rows).single().map{it.id})
        assertEquals(listOf("assistant","user","user"),recentConversationGroups(rows).single().map{it.role})
        assertEquals(listOf("question","older","reply"),rows.map{it.id})
    }
    @Test fun `Test uses actual capture instants newest first when legacy sequences tie`() {
        val rows=listOf(
            RecentCapture("older",Provider.CHATGPT,"a","Legacy","user","Earlier","2026-10-28T10:30:00Z"),
            RecentCapture("latest",Provider.CHATGPT,"a","Legacy","assistant","Later","2026-10-28T07:00:00-04:00"),
            RecentCapture("unknown",Provider.CHATGPT,"a","Legacy","user","Unknown date",""))
        assertEquals(listOf("latest","older","unknown"),recentConversationGroups(rows).single().map{it.id})
    }

    @Test fun `website navigation accepts only the exact trusted HTTPS origin`() {
        assertTrue(trustedWebsiteUrl("https://shared-memory-ingestion.mufaddal-m25.workers.dev/#memory"))
        assertFalse(trustedWebsiteUrl("http://shared-memory-ingestion.mufaddal-m25.workers.dev/"))
        assertFalse(trustedWebsiteUrl("https://shared-memory-ingestion.mufaddal-m25.workers.dev.attacker.test/"))
        assertFalse(trustedWebsiteUrl("https://evil@shared-memory-ingestion.mufaddal-m25.workers.dev/"))
        assertFalse(trustedWebsiteUrl("javascript:alert(1)"))
        assertFalse(trustedWebsiteUrl("https://shared-memory-ingestion.mufaddal-m25.workers.dev:444/"))
    }
}
