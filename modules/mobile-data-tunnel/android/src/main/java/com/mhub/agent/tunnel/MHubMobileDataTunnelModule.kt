package com.mhub.agent.tunnel

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class MHubMobileDataTunnelModule : Module() {
  private val lock = Any()
  private val client = OkHttpClient.Builder().retryOnConnectionFailure(false).build()
  private val streamExecutor = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "mhub-mobile-stream").apply { isDaemon = true }
  }
  private val streams = ConcurrentHashMap<String, AndroidDataStream>()
  private var configured = false
  private var foreground = false
  private var running = false
  private var activeStreams = 0
  private var errorCode: String? = null
  private var dataBaseUrl: HttpUrl? = null
  private var maxStreams = 0

  override fun definition() = ModuleDefinition {
    Name("MHubMobileDataTunnel")
    Events("onStateChanged", "onStreamClosed")

    OnCreate {
      foreground = appContext.currentActivity?.hasWindowFocus() == true
    }

    AsyncFunction("configure") {
        dataWebSocketBaseUrl: String,
        maxStreams: Int,
        allowInsecureDevelopmentEndpoints: Boolean,
      ->
      requireValidConfiguration(
        dataWebSocketBaseUrl,
        maxStreams,
        allowInsecureDevelopmentEndpoints,
      )
      synchronized(lock) {
        if (running || streams.isNotEmpty()) {
          throw MobileTunnelException("MOBILE_DATA_TUNNEL_ALREADY_CONFIGURED")
        }
        configured = true
        dataBaseUrl = normalizeDataWebSocketBaseUrl(dataWebSocketBaseUrl)
        this@MHubMobileDataTunnelModule.maxStreams = maxStreams
        errorCode = null
        snapshot()
      }.also(::publish)
    }

    AsyncFunction("start") {
      synchronized(lock) {
        if (!configured) {
          throw MobileTunnelException("MOBILE_DATA_TUNNEL_NOT_CONFIGURED")
        }
        if (!foreground) {
          throw MobileTunnelException("MOBILE_DATA_TUNNEL_REQUIRES_FOREGROUND")
        }
        running = true
        errorCode = null
        snapshot()
      }.also(::publish)
    }

    AsyncFunction("stop") { reason: String ->
      requireValidStopReason(reason)
      stopInternal(null)
    }

    AsyncFunction("getSnapshot") {
      synchronized(lock) { snapshot() }
    }

    AsyncFunction("openStream") Coroutine {
        connectionId: String,
        connectionToken: String,
        host: String,
        port: Int,
        connectTimeoutMs: Int,
      ->
      val request = validateStreamRequest(
        connectionId,
        connectionToken,
        host,
        port,
        connectTimeoutMs,
      )
      val dataUrl = synchronized(lock) {
        if (!running || !foreground) {
          throw MobileTunnelException("MOBILE_DATA_TUNNEL_NOT_RUNNING")
        }
        dataBaseUrl ?: throw MobileTunnelException("MOBILE_DATA_TUNNEL_NOT_CONFIGURED")
      }
      val stream = AndroidDataStream(
        request,
        dataUrl,
        client,
        streamExecutor,
        ::handleStreamClosed,
      )
      val reservationFailure = synchronized(lock) {
        when {
          !running || !foreground -> "STREAM_CANCELLED"
          streams.containsKey(connectionId) -> "DUPLICATE_CONNECTION"
          streams.size >= maxStreams -> "STREAM_LIMIT_REACHED"
          else -> {
            streams[connectionId] = stream
            null
          }
        }
      }
      if (reservationFailure != null) {
        return@Coroutine streamResult(connectionId, reservationFailure)
      }
      val failure = withContext(Dispatchers.IO) { stream.open() }
      if (failure != null) {
        stream.close(failure, false)
        return@Coroutine streamResult(connectionId, failure)
      }
      val accepted = synchronized(lock) { running && foreground && streams[connectionId] === stream }
      if (!accepted) {
        stream.close("STREAM_CANCELLED", false)
        return@Coroutine streamResult(connectionId, "STREAM_CANCELLED")
      }
      publishStreamCount()
      streamResult(connectionId, null)
    }

    AsyncFunction("closeStream") { connectionId: String ->
      requireConnectionId(connectionId)
      streams[connectionId]?.close("REMOTE_CLOSED", false)
      synchronized(lock) { snapshot() }
    }

    OnActivityEntersForeground {
      synchronized(lock) {
        foreground = true
        snapshot()
      }.also(::publish)
    }

    OnActivityEntersBackground {
      stopInternal("MOBILE_APP_BACKGROUND")
    }

    OnActivityDestroys {
      stopInternal("APP_CONTEXT_DESTROYED")
    }

    OnDestroy {
      stopInternal("APP_CONTEXT_DESTROYED")
      client.dispatcher.executorService.shutdown()
      client.connectionPool.evictAll()
      streamExecutor.shutdownNow()
    }
  }

  private fun stopInternal(stableErrorCode: String?): Map<String, Any?> {
    val value = synchronized(lock) {
      running = false
      if (stableErrorCode != null) {
        foreground = false
      }
      errorCode = stableErrorCode
      streams.values.toList()
    }
    value.forEach { it.close(stableErrorCode ?: "AGENT_STOPPED", false) }
    return synchronized(lock) {
      activeStreams = streams.values.count(AndroidDataStream::isReady)
      snapshot()
    }.also(::publish)
  }

  private fun snapshot(): Map<String, Any?> {
    return mapOf(
      "state" to if (!configured) "unconfigured" else if (running) "running" else "stopped",
      "foreground" to foreground,
      "activeStreams" to activeStreams,
      "errorCode" to errorCode,
    )
  }

  private fun publish(snapshot: Map<String, Any?>) {
    sendEvent("onStateChanged", snapshot)
  }

  private fun handleStreamClosed(
    stream: AndroidDataStream,
    reason: String,
    notifyControl: Boolean,
  ) {
    val entry = streams.entries.firstOrNull { it.value === stream }
    if (entry != null) {
      streams.remove(entry.key, stream)
    }
    publishStreamCount()
    if (entry != null && notifyControl) {
      sendEvent(
        "onStreamClosed",
        mapOf("connectionId" to entry.key, "reason" to stableStreamReason(reason)),
      )
    }
  }

  private fun publishStreamCount() {
    synchronized(lock) {
      activeStreams = streams.values.count(AndroidDataStream::isReady)
      snapshot()
    }.also(::publish)
  }

  private fun requireValidConfiguration(
    value: String,
    maxStreams: Int,
    allowInsecureDevelopmentEndpoints: Boolean,
  ) {
    if (!isValidDataWebSocketBaseUrl(value, allowInsecureDevelopmentEndpoints)) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_URL_INVALID")
    }
    if (maxStreams !in 1..128) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_MAX_STREAMS_INVALID")
    }
  }

  private fun requireValidStopReason(reason: String) {
    if (
      reason != "USER_REQUESTED" &&
      reason != "MOBILE_APP_BACKGROUND" &&
      reason != "APP_CONTEXT_DESTROYED"
    ) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_STOP_REASON_INVALID")
    }
  }

  private fun validateStreamRequest(
    connectionId: String,
    connectionToken: String,
    host: String,
    port: Int,
    connectTimeoutMs: Int,
  ): StreamOpenRequest {
    requireConnectionId(connectionId)
    if (connectionToken.length !in 32..256) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_CONNECTION_TOKEN_INVALID")
    }
    if (host.length !in 2..255 || parseIpLiteral(host) == null) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_TARGET_IP_INVALID")
    }
    if (port !in 1..65535) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_TARGET_PORT_INVALID")
    }
    if (connectTimeoutMs !in 1000..30000) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_CONNECT_TIMEOUT_INVALID")
    }
    return StreamOpenRequest(connectionId, connectionToken, host, port, connectTimeoutMs)
  }

  private fun requireConnectionId(connectionId: String) {
    if (connectionId.isEmpty() || connectionId.length > 128) {
      throw MobileTunnelException("MOBILE_DATA_TUNNEL_CONNECTION_ID_INVALID")
    }
  }

  private fun streamResult(connectionId: String, failure: String?): Map<String, Any?> {
    return mapOf(
      "connectionId" to connectionId,
      "status" to if (failure == null) "ready" else "failed",
      "reason" to failure?.let(::stableStreamReason),
    )
  }

  private fun stableStreamReason(reason: String): String {
    return reason.takeIf { it.length <= 64 && it.matches(Regex("^[A-Z0-9_]+$")) }
      ?: "STREAM_FAILED"
  }
}

private class MobileTunnelException(code: String) :
  CodedException(code, "Mobile data tunnel command rejected", null)
