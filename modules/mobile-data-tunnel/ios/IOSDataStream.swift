import Darwin
import Foundation
import Network

struct IOSStreamOpenRequest {
  let connectionId: String
  let connectionToken: String
  let host: String
  let port: Int
  let connectTimeoutMs: Int
}

final class IOSDataStream {
  private static let frameLimit = 1_024 * 1_024
  private static let readSize = 32 * 1_024

  private let request: IOSStreamOpenRequest
  private let dataURL: URL
  private let onClosed: (IOSDataStream, String, Bool) -> Void
  private let queue: DispatchQueue
  private var target: NWConnection?
  private var session: URLSession?
  private var dataSocket: URLSessionWebSocketTask?
  private var timeout: DispatchWorkItem?
  private var timeoutGeneration = 0
  private var openCompletion: ((String?) -> Void)?
  private var closed = false
  private var paired = false
  private var ready = false

  init(
    request: IOSStreamOpenRequest,
    dataBaseURL: URL,
    onClosed: @escaping (IOSDataStream, String, Bool) -> Void
  ) {
    self.request = request
    self.dataURL = dataStreamURL(base: dataBaseURL, connectionId: request.connectionId)
    self.onClosed = onClosed
    self.queue = DispatchQueue(label: "com.mhub.agent.data-stream.\(UUID().uuidString)")
  }

