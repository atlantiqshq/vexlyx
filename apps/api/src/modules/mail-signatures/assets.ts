import { env } from "../../config/env.js";

export type LogoType = { contentType: string; extension: string };

/**
 * Identifies an uploaded logo by its leading bytes, never by the file name or the
 * Content-Type the client sent. Only these four raster formats are accepted: SVG can
 * carry script, so it is deliberately not one of them.
 */
export function detectLogoType(bytes: Uint8Array): LogoType | null {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((value, index) => bytes[offset + index] === value);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", extension: "png" };
  if (startsWith([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", extension: "jpg" };
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    return { contentType: "image/gif", extension: "gif" };
  }
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export const ASSET_FILE_NAME = /^[a-z0-9]{20,32}\.(png|jpg|gif|webp)$/;

/** Public base URL of the API, where mail clients fetch logos from. */
export function apiPublicUrl(path = ""): string {
  const base = env.PANEL_DOMAIN ? `https://api.${env.PANEL_DOMAIN}` : `http://localhost:${env.PORT}`;
  return `${base}${path}`;
}

export function assetUrl(fileName: string): string {
  return apiPublicUrl(`/api/signature-assets/${fileName}`);
}
