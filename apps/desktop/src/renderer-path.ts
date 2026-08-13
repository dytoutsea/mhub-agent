import path from "node:path";

export function resolveRendererPath(rendererRoot: string, requestUrl: string): string | null {
  const url = new URL(requestUrl);
  if (url.protocol !== "mhub:" || url.hostname !== "renderer") {
    return null;
  }
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  } catch {
    return null;
  }
  const normalizedRoot = path.resolve(rendererRoot);
  const resolvedPath = path.resolve(normalizedRoot, relativePath);
  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }
  return resolvedPath;
}
