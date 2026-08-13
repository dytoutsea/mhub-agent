package com.mhub.agent.tunnel

import com.facebook.react.common.LifecycleState
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URI

class MHubMobileDataTunnelModule : Module() {
  private val lock = Any()
  private var configured = false
  private var foreground = false
  private var running = false
  private var activeStreams = 0
  private var errorCode: String? = null

  override fun definition() = ModuleDefinition {
    Name("MHubMobileDataTunnel")
    Events("onStateChanged")

    OnCreate {
      foreground = isReactContextForeground()
    }

    AsyncFunction("configure") { dataWebSocketBaseUrl: String, maxStreams: Int ->
      requireValidConfiguration(dataWebSocketBaseUrl, maxStreams)
      synchronized(lock) {
        configured = true
        errorCode = null
        snapshot()
      }.also(::publish)
    }

    AsyncFunction("start") {
      synchronized(lock) {
        foreground = isReactContextForeground()
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
      synchronized(lock) {
        foreground = isReactContextForeground()
        snapshot()
      }
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
    }
  }

  private fun stopInternal(stableErrorCode: String?): Map<String, Any?> {
    return synchronized(lock) {
      running = false
      activeStreams = 0
      if (stableErrorCode != null) {
        foreground = false
      }
      errorCode = stableErrorCode
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

  private fun isReactContextForeground(): Boolean {
    return appContext.reactContext?.lifecycleState == LifecycleState.RESUMED
  }

  private fun requireValidConfiguration(value: String, maxStreams: Int) {
    val uri = runCatching { URI(value) }.getOrNull()
    if (
      uri == null ||
      uri.scheme != "wss" ||
      uri.host.isNullOrBlank() ||
      uri.userInfo != null ||
      uri.query != null ||
      uri.fragment != null ||
      uri.path != "/agent/v1/data"
    ) {
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
}

private class MobileTunnelException(code: String) :
  CodedException(code, "Mobile data tunnel command rejected", null)
