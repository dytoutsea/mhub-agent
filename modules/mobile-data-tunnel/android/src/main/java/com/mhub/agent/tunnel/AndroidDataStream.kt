package com.mhub.agent.tunnel

import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.EOFException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal data class StreamOpenRequest(
  val connectionId: String,
  val connectionToken: String,
  val host: String,
  val port: Int,
  val connectTimeoutMs: Int,
)

internal fun normalizeDataWebSocketBaseUrl(value: String): HttpUrl {
  return Request.Builder().url(value).build().url
}

internal fun isValidDataWebSocketBaseUrl(
  value: String,
  allowInsecureDevelopmentEndpoints: Boolean,
): Boolean {
  val uri = runCatching { URI(value) }.getOrNull() ?: return false
  return (uri.scheme == "wss" || (allowInsecureDevelopmentEndpoints && uri.scheme == "ws")) &&
    !uri.host.isNullOrBlank() &&
    uri.userInfo == null &&
    uri.query == null &&
    uri.fragment == null &&
    uri.path == "/agent/v1/data"
}

internal class AndroidDataStream(
  private val request: StreamOpenRequest,
  private val dataBaseUrl: HttpUrl,
  private val client: OkHttpClient,
  private val executor: ExecutorService,
  private val onClosed: (AndroidDataStream, String, Boolean) -> Unit,
) {
  private val closed = AtomicBoolean(false)
  private val paired = AtomicBoolean(false)
  private val ready = AtomicBoolean(false)
  private val pairing = CountDownLatch(1)
  private val pairingFailure = AtomicReference<String?>(null)
  private val target = AtomicReference<Socket?>(null)
  private val dataSocket = AtomicReference<WebSocket?>(null)
  private val targetWriteQueue = LinkedBlockingQueue<ByteArray>(64)
  private val targetWriteBytes = AtomicLong(0)

  fun open(): String? {
    return try {
      val targetAddress = parseIpLiteral(request.host)
        ?.takeIf(::isAllowedTargetAddress)
        ?: return "TARGET_IP_BLOCKED"
      val socket = Socket()
      target.set(socket)
      socket.tcpNoDelay = true
      socket.connect(InetSocketAddress(targetAddress, request.port), request.connectTimeoutMs)
      if (!sameAddress(socket.inetAddress, targetAddress) || !isAllowedTargetAddress(socket.inetAddress)) {
        return "TARGET_PEER_MISMATCH"
      }
      if (closed.get()) {
        return "STREAM_CANCELLED"
      }

      val dataUrl = dataBaseUrl.newBuilder().addPathSegment(request.connectionId).build()
      val webSocket = client.newWebSocket(Request.Builder().url(dataUrl).build(), listener())
      dataSocket.set(webSocket)
      if (closed.get()) {
        webSocket.cancel()
        return "STREAM_CANCELLED"
      }
      if (!pairing.await(request.connectTimeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
        return "DATA_PAIRING_TIMEOUT"
      }
      pairingFailure.get()?.let { return it }
      if (closed.get()) {
        return "STREAM_CANCELLED"
      }
      ready.set(true)
      executor.execute(::copyTargetToRelay)
      executor.execute(::copyRelayToTarget)
      null
    } catch (_: SocketTimeoutException) {
      "TARGET_CONNECT_TIMEOUT"
    } catch (_: Exception) {
      "TARGET_CONNECT_FAILED"
    }
  }

  fun isReady(): Boolean = ready.get()

  fun close(reason: String, notifyControl: Boolean) {
    if (!closed.compareAndSet(false, true)) {
      return
    }
    pairingFailure.compareAndSet(null, reason)
    pairing.countDown()
    targetWriteQueue.clear()
    targetWriteBytes.set(0)
    runCatching { target.getAndSet(null)?.close() }
    val socket = dataSocket.getAndSet(null)
    if (socket != null && !socket.close(1000, "STREAM_CLOSED")) {
      socket.cancel()
    }
    onClosed(this, reason, notifyControl && ready.get())
  }

  private fun listener(): WebSocketListener {
    return object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        if (closed.get()) {
          webSocket.cancel()
          return
        }
        val hello = JSONObject()
          .put("type", "DATA_HELLO")
          .put("connection_id", request.connectionId)
          .put("connection_token", request.connectionToken)
          .toString()
        if (!webSocket.send(hello)) {
          failPairing("DATA_PAIRING_SEND_FAILED")
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (closed.get()) {
          return
        }
        if (ready.get()) {
          close("DATA_TEXT_FRAME_REJECTED", true)
          return
        }
        if (!isDataAccepted(text, request.connectionId)) {
          failPairing("DATA_PAIRING_REJECTED")
          return
        }
        if (!paired.compareAndSet(false, true)) {
          close("DATA_PAIRING_INVALID", true)
          return
        }
        pairing.countDown()
      }

      override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        if (closed.get()) {
          return
        }
        if (!paired.get()) {
          failPairing("DATA_PAIRING_INVALID")
          return
        }
        if (bytes.size > HARD_BUFFER_LIMIT) {
          close("DATA_FRAME_TOO_LARGE", true)
          return
        }
        val frame = bytes.toByteArray()
        val queued = targetWriteBytes.addAndGet(frame.size.toLong())
        if (queued > HARD_BUFFER_LIMIT || !targetWriteQueue.offer(frame)) {
          targetWriteBytes.addAndGet(-frame.size.toLong())
          close("TARGET_BUFFER_LIMIT", true)
        }
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, "")
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        close("DATA_CHANNEL_CLOSED", false)
      }

      override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
        if (!ready.get()) {
          failPairing("DATA_CHANNEL_CONNECT_FAILED")
        } else {
          close("DATA_CHANNEL_FAILED", false)
        }
      }
    }
  }

  private fun copyTargetToRelay() {
    val buffer = ByteArray(32 * 1024)
    try {
      val input = target.get()?.getInputStream() ?: throw EOFException()
      while (!closed.get()) {
        val count = input.read(buffer)
        if (count < 0) {
          close("TARGET_CLOSED", true)
          return
        }
        val webSocket = dataSocket.get() ?: throw EOFException()
        if (webSocket.queueSize() + count > HARD_BUFFER_LIMIT) {
          close("DATA_BUFFER_LIMIT", true)
          return
        }
        if (!webSocket.send(buffer.toByteString(0, count))) {
          close("DATA_CHANNEL_CLOSED", false)
          return
        }
        while (!closed.get() && webSocket.queueSize() > HIGH_WATER_MARK) {
          Thread.sleep(10)
        }
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      close("STREAM_CANCELLED", false)
    } catch (_: Exception) {
      close("TARGET_READ_FAILED", true)
    }
  }

  private fun copyRelayToTarget() {
    try {
      val output = target.get()?.getOutputStream() ?: throw EOFException()
      while (!closed.get()) {
        val frame = targetWriteQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
        try {
          output.write(frame)
        } finally {
          targetWriteBytes.updateAndGet { current -> maxOf(0, current - frame.size) }
        }
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      close("STREAM_CANCELLED", false)
    } catch (_: Exception) {
      close("TARGET_WRITE_FAILED", true)
    }
  }

  private fun failPairing(reason: String) {
    if (pairingFailure.compareAndSet(null, reason)) {
      dataSocket.getAndSet(null)?.cancel()
      pairing.countDown()
    }
  }

  companion object {
    private const val HIGH_WATER_MARK = 256L * 1024L
    private const val HARD_BUFFER_LIMIT = 1024L * 1024L
  }
}

internal fun isDataAccepted(value: String, connectionId: String): Boolean {
  if (value.length > 64 * 1024) {
    return false
  }
  return runCatching {
    val message = JSONObject(value)
    val keys = message.keys().asSequence().toSet()
    keys == setOf("type", "connection_id") &&
      message.getString("type") == "DATA_ACCEPTED" &&
      message.getString("connection_id") == connectionId
  }.getOrDefault(false)
}

internal fun parseIpLiteral(value: String): InetAddress? {
  if (value.contains('%')) {
    return null
  }
  if (value.contains(':')) {
    if (!value.matches(Regex("^[0-9A-Fa-f:.]+$"))) {
      return null
    }
    return runCatching { InetAddress.getByName(value) }
      .getOrNull()
      ?.takeIf { it is Inet6Address }
  }
  val parts = value.split('.')
  if (parts.size != 4 || parts.any { it.isEmpty() || it.length > 3 }) {
    return null
  }
  val bytes = ByteArray(4)
  for ((index, part) in parts.withIndex()) {
    if (part.any { char -> !char.isDigit() }) {
      return null
    }
    val octet = part.toIntOrNull() ?: return null
    if (octet !in 0..255) {
      return null
    }
    bytes[index] = octet.toByte()
  }
  return InetAddress.getByAddress(bytes)
}

internal fun isAllowedTargetAddress(address: InetAddress): Boolean {
  val normalized = normalizeMappedAddress(address)
  if (
    normalized.isAnyLocalAddress ||
    normalized.isLoopbackAddress ||
    normalized.isLinkLocalAddress ||
    normalized.isSiteLocalAddress ||
    normalized.isMulticastAddress
  ) {
    return false
  }
  val bytes = normalized.address.map { it.toInt() and 0xff }
  if (normalized is Inet4Address) {
    return !(
      bytes[0] == 0 ||
      (bytes[0] == 100 && bytes[1] in 64..127) ||
      (bytes[0] == 192 && bytes[1] == 0 && bytes[2] == 0) ||
      (bytes[0] == 192 && bytes[1] == 0 && bytes[2] == 2) ||
      (bytes[0] == 192 && bytes[1] == 88 && bytes[2] == 99) ||
      (bytes[0] == 198 && bytes[1] in 18..19) ||
      (bytes[0] == 198 && bytes[1] == 51 && bytes[2] == 100) ||
      (bytes[0] == 203 && bytes[1] == 0 && bytes[2] == 113) ||
      bytes[0] >= 240
    )
  }
  return !(
    (bytes[0] and 0xfe) == 0xfc ||
    (bytes[0] == 0x00 && bytes[1] == 0x64 && bytes[2] == 0xff && bytes[3] == 0x9b) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x00 && bytes[3] == 0x00) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x00 && bytes[3] in 0x10..0x1f) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8) ||
    (bytes[0] == 0x20 && bytes[1] == 0x02)
  )
}

internal fun sameAddress(left: InetAddress, right: InetAddress): Boolean {
  return normalizeMappedAddress(left).address.contentEquals(normalizeMappedAddress(right).address)
}

private fun normalizeMappedAddress(address: InetAddress): InetAddress {
  val bytes = address.address
  if (
    bytes.size == 16 &&
    bytes.take(10).all { it.toInt() == 0 } &&
    bytes[10].toInt() == -1 &&
    bytes[11].toInt() == -1
  ) {
    return InetAddress.getByAddress(bytes.copyOfRange(12, 16))
  }
  return address
}