  func open(completion: @escaping (String?) -> Void) {
    queue.async {
      self.openCompletion = completion
      guard !self.closed else {
        self.failOpening("STREAM_CANCELLED")
        return
      }
      guard let address = parseIPAddress(self.request.host), isAllowedTargetAddress(address) else {
        self.failOpening("TARGET_IP_BLOCKED")
        return
      }
      guard let port = NWEndpoint.Port(rawValue: UInt16(self.request.port)) else {
        self.failOpening("TARGET_CONNECT_FAILED")
        return
      }
      let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(self.request.host), port: port)
      let connection = NWConnection(to: endpoint, using: .tcp)
      self.target = connection
      self.scheduleTimeout("TARGET_CONNECT_TIMEOUT")
      connection.stateUpdateHandler = { [weak self, weak connection] state in
        guard let self = self, let connection = connection else {
          return
        }
        self.queue.async {
          self.handleTargetState(state, connection: connection, expectedEndpoint: endpoint)
        }
      }
      connection.start(queue: self.queue)
    }
  }

  func close(reason: String, notifyControl: Bool) {
    queue.sync {
      self.closeOnQueue(reason: reason, notifyControl: notifyControl)
    }
  }

  private func handleTargetState(
    _ state: NWConnection.State,
    connection: NWConnection,
    expectedEndpoint: NWEndpoint
  ) {
    guard !closed && target === connection else {
      return
    }
    switch state {
    case .ready:
      guard connection.currentPath?.remoteEndpoint == expectedEndpoint else {
        failOpening("TARGET_PEER_MISMATCH")
        return
      }
      scheduleTimeout("DATA_PAIRING_TIMEOUT")
      startDataChannel()
    case .failed:
      if ready {
        closeOnQueue(reason: "TARGET_READ_FAILED", notifyControl: true)
      } else {
        failOpening("TARGET_CONNECT_FAILED")
      }
    case .cancelled:
      if openCompletion != nil {
        failOpening("STREAM_CANCELLED")
      } else if ready {
        closeOnQueue(reason: "TARGET_CLOSED", notifyControl: true)
      }
    default:
      break
    }
  }

  private func startDataChannel() {
    guard !closed && dataSocket == nil else {
      return
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = TimeInterval(request.connectTimeoutMs) / 1_000
    configuration.waitsForConnectivity = false
    let session = URLSession(configuration: configuration)
    let socket = session.webSocketTask(with: dataURL)
    socket.maximumMessageSize = Self.frameLimit
    self.session = session
    self.dataSocket = socket
    socket.resume()
    guard let hello = dataHello(request) else {
      failOpening("DATA_PAIRING_SEND_FAILED")
      return
    }
    socket.send(.string(hello)) { [weak self, weak socket] error in
      guard let self = self, let socket = socket else {
        return
      }
      self.queue.async {
        guard !self.closed && self.dataSocket === socket else {
          return
        }
        if error != nil {
          self.failOpening("DATA_PAIRING_SEND_FAILED")
          return
        }
        self.receivePairingResponse(socket)
      }
    }
  }

  private func receivePairingResponse(_ socket: URLSessionWebSocketTask) {
    socket.receive { [weak self, weak socket] result in
      guard let self = self, let socket = socket else {
        return
      }
      self.queue.async {
        guard !self.closed && self.dataSocket === socket else {
          return
        }
        switch result {
        case .failure:
          self.failOpening("DATA_CHANNEL_CONNECT_FAILED")
        case .success(.data):
          self.failOpening("DATA_PAIRING_INVALID")
        case .success(.string(let text)):
          guard isDataAccepted(text, connectionId: self.request.connectionId), !self.paired else {
            self.failOpening("DATA_PAIRING_REJECTED")
            return
          }
          self.paired = true
          self.ready = true
          self.clearTimeout()
          self.completeOpening(nil)
          self.receiveTarget()
          self.receiveRelay()
        @unknown default:
          self.failOpening("DATA_PAIRING_INVALID")
        }
      }
    }
  }

  private func receiveTarget() {
    guard !closed, ready, let target = target else {
      return
    }
    target.receive(minimumIncompleteLength: 1, maximumLength: Self.readSize) {
      [weak self, weak target] data, _, isComplete, error in
      guard let self = self, let target = target else {
        return
      }
      self.queue.async {
        guard !self.closed && self.target === target else {
          return
        }
        if error != nil {
          self.closeOnQueue(reason: "TARGET_READ_FAILED", notifyControl: true)
          return
        }
        guard let data = data, !data.isEmpty else {
          if isComplete {
            self.closeOnQueue(reason: "TARGET_CLOSED", notifyControl: true)
          } else {
            self.receiveTarget()
          }
          return
        }
        self.sendToRelay(data, targetComplete: isComplete)
      }
    }
  }

  private func sendToRelay(_ data: Data, targetComplete: Bool) {
    guard data.count <= Self.frameLimit, let socket = dataSocket else {
      closeOnQueue(reason: "DATA_BUFFER_LIMIT", notifyControl: true)
      return
    }
    socket.send(.data(data)) { [weak self, weak socket] error in
      guard let self = self, let socket = socket else {
        return
      }
      self.queue.async {
        guard !self.closed && self.dataSocket === socket else {
          return
        }
        if error != nil {
          self.closeOnQueue(reason: "DATA_CHANNEL_CLOSED", notifyControl: false)
        } else if targetComplete {
          self.closeOnQueue(reason: "TARGET_CLOSED", notifyControl: true)
        } else {
          self.receiveTarget()
        }
      }
    }
  }

  private func receiveRelay() {
    guard !closed, ready, let socket = dataSocket else {
      return
    }
    socket.receive { [weak self, weak socket] result in
      guard let self = self, let socket = socket else {
        return
      }
      self.queue.async {
        guard !self.closed && self.dataSocket === socket else {
          return
        }
        switch result {
        case .failure:
          self.closeOnQueue(reason: "DATA_CHANNEL_FAILED", notifyControl: false)
        case .success(.string):
          self.closeOnQueue(reason: "DATA_TEXT_FRAME_REJECTED", notifyControl: true)
        case .success(.data(let data)):
          guard data.count <= Self.frameLimit else {
            self.closeOnQueue(reason: "DATA_FRAME_TOO_LARGE", notifyControl: true)
            return
          }
          self.sendToTarget(data)
        @unknown default:
          self.closeOnQueue(reason: "DATA_CHANNEL_FAILED", notifyControl: false)
        }
      }
    }
  }

  private func sendToTarget(_ data: Data) {
    guard let target = target else {
      closeOnQueue(reason: "TARGET_WRITE_FAILED", notifyControl: true)
      return
    }
    target.send(content: data, completion: .contentProcessed { [weak self, weak target] error in
      guard let self = self, let target = target else {
        return
      }
      self.queue.async {
        guard !self.closed && self.target === target else {
          return
        }
        if error != nil {
          self.closeOnQueue(reason: "TARGET_WRITE_FAILED", notifyControl: true)
        } else {
          self.receiveRelay()
        }
      }
    })
  }

  private func failOpening(_ reason: String) {
    completeOpening(reason)
    closeOnQueue(reason: reason, notifyControl: false)
  }

  private func completeOpening(_ failure: String?) {
    let completion = openCompletion
    openCompletion = nil
    DispatchQueue.global(qos: .userInitiated).async {
      completion?(failure)
    }
  }

  private func scheduleTimeout(_ reason: String) {
    clearTimeout()
    let generation = timeoutGeneration
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, self.timeoutGeneration == generation else {
        return
      }
      self.failOpening(reason)
    }
    self.timeout = timeout
    queue.asyncAfter(
      deadline: .now() + .milliseconds(request.connectTimeoutMs),
      execute: timeout
    )
  }

  private func clearTimeout() {
    timeoutGeneration += 1
    timeout?.cancel()
    timeout = nil
  }

  private func closeOnQueue(reason: String, notifyControl: Bool) {
    guard !closed else {
      return
    }
    closed = true
    clearTimeout()
    completeOpening(reason)
    target?.stateUpdateHandler = nil
    target?.cancel()
    target = nil
    dataSocket?.cancel(with: .normalClosure, reason: nil)
    dataSocket = nil
    session?.invalidateAndCancel()
    session = nil
    onClosed(self, stableStreamReason(reason), notifyControl && ready)
  }
}

