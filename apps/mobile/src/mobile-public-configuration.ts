export interface MobilePublicConfiguration {
  readonly activationApiUrl: string;
  readonly controlUrl: string;
}

export function mobilePublicConfiguration(): MobilePublicConfiguration | null {
  return parseMobilePublicConfiguration(
    process.env.EXPO_PUBLIC_MHUB_AGENT_ACTIVATION_API_URL,
    process.env.EXPO_PUBLIC_MHUB_RELAY_CONTROL_URL,
    process.env.EXPO_PUBLIC_MHUB_RELEASE_CHANNEL,
  );
}

export function parseMobilePublicConfiguration(
  activationApiValue: string | undefined,
  controlValue: string | undefined,
  releaseChannelValue?: string,
): MobilePublicConfiguration | null {
  const activationApiUrl = activationApiValue?.trim();
  const controlUrl = controlValue?.trim();
  const releaseChannel = releaseChannelValue?.trim();
  if (!activationApiUrl || !controlUrl) {
    return null;
  }
  if (releaseChannel && releaseChannel !== "dev" && releaseChannel !== "main") {
    return null;
  }
  try {
    const activation = new URL(activationApiUrl);
    const control = new URL(controlUrl);
    const allowInsecureDevelopmentEndpoint = releaseChannel === "dev";
    if (
      !(
        activation.protocol === "https:" ||
        (allowInsecureDevelopmentEndpoint && activation.protocol === "http:")
      ) ||
      activation.pathname !== "/agent-api/v1/activations:exchange" ||
      activation.search ||
      activation.hash ||
      activation.username ||
      activation.password ||
      !(
        control.protocol === "wss:" ||
        (allowInsecureDevelopmentEndpoint && control.protocol === "ws:")
      ) ||
      control.pathname !== "/agent/v1/control" ||
      control.search ||
      control.hash ||
      control.username ||
      control.password
    ) {
      return null;
    }
    return { activationApiUrl: activation.toString(), controlUrl: control.toString() };
  } catch {
    return null;
  }
}
