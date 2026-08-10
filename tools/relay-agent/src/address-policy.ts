import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

export function isAllowedTargetIp(value: string, allowPrivateTargets = false): boolean {
  if (isIP(value) === 0 || value.includes("%")) {
    return false;
  }
  let address = ipaddr.parse(value);
  if (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()) {
    address = address.toIPv4Address();
  }
  if (allowPrivateTargets) {
    return address.range() !== "unspecified" && address.range() !== "multicast";
  }
  return address.range() === "unicast";
}

export function sameIp(left: string | undefined, right: string): boolean {
  if (!left || isIP(left) === 0 || isIP(right) === 0) {
    return false;
  }
  let leftAddress = ipaddr.parse(left);
  let rightAddress = ipaddr.parse(right);
  if (leftAddress instanceof ipaddr.IPv6 && leftAddress.isIPv4MappedAddress()) {
    leftAddress = leftAddress.toIPv4Address();
  }
  if (rightAddress instanceof ipaddr.IPv6 && rightAddress.isIPv4MappedAddress()) {
    rightAddress = rightAddress.toIPv4Address();
  }
  return (
    leftAddress.kind() === rightAddress.kind() && leftAddress.toString() === rightAddress.toString()
  );
}