struct ParsedIPAddress {
  let bytes: [UInt8]
}

func parseIPAddress(_ value: String) -> ParsedIPAddress? {
  if value.contains("%") {
    return nil
  }
  var ipv4 = in_addr()
  if value.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
    return ParsedIPAddress(bytes: withUnsafeBytes(of: &ipv4) { Array($0) })
  }
  var ipv6 = in6_addr()
  if value.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
    let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
    if bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
      return ParsedIPAddress(bytes: Array(bytes[12..<16]))
    }
    return ParsedIPAddress(bytes: bytes)
  }
  return nil
}

func isAllowedTargetAddress(_ address: ParsedIPAddress) -> Bool {
  let bytes = address.bytes
  if bytes.count == 4 {
    return !(
      bytes[0] == 0 ||
      bytes[0] == 10 ||
      (bytes[0] == 100 && (64...127).contains(bytes[1])) ||
      bytes[0] == 127 ||
      (bytes[0] == 169 && bytes[1] == 254) ||
      (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
      (bytes[0] == 192 && bytes[1] == 168) ||
      (bytes[0] == 192 && bytes[1] == 0 && bytes[2] == 0) ||
      (bytes[0] == 192 && bytes[1] == 0 && bytes[2] == 2) ||
      (bytes[0] == 192 && bytes[1] == 88 && bytes[2] == 99) ||
      (bytes[0] == 198 && (18...19).contains(bytes[1])) ||
      (bytes[0] == 198 && bytes[1] == 51 && bytes[2] == 100) ||
      (bytes[0] == 203 && bytes[1] == 0 && bytes[2] == 113) ||
      bytes[0] >= 224
    )
  }
  guard bytes.count == 16 else {
    return false
  }
  let unspecified = bytes.allSatisfy { $0 == 0 }
  let loopback = bytes.prefix(15).allSatisfy { $0 == 0 } && bytes[15] == 1
  return !(
    unspecified ||
    loopback ||
    bytes[0] == 0xff ||
    (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) ||
    (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0xc0) ||
    (bytes[0] & 0xfe) == 0xfc ||
    (bytes[0] == 0x00 && bytes[1] == 0x64 && bytes[2] == 0xff && bytes[3] == 0x9b) ||
    (bytes[0] == 0x01 && bytes[1..<8].allSatisfy { $0 == 0 }) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x00 && bytes[3] == 0x00) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x00 && (0x10...0x1f).contains(bytes[3])) ||
    (bytes[0] == 0x20 && bytes[1] == 0x01 && bytes[2] == 0x0d && bytes[3] == 0xb8) ||
    (bytes[0] == 0x20 && bytes[1] == 0x02)
  )
}

func dataStreamURL(base: URL, connectionId: String) -> URL {
  var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
  let encoded = connectionId.utf8.map { byte -> String in
    let scalar = UnicodeScalar(byte)
    if
      (byte >= 48 && byte <= 57) ||
      (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) ||
      byte == 45 || byte == 46 || byte == 95 || byte == 126
    {
      return String(Character(scalar))
    }
    return String(format: "%%%02X", byte)
  }.joined()
  components.percentEncodedPath += "/\(encoded)"
  return components.url!
}

func dataHello(_ request: IOSStreamOpenRequest) -> String? {
  let value: [String: Any] = [
    "type": "DATA_HELLO",
    "connection_id": request.connectionId,
    "connection_token": request.connectionToken,
  ]
  guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else {
    return nil
  }
  return String(data: data, encoding: .utf8)
}

func isDataAccepted(_ value: String, connectionId: String) -> Bool {
  guard
    value.utf8.count <= 64 * 1_024,
    let data = value.data(using: .utf8),
    let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(message.keys) == Set(["type", "connection_id"]),
    message["type"] as? String == "DATA_ACCEPTED",
    message["connection_id"] as? String == connectionId
  else {
    return false
  }
  return true
}

func stableStreamReason(_ reason: String) -> String {
  guard
    reason.count <= 64,
    reason.range(of: "^[A-Z0-9_]+$", options: .regularExpression) != nil
  else {
    return "STREAM_FAILED"
  }
  return reason
}
