import { env } from "cloudflare:test";
import { newToken, nowIso } from "../src/lib/db";
import { syncUpstream, type SyncOutcome } from "../src/lib/upstream";

// Fictional sample tenant from the design document. Never use real data.
export const SAMPLE_GUID = "f4a7c1d2-9b3e-4c8a-a1d6-2e5b7c9f0a34";
export const SAMPLE_TENANT_NAME = "Harborview Physical Therapy";

export const SAMPLE_DELTA = {
  add_exclusion_domain_patterns: [
    "^https://[^/]*\\.knowbe4\\.com(/.*)?$",
    "^https://[^/]*\\.harborviewpt\\.com(/.*)?$",
  ],
  add_trusted_login_patterns: [],
  add_phishing_indicators: [],
  suppress_indicator_ids: ["phi_004"],
  raw_overrides: {},
};

export function fetcherReturning(body: string, status = 200): typeof fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
}

export function fetcherFailing(): typeof fetch {
  return async () => {
    throw new TypeError("network unreachable");
  };
}

export async function seedUpstream(body: string): Promise<SyncOutcome> {
  return syncUpstream(env, "test", fetcherReturning(body));
}

export async function createTenant(options?: {
  name?: string;
  guid?: string;
}): Promise<{ tenantId: string; guid: string; previewToken: string }> {
  const tenantId = crypto.randomUUID();
  const guid = options?.guid ?? crypto.randomUUID();
  const previewToken = newToken();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tenants (id, name, notes, preview_token, created_at, updated_at) " +
        "VALUES (?, ?, NULL, ?, ?, ?)",
    ).bind(tenantId, options?.name ?? SAMPLE_TENANT_NAME, previewToken, now, now),
    env.DB.prepare(
      "INSERT INTO tenant_guids (guid, tenant_id, created_at) VALUES (?, ?, ?)",
    ).bind(guid, tenantId, now),
    env.DB.prepare(
      "INSERT INTO tenant_rule_deltas (tenant_id, draft_json, updated_at, updated_by) " +
        "VALUES (?, '{}', ?, 'test')",
    ).bind(tenantId, now),
    env.DB.prepare("INSERT INTO tenant_branding (tenant_id) VALUES (?)").bind(tenantId),
    env.DB.prepare("INSERT INTO tenant_policy_settings (tenant_id) VALUES (?)").bind(
      tenantId,
    ),
  ]);
  return { tenantId, guid, previewToken };
}
