import ExpoModulesCore
import UIKit

public final class MHubMobileDataTunnelModule: Module {
  private let lock = NSLock()
  private var configured = false
  private var foreground = false
  private var running = false
  private var activeStreams = 0
  private var errorCode: String?
  private var resignActiveObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("MHubMobileDataTunnel")
    Events("onStateChanged")

    OnCreate {
      self.withLock {
        self.foreground = self.isApplicationActive()
      }
      self.resignActiveObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.willResignActiveNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        _ = self?.stopInternal(errorCode: "MOBILE_APP_BACKGROUND")
      }
    }

    AsyncFunction("configure") { (dataWebSocketBaseUrl: String, maxStreams: Int) -> [String: Any?] in
      try self.validateConfiguration(dataWebSocketBaseUrl, maxStreams: maxStreams)
      return self.updateAndPublish {
        self.configured = true
        self.errorCode = nil
      }
    }

    AsyncFunction("start") { () -> [String: Any?] in
      let active = self.isApplicationActive()
      return try self.updateAndPublish {
        self.foreground = active
        guard self.configured else {
          throw MobileTunnelError("MOBILE_DATA_TUNNEL_NOT_CONFIGURED")
        }
        guard self.foreground else {
          throw MobileTunnelError("MOBILE_DATA_TUNNEL_REQUIRES_FOREGROUND")
        }
        self.running = true
        self.errorCode = nil
      }
    }

    AsyncFunction("stop") { (reason: String) -> [String: Any?] in
      try self.validateStopReason(reason)
      return self.stopInternal(errorCode: nil)
    }

    AsyncFunction("getSnapshot") { () -> [String: Any?] in
      let active = self.isApplicationActive()
      return self.withLock {
        self.foreground = active
        return self.snapshot()
      }
    }

    OnAppBecomesActive {
      _ = self.updateAndPublish {
        self.foreground = true
      }
    }

    OnAppEntersBackground {
      _ = self.stopInternal(errorCode: "MOBILE_APP_BACKGROUND")
    }

    OnAppContextDestroys {
      self.removeLifecycleObserver()
      _ = self.stopInternal(errorCode: "APP_CONTEXT_DESTROYED")
    }

    OnDestroy {
      self.removeLifecycleObserver()
      _ = self.stopInternal(errorCode: "APP_CONTEXT_DESTROYED")
    }
  }

  private func stopInternal(errorCode: String?) -> [String: Any?] {
    return updateAndPublish {
      self.running = false
      self.activeStreams = 0
      if errorCode != nil {
        self.foreground = false
      }
      self.errorCode = errorCode
    }
  }

  private func removeLifecycleObserver() {
    guard let observer = resignActiveObserver else {
      return
    }
    NotificationCenter.default.removeObserver(observer)
    resignActiveObserver = nil
  }

  private func updateAndPublish(_ update: () throws -> Void) rethrows -> [String: Any?] {
    let value = try withLock {
      try update()
      return snapshot()
    }
    sendEvent("onStateChanged", value)
    return value
  }

  private func snapshot() -> [String: Any?] {
    return [
      "state": !configured ? "unconfigured" : running ? "running" : "stopped",
      "foreground": foreground,
      "activeStreams": activeStreams,
      "errorCode": errorCode,
    ]
  }

  private func withLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }

  private func isApplicationActive() -> Bool {
    if Thread.isMainThread {
      return UIApplication.shared.applicationState == .active
    }
    return DispatchQueue.main.sync {
      UIApplication.shared.applicationState == .active
    }
  }

  private func validateConfiguration(_ value: String, maxStreams: Int) throws {
    guard
      let components = URLComponents(string: value),
      components.scheme == "wss",
      components.host?.isEmpty == false,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path == "/agent/v1/data"
    else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_URL_INVALID")
    }
    guard (1...128).contains(maxStreams) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_MAX_STREAMS_INVALID")
    }
  }

  private func validateStopReason(_ reason: String) throws {
    let allowed = ["USER_REQUESTED", "MOBILE_APP_BACKGROUND", "APP_CONTEXT_DESTROYED"]
    guard allowed.contains(reason) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_STOP_REASON_INVALID")
    }
  }
}

private final class MobileTunnelError: Exception {
  private let stableCode: String

  override var code: String {
    return stableCode
  }

  override var reason: String {
    return "Mobile data tunnel command rejected"
  }

  init(_ stableCode: String) {
    self.stableCode = stableCode
    super.init()
  }
}
