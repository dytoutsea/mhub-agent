package com.mhub.agent.tunnel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidDataStreamTest {
  @Test
  fun normalizesWssAndEncodesTheConnectionPathSegment() {
    val base = normalizeDataWebSocketBaseUrl("wss://relay.example/agent/v1/data")
    val streamUrl = base.newBuilder().addPathSegment("rcn_1/2").build()

    assertEquals("https", base.scheme)
    assertEquals("https://relay.example/agent/v1/data/rcn_1%2F2", streamUrl.toString())
  }

  @Test
  fun parsesPublicIpLiteralsWithoutResolvingDomains() {
    val publicV4 = parseIpLiteral("8.8.8.8")
    val publicV6 = parseIpLiteral("2606:4700:4700::1111")

    assertNotNull(publicV4)
    assertNotNull(publicV6)
    assertTrue(isAllowedTargetAddress(requireNotNull(publicV4)))
    assertTrue(isAllowedTargetAddress(requireNotNull(publicV6)))
    assertNull(parseIpLiteral("example.com"))
    assertNull(parseIpLiteral("fe80::1%wlan0"))
    assertNull(parseIpLiteral("999.8.8.8"))
  }

  @Test
  fun rejectsPrivateAndReservedTargets() {
    val blocked = listOf(
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "203.0.113.10",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    )

    for (value in blocked) {
      assertFalse(value, isAllowedTargetAddress(requireNotNull(parseIpLiteral(value))))
    }
  }

  @Test
  fun strictlyAcceptsTheDataPairingResponse() {
    assertTrue(isDataAccepted("""{"type":"DATA_ACCEPTED","connection_id":"rcn_1"}""", "rcn_1"))
    assertFalse(isDataAccepted("""{"type":"DATA_ACCEPTED","connection_id":"rcn_2"}""", "rcn_1"))
    assertFalse(
      isDataAccepted(
        """{"type":"DATA_ACCEPTED","connection_id":"rcn_1","extra":true}""",
        "rcn_1",
      ),
    )
    assertFalse(isDataAccepted("not-json", "rcn_1"))
  }
}
