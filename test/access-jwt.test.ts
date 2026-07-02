import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticateRequest,
  resetJwksCache,
  verifyAccessJwt,
} from "../src/lib/access-jwt";
import type { Env } from "../src/types";

const TEAM_DOMAIN = "example-team.cloudflareaccess.com";
const APP_AUD = "test-aud-tag-0123456789abcdef";
const KID = "test-key-1";

let keyPair: CryptoKeyPair;
let strangerKeyPair: CryptoKeyPair;
let jwksBody: string;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signToken(
  payload: Record<string, unknown>,
  options?: { key?: CryptoKey; kid?: string },
): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "RS256", kid: options?.kid ?? KID })),
  );
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    options?.key ?? keyPair.privateKey,
    encoder.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [APP_AUD],
    email: "operator@example.test",
    exp: now + 600,
    nbf: now - 60,
    iat: now,
    iss: `https://${TEAM_DOMAIN}`,
    sub: "user-id",
    ...overrides,
  };
}

const jwksFetcher: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
    return new Response(jwksBody, {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(null, { status: 404 });
};

function productionEnv(overrides?: Partial<Env>): Env {
  return {
    ...env,
    ENVIRONMENT: "production",
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_APP_AUD: APP_AUD,
    ...overrides,
  } as Env;
}

beforeAll(async () => {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  keyPair = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  strangerKeyPair = (await crypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  )) as unknown as Record<string, unknown>;
  jwksBody = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
});

beforeEach(() => {
  resetJwksCache();
});

describe("verifyAccessJwt", () => {
  it("accepts a valid token and returns the email claim", async () => {
    const token = await signToken(validPayload());
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result).toEqual({ ok: true, email: "operator@example.test" });
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(validPayload({ exp: now - 3600 }));
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("expired");
  });

  it("rejects a wrong audience", async () => {
    const token = await signToken(validPayload({ aud: ["some-other-app"] }));
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("audience");
  });

  it("rejects a wrong issuer", async () => {
    const token = await signToken(
      validPayload({ iss: "https://attacker.cloudflareaccess.com" }),
    );
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("issuer");
  });

  it("rejects a token signed by an unknown key", async () => {
    const token = await signToken(validPayload(), {
      key: strangerKeyPair.privateKey,
    });
    const result = await verifyAccessJwt(token, TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("signature");
  });

  it("rejects garbage tokens", async () => {
    const result = await verifyAccessJwt("nope", TEAM_DOMAIN, APP_AUD, jwksFetcher);
    expect(result.ok).toBe(false);
  });
});

describe("authenticateRequest", () => {
  it("rejects a request with no token", async () => {
    const request = new Request("https://example.test/api/tenants");
    const result = await authenticateRequest(request, productionEnv(), jwksFetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("missing");
    }
  });

  it("fails closed when Access vars are unset, even with a valid token", async () => {
    const token = await signToken(validPayload());
    const request = new Request("https://example.test/api/tenants", {
      headers: { "cf-access-jwt-assertion": token },
    });
    const result = await authenticateRequest(
      request,
      productionEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_APP_AUD: "" }),
      jwksFetcher,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.reason).toContain("not configured");
    }
  });

  it("accepts a valid token in production mode", async () => {
    const token = await signToken(validPayload());
    const request = new Request("https://example.test/api/tenants", {
      headers: { "cf-access-jwt-assertion": token },
    });
    const result = await authenticateRequest(request, productionEnv(), jwksFetcher);
    expect(result).toEqual({ ok: true, email: "operator@example.test" });
  });

  it("bypasses validation only when ENVIRONMENT is development", async () => {
    const request = new Request("https://example.test/api/tenants");
    const bypass = await authenticateRequest(
      request,
      productionEnv({
        ENVIRONMENT: "development",
        DEV_OPERATOR_EMAIL: "dev@localhost",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_APP_AUD: "",
      }),
      jwksFetcher,
    );
    expect(bypass).toEqual({ ok: true, email: "dev@localhost" });

    const staging = await authenticateRequest(
      request,
      productionEnv({ ENVIRONMENT: "staging" }),
      jwksFetcher,
    );
    expect(staging.ok).toBe(false);
  });

  it("defaults the dev identity to dev@localhost", async () => {
    const request = new Request("https://example.test/api/tenants");
    const result = await authenticateRequest(
      request,
      productionEnv({ ENVIRONMENT: "development", DEV_OPERATOR_EMAIL: undefined }),
      jwksFetcher,
    );
    expect(result).toEqual({ ok: true, email: "dev@localhost" });
  });
});

describe("management surface fail-closed integration", () => {
  it("rejects /manage when Access vars are unset in production", async () => {
    const response = await SELF.fetch("https://check.example.test/manage/");
    expect(response.status).toBe(403);
    const body = await response.json<any>();
    expect(body.error).toContain("not configured");
  });
});
