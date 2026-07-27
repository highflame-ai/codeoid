/**
 * Minimal JWT signing for the push providers — ES256 for APNs (a `.p8` EC key)
 * and RS256 for FCM's OAuth2 assertion (a service-account RSA key). Kept tiny
 * and dependency-free (node:crypto only) so push-core stays portable.
 */
import { sign } from "node:crypto";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function encode(header: object, claims: object): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
}

/**
 * ES256 (ECDSA P-256 + SHA-256) JWT for APNs token auth. `dsaEncoding:
 * "ieee-p1363"` yields the raw r‖s signature JOSE requires (not DER).
 */
export function signEs256(
  claims: Record<string, unknown>,
  keyId: string,
  p8Pem: string,
): string {
  const input = encode({ alg: "ES256", kid: keyId }, claims);
  const sig = sign("sha256", Buffer.from(input), { key: p8Pem, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** RS256 (RSA + SHA-256) JWT for the FCM OAuth2 jwt-bearer grant. */
export function signRs256(claims: Record<string, unknown>, privateKeyPem: string): string {
  const input = encode({ alg: "RS256", typ: "JWT" }, claims);
  const sig = sign("RSA-SHA256", Buffer.from(input), privateKeyPem);
  return `${input}.${b64url(sig)}`;
}
