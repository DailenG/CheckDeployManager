// Instance-level tenant defaults (backlog item: branding and policy
// inheritance). Stored as JSON in the tenant_defaults instance setting and
// resolved at artifact generation time, never copied into tenant rows: a
// tenant key present wins, else the default, else the hardcoded fallback.

// Branding text fields a tenant inherits when its own value is the empty
// string. The logo inherits through the asset route, not through these.
export const INHERITABLE_BRANDING_FIELDS = [
  "company_name",
  "product_name",
  "support_email",
  "support_url",
  "privacy_policy_url",
  "about_url",
  "primary_color",
] as const;

// Policy keys a tenant inherits when absent from its settings JSON.
// Deliberately excluded: cippTenantId (maps a client to its CIPP tenant),
// cippServerUrl (default_cipp_server_url is the dedicated instance setting),
// and enableDebugLogging (a per-tenant troubleshooting switch).
export const INHERITABLE_POLICY_FIELDS = [
  "updateInterval",
  "enablePageBlocking",
  "showNotifications",
  "enableValidPageBadge",
  "validPageBadgeTimeout",
  "enableCippReporting",
  "urlAllowlist",
  "domainSquatting",
  "genericWebhook",
] as const;

export interface TenantDefaults {
  branding: Record<string, string>;
  policy: Record<string, unknown>;
}

// Tolerant parse for resolution time: anything malformed or non-inheritable
// is dropped so a bad stored value can never poison artifact generation.
// Strict validation lives in the instance settings PUT.
export function parseTenantDefaults(raw: string): TenantDefaults {
  const defaults: TenantDefaults = { branding: {}, policy: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaults;
  }
  const { branding, policy } = parsed as Record<string, unknown>;
  if (branding !== null && typeof branding === "object" && !Array.isArray(branding)) {
    for (const field of INHERITABLE_BRANDING_FIELDS) {
      const value = (branding as Record<string, unknown>)[field];
      if (typeof value === "string" && value !== "") defaults.branding[field] = value;
    }
  }
  if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
    for (const field of INHERITABLE_POLICY_FIELDS) {
      const value = (policy as Record<string, unknown>)[field];
      if (value !== undefined) defaults.policy[field] = value;
    }
  }
  return defaults;
}
