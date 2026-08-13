import ExpoModulesCore
import Foundation
import UIKit

public final class MHubMobileDataTunnelModule: Module {
  private let lock = NSLock()
  private var configured = false
  private var foreground = false
  private var running = false
  private var activeStreams = 0
  private var errorCode: String?
  private var dataBaseURL: URL?
  private var maxStreams = 0
  private var streams: [String: IOSDataStream] = [:]
  private var readyConnectionIds = Set<String>()
  private var resignActiveObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("MHubMobileDataTunnel")
    Events("onStateChanged", "onStreamClosed")

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
      let url = try self.validateConfiguration(dataWebSocketBaseUrl, maxStreams: maxStreams)
      return try self.updateAndPublish {
        guard !self.running && self.streams.isEmpty else {
          throw MobileTunnelError("MOBILE_DATA_TUNNEL_ALREADY_CONFIGURED")
        }
        self.configured = true
        self.dataBaseURL = url
        self.maxStreams = maxStreams
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

    AsyncFunction("openStream") {
      (
        connectionId: String,
        connectionToken: String,
        host: String,
        port: Int,
        connectTimeoutMs: Int,
        promise: Promise
      ) in
      do {
        let request = try self.validateStreamRequest(
          connectionId: connectionId,
          connectionToken: connectionToken,
          host: host,
          port: port,
          connectTimeoutMs: connectTimeoutMs
        )
        let reservation = try self.reserveStream(request)
        reservation.open { [weak self, weak reservation] failure in
          guard let self = self, let reservation = reservation else {
            promise.resolve([
              "connectionId": connectionId,
              "status": "failed",
              "reason": "STREAM_CANCELLED",
            ])
            return
          }
          self.completeOpen(
            connectionId: connectionId,
            stream: reservation,
            failure: failure,
            promise: promise
          )
        }
      } catch let error as Exception {
        promise.reject(error)
      } catch {
        promise.reject(MobileTunnelError("MOBILE_DATA_TUNNEL_OPEN_FAILED"))
      }
    }

    AsyncFunction("closeStream") { (connectionId: String) -> [String: Any?] in
      try self.requireConnectionId(connectionId)
      let result = self.withLock { () -> (IOSDataStream?, [String: Any?]) in
        let stream = self.streams.removeValue(forKey: connectionId)
        self.readyConnectionIds.remove(connectionId)
        self.activeStreams = self.readyConnectionIds.count
        return (stream, self.snapshot())
      }
      let stream = result.0
      stream?.close(reason: "REMOTE_CLOSED", notifyControl: false)
      self.sendEvent("onStateChanged", result.1)
      return result.1
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

  private func reserveStream(_ request: IOSStreamOpenRequest) throws -> IOSDataStream {
    return try withLock {
      guard running && foreground else {
        throw MobileTunnelError("MOBILE_DATA_TUNNEL_NOT_RUNNING")
      }
      guard let dataBaseURL = dataBaseURL else {
        throw MobileTunnelError("MOBILE_DATA_TUNNEL_NOT_CONFIGURED")
      }
      guard streams[request.connectionId] == nil else {
        throw MobileTunnelError("DUPLICATE_CONNECTION")
      }
      guard streams.count < maxStreams else {
        throw MobileTunnelError("STREAM_LIMIT_REACHED")
      }
      let stream = IOSDataStream(
        request: request,
        dataBaseURL: dataBaseURL,
        onClosed: { [weak self] stream, reason, notifyControl in
          self?.handleStreamClosed(stream, reason: reason, notifyControl: notifyControl)
        }
      )
      streams[request.connectionId] = stream
      return stream
    }
  }

  private func completeOpen(
    connectionId: String,
    stream: IOSDataStream,
    failure: String?,
    promise: Promise
  ) {
    if let failure = failure {
      stream.close(reason: failure, notifyControl: false)
      promise.resolve(streamResult(connectionId: connectionId, failure: failure))
      return
    }
    let accepted = withLock { () -> Bool in
      guard running && foreground && streams[connectionId] === stream else {
        return false
      }
      readyConnectionIds.insert(connectionId)
      activeStreams = readyConnectionIds.count
      return true
    }
    if !accepted {
      stream.close(reason: "STREAM_CANCELLED", notifyControl: false)
      promise.resolve(streamResult(connectionId: connectionId, failure: "STREAM_CANCELLED"))
      return
    }
    sendEvent("onStateChanged", withLock { snapshot() })
    promise.resolve(streamResult(connectionId: connectionId, failure: nil))
  }

  private func stopInternal(errorCode stableErrorCode: String?) -> [String: Any?] {
    let active = withLock { () -> [IOSDataStream] in
      running = false
      if stableErrorCode != nil {
        foreground = false
      }
      errorCode = stableErrorCode
      let active = Array(streams.values)
      streams.removeAll()
      readyConnectionIds.removeAll()
      activeStreams = 0
      return active
    }
    for stream in active {
      stream.close(reason: stableErrorCode ?? "AGENT_STOPPED", notifyControl: false)
    }
    let value = withLock { snapshot() }
    sendEvent("onStateChanged", value)
    return value
  }

  private func handleStreamClosed(
    _ stream: IOSDataStream,
    reason: String,
    notifyControl: Bool
  ) {
    let result = withLock { () -> (String?, [String: Any?]) in
      guard let entry = streams.first(where: { $0.value === stream }) else {
        return (nil, snapshot())
      }
      streams.removeValue(forKey: entry.key)
      readyConnectionIds.remove(entry.key)
      activeStreams = readyConnectionIds.count
      return (entry.key, snapshot())
    }
    let connectionId = result.0
    sendEvent("onStateChanged", result.1)
    if let connectionId = connectionId, notifyControl {
      sendEvent(
        "onStreamClosed",
        ["connectionId": connectionId, "reason": stableStreamReason(reason)]
      )
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

  private func validateConfiguration(_ value: String, maxStreams: Int) throws -> URL {
    guard
      let components = URLComponents(string: value),
      components.scheme == "wss",
      components.host?.isEmpty == false,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      components.path == "/agent/v1/data",
      let url = components.url
    else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_URL_INVALID")
    }
    guard (1...128).contains(maxStreams) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_MAX_STREAMS_INVALID")
    }
    return url
  }

  private func validateStopReason(_ reason: String) throws {
    let allowed = ["USER_REQUESTED", "MOBILE_APP_BACKGROUND", "APP_CONTEXT_DESTROYED"]
    guard allowed.contains(reason) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_STOP_REASON_INVALID")
    }
  }

  private func validateStreamRequest(
    connectionId: String,
    connectionToken: String,
    host: String,
    port: Int,
    connectTimeoutMs: Int
  ) throws -> IOSStreamOpenRequest {
    try requireConnectionId(connectionId)
    guard (32...256).contains(connectionToken.count) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_CONNECTION_TOKEN_INVALID")
    }
    guard (2...255).contains(host.count), parseIPAddress(host) != nil else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_TARGET_IP_INVALID")
    }
    guard (1...65_535).contains(port) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_TARGET_PORT_INVALID")
    }
    guard (1_000...30_000).contains(connectTimeoutMs) else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_CONNECT_TIMEOUT_INVALID")
    }
    return IOSStreamOpenRequest(
      connectionId: connectionId,
      connectionToken: connectionToken,
      host: host,
      port: port,
      connectTimeoutMs: connectTimeoutMs
    )
  }

  private func requireConnectionId(_ connectionId: String) throws {
    guard !connectionId.isEmpty && connectionId.count <= 128 else {
      throw MobileTunnelError("MOBILE_DATA_TUNNEL_CONNECTION_ID_INVALID")
    }
  }

  private func streamResult(connectionId: String, failure: String?) -> [String: Any?] {
    return [
      "connectionId": connectionId,
      "status": failure == nil ? "ready" : "failed",
      "reason": failure.map(stableStreamReason),
    ]
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
