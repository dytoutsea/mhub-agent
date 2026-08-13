import Foundation

private var failures: [String] = []

private func check(_ condition: @autoclosure () -> Bool, _ name: String) {
  if !condition() {
    failures.append(name)
  }
}

let base = URL(string: "wss://relay.example/agent/v1/data")!
check(
  dataStreamURL(base: base, connectionId: "rcn_1/2").absoluteString ==
    "wss://relay.example/agent/v1/data/rcn_1%2F2",
  "encodes the connection ID as one path segment"
)

let publicV4 = parseIPAddress("8.8.8.8")
let publicV6 = parseIPAddress("2606:4700:4700::1111")
check(publicV4 != nil && isAllowedTargetAddress(publicV4!), "accepts a public IPv4 literal")
check(publicV6 != nil && isAllowedTargetAddress(publicV6!), "accepts a public IPv6 literal")
check(parseIPAddress("example.com") == nil, "rejects domain names")
check(parseIPAddress("fe80::1%en0") == nil, "rejects scoped IPv6 literals")
check(parseIPAddress("999.8.8.8") == nil, "rejects malformed IPv4 literals")

let blocked = [
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
  "fec0::1",
  "2001:db8::1",
]
for value in blocked {
  let address = parseIPAddress(value)
  check(address != nil && !isAllowedTargetAddress(address!), "rejects reserved target \(value)")
}

check(
  isDataAccepted(
    "{\"type\":\"DATA_ACCEPTED\",\"connection_id\":\"rcn_1\"}",
    connectionId: "rcn_1"
  ),
  "accepts the strict pairing response"
)
check(
  !isDataAccepted(
    "{\"type\":\"DATA_ACCEPTED\",\"connection_id\":\"rcn_2\"}",
    connectionId: "rcn_1"
  ),
  "rejects a mismatched pairing response"
)
check(
  !isDataAccepted(
    "{\"type\":\"DATA_ACCEPTED\",\"connection_id\":\"rcn_1\",\"extra\":true}",
    connectionId: "rcn_1"
  ),
  "rejects extra pairing fields"
)
check(!isDataAccepted("not-json", connectionId: "rcn_1"), "rejects malformed pairing JSON")
check(stableStreamReason("TARGET_CLOSED") == "TARGET_CLOSED", "keeps stable close reasons")
check(stableStreamReason("native error detail") == "STREAM_FAILED", "redacts native errors")

let hello = dataHello(
  IOSStreamOpenRequest(
    connectionId: "rcn_1",
    connectionToken: String(repeating: "a", count: 32),
    host: "8.8.8.8",
    port: 443,
    connectTimeoutMs: 5_000
  )
)
let helloData = hello?.data(using: .utf8)
let helloObject = helloData.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
let helloKeys = helloObject.map { Array($0.keys) } ?? []
check(Set(helloKeys) == Set(["type", "connection_id", "connection_token"]), "builds strict DATA_HELLO")

if !failures.isEmpty {
  for failure in failures {
    FileHandle.standardError.write(Data("FAIL: \(failure)\n".utf8))
  }
  exit(1)
}

print("iOS native data stream tests passed")
