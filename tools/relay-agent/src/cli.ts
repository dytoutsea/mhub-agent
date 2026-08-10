import { RelayAgent } from "./relay-agent.js";

const agent = new RelayAgent({
  controlUrl: requiredEnvironment("MHUB_AGENT_RELAY_CONTROL_URL"),
  proxyId: requiredEnvironment("MHUB_AGENT_PROXY_ID"),
  ticket: requiredEnvironment("MHUB_AGENT_SESSION_TICKET"),
  allowPrivateTargets: process.env.MHUB_AGENT_ALLOW_PRIVATE_TARGETS === "true",
  onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
});

try {
  await agent.start();
  await waitForShutdown(agent);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ type: "agent_failed", error: stableError(error) })}\n`);
  process.exitCode = 1;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name}_REQUIRED`);
  }
  return value;
}

function waitForShutdown(agent: RelayAgent): Promise<void> {
  return new Promise((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void agent.stop().then(resolve, reject);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function stableError(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_: -]+$/.test(error.message)) {
    return error.message;
  }
  return "UNEXPECTED_ERROR";
}
