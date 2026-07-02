// Cloudflare Access JWT validation (design section 4). Every /api and
// /manage request must carry a cf-access-jwt-assertion token signed by the
// team's JWKS with the app's AUD tag. Fails closed: missing configuration
// rejects everything. The only exception is the explicit local development
// bypass, which activates solely on ENVIRONMENT=development.
import type { Env } from "../types";

export type AuthResult =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 403; reason: string };

interface AccessJwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  iss?: string;
  sub?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

let jwksCache: {
  teamDomain: string;
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
} | null = null;

let devBypassWarned = false;

function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    return null;
  }
}

async function loadJwks(
  teamDomain: string,
  fetcher: typeof fetch,
): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (
    jwksCache !== null &&
    jwksCache.teamDomain === teamDomain &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`JWKS fetch returned HTTP ${response.status}`);
  }
  const jwks = (await response.json()) as {
    keys?: (JsonWebKey & { kid?: string })[];
  };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of jwks.keys ?? []) {
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  jwksCache = { teamDomain, fetchedAt: now, keys };
  return keys;
}

// Exposed for tests: clears the module-level JWKS cache.
export function resetJwksCache(): void {
  jwksCache = null;
}

export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthResult> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return { ok: false, status: 403, reason: "token is not a JWT" };
  }
  const header = decodeJson<{ alg?: string; kid?: string }>(segments[0]);
  if (header === null || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, status: 403, reason: "unsupported token header" };
  }
  const payload = decodeJson<AccessJwtPayload>(segments[1]);
  if (payload === null) {
    return { ok: false, status: 403, reason: "token payload does not parse" };
  }

  let keys: Map<string, CryptoKey>;
  try {
    keys = await loadJwks(teamDomain, fetcher);
    if (!keys.has(header.kid)) {
      // The signing key may have rotated since the cache was filled.
      resetJwksCache();
      keys = await loadJwks(teamDomain, fetcher);
    }
  } catch (err) {
    return {
      ok: false,
      status: 403,
      reason: err instanceof Error ? err.message : "JWKS fetch failed",
    };
  }
  const key = keys.get(header.kid);
  if (key === undefined) {
    return { ok: false, status: 403, reason: "no JWKS key matches the token kid" };
  }

  const signed = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(segments[2]),
    signed,
  );
  if (!valid) {
    return { ok: false, status: 403, reason: "signature verification failed" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return { ok: false, status: 403, reason: "token is expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, status: 403, reason: "token is not yet valid" };
  }
  if (payload.iss !== `https://${teamDomain}`) {
    return { ok: false, status: 403, reason: "issuer mismatch" };
  }
  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : typeof payload.aud === "string"
      ? [payload.aud]
      : [];
  if (!audiences.includes(expectedAud)) {
    return { ok: false, status: 403, reason: "audience mismatch" };
  }
  if (typeof payload.email !== "string" || payload.email.length === 0) {
    return { ok: false, status: 403, reason: "token has no email claim" };
  }
  return { ok: true, email: payload.email };
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<AuthResult> {
  if (env.ENVIRONMENT === "development") {
    if (!devBypassWarned) {
      console.warn(
        "WARNING: ENVIRONMENT=development, Cloudflare Access JWT validation is BYPASSED. " +
          "Never run production with this setting.",
      );
      devBypassWarned = true;
    }
    return { ok: true, email: env.DEV_OPERATOR_EMAIL || "dev@localhost" };
  }

  // Fail closed until the post-deploy runbook fills in both identifiers.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_APP_AUD) {
    return {
      ok: false,
      status: 403,
      reason:
        "Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_APP_AUD unset); refusing all requests",
    };
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (token === null || token.length === 0) {
    return { ok: false, status: 401, reason: "missing cf-access-jwt-assertion header" };
  }
  return verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_APP_AUD, fetcher);
}
