import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubAppJwt } from "./tokens.js";

describe("createGitHubAppJwt", () => {
  it("creates a valid RS256 token with GitHub's required claims", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const token = createGitHubAppJwt(12345n, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), now);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg: string };
    const decodedPayload = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iat: number; exp: number; iss: string };
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();

    expect(decodedHeader.alg).toBe("RS256");
    expect(decodedPayload.iss).toBe("12345");
    expect(decodedPayload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(decodedPayload.exp - decodedPayload.iat).toBe(540);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});
