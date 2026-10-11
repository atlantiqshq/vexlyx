import { createSign } from "node:crypto";

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createGitHubAppJwt(appId: bigint, privateKey: string, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId.toString() }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}
