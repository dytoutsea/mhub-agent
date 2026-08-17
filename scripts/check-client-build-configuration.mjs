const channel = required("MHUB_RELEASE_CHANNEL");
const activationApiUrl = endpoint(
  "MHUB_AGENT_ACTIVATION_API_URL",
  required("MHUB_AGENT_ACTIVATION_API_URL"),
  "/agent-api/v1/activations:exchange",
  channel === "dev" ? ["http:", "https:"] : ["https:"],
);
const relayControlUrl = endpoint(
  "MHUB_RELAY_CONTROL_URL",
  required("MHUB_RELAY_CONTROL_URL"),
  "/agent/v1/control",
  channel === "dev" ? ["ws:", "wss:"] : ["wss:"],
);

if (channel !== "dev" && channel !== "main") {
  throw new Error("MHUB_RELEASE_CHANNEL must be dev or main");
}
if (
  channel === "main" &&
  (isIpLiteral(activationApiUrl.hostname) || isIpLiteral(relayControlUrl.hostname))
) {
  throw new Error("main client endpoints must use DNS hostnames");
}

console.log(`Validated ${channel} client service endpoint configuration`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function endpoint(name, value, pathname, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (
    !protocols.includes(parsed.protocol) ||
    parsed.pathname !== pathname ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${name} has an invalid protocol, path, credentials, query, or fragment`);
  }
  return parsed;
}

function isIpLiteral(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}
