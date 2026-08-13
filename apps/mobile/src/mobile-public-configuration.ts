export interface MobilePublicConfiguration {
  readonly activationApiUrl: string;
  readonly controlUrl: string;
}

export function mobilePublicConfiguration(): MobilePublicConfiguration | null {
  return parseMobilePublicConfiguration(
    process.env.EXPO_PUBLIC_MHUB_AGENT_ACTIVATION_API_URL,
    process.env.EXPO_PUBLIC_MHUB_RELAY_CONTROL_URL,
  );
}

export function parseMobilePublicConfiguration(
  activationApiValue: string | undefined,
  controlValue: string | undefined,
): MobilePublicConfiguration | null {
  const activationApiUrl = activationApiValue?.trim();
  const controlUrl = controlValue?.trim();
  if (!activationApiUrl || !controlUrl) {
    return null;
  }
  try {
    const activation = new URL(activationApiUrl);
    const control = new URL(controlUrl);
    if (
      activation.protocol !== "https:" ||
      activation.pathname !== "/agent-api/v1/activations:exchange" ||
      activation.search ||
      activation.hash ||
      control.protocol !== "wss:" ||
      control.pathname !== "/agent/v1/control" ||
      control.search ||
      control.hash
    ) {
      return null;
    }
    return { activationApiUrl: activation.toString(), controlUrl: control.toString() };
  } catch {
    return null;
  }
}
