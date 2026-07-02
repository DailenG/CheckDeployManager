import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { writeAudit } from "../../lib/audit";
import { readJsonBody, requireTenant } from "./util";

// Managed-schema toggles stored per tenant (design 2.1). The webhook URL is
// always derived from the instance base URL and tenant GUID, never stored.
type FieldCheck = (value: unknown) => boolean;

const isBoolean: FieldCheck = (v) => typeof v === "boolean";
const isNumber: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const isString: FieldCheck = (v) => typeof v === "string";
const isStringArray: FieldCheck = (v) =>
  Array.isArray(v) && v.every((item) => typeof item === "string");

const POLICY_FIELDS: Record<string, FieldCheck> = {
  enablePageBlocking: isBoolean,
  showNotifications: isBoolean,
  enableValidPageBadge: isBoolean,
  validPageBadgeTimeout: isNumber,
  enableDebugLogging: isBoolean,
  updateInterval: isNumber,
  urlAllowlist: isStringArray,
  domainSquatting: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  genericWebhook: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  enableCippReporting: isBoolean,
  cippServerUrl: isString,
  cippTenantId: isString,
};

export function validatePolicySettings(settings: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const check = POLICY_FIELDS[key];
    if (check === undefined) {
      errors.push(`unknown policy setting: ${key}`);
    } else if (!check(value)) {
      errors.push(`policy setting ${key} has the wrong type`);
    }
  }
  return errors;
}

export const policyRoutes = new Hono<AppEnv>();

policyRoutes.get("/:id/policy", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const row = await c.env.DB.prepare(
    "SELECT settings_json FROM tenant_policy_settings WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first<{ settings_json: string }>();
  return c.json({ settings: JSON.parse(row?.settings_json ?? "{}") });
});

policyRoutes.put("/:id/policy", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const body = await readJsonBody(c);
  if (
    body === null ||
    body.settings === null ||
    typeof body.settings !== "object" ||
    Array.isArray(body.settings)
  ) {
    return c.json({ error: "body must be JSON with a settings object" }, 400);
  }
  const settings = body.settings as Record<string, unknown>;
  const errors = validatePolicySettings(settings);
  if (errors.length > 0) return c.json({ errors }, 422);

  await c.env.DB.prepare(
    "INSERT INTO tenant_policy_settings (tenant_id, settings_json) VALUES (?, ?) " +
      "ON CONFLICT(tenant_id) DO UPDATE SET settings_json = excluded.settings_json",
  )
    .bind(tenant.id, JSON.stringify(settings))
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "policy.update", tenant.id, {
    keys: Object.keys(settings),
  });
  return c.json({ ok: true, settings });
});
