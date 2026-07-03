import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { writeAudit } from "../../lib/audit";
import { getInstanceSettings } from "../../lib/db";
import {
  INHERITABLE_BRANDING_FIELDS,
  INHERITABLE_POLICY_FIELDS,
  parseTenantDefaults,
} from "../../lib/tenant-defaults";
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

// Strict gate for the tenant_defaults instance setting. Policy values reuse
// the per-tenant field checks but only inheritable keys are allowed; the
// tolerant parse in lib/tenant-defaults.ts is the resolution-time
// counterpart of this write-time validation.
export function validateTenantDefaults(raw: string): string[] {
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ["tenant_defaults must be valid JSON"];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ["tenant_defaults must be a JSON object"];
  }
  const errors: string[] = [];
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "branding" && key !== "policy") {
      errors.push(`tenant_defaults has an unknown section: ${key}`);
    }
  }
  const { branding, policy } = body;
  if (branding !== undefined) {
    if (branding === null || typeof branding !== "object" || Array.isArray(branding)) {
      errors.push("tenant_defaults.branding must be an object");
    } else {
      const brandingFields: readonly string[] = INHERITABLE_BRANDING_FIELDS;
      for (const [key, value] of Object.entries(branding)) {
        if (!brandingFields.includes(key)) {
          errors.push(`tenant_defaults.branding has an unknown field: ${key}`);
        } else if (typeof value !== "string") {
          errors.push(`tenant_defaults.branding.${key} must be a string`);
        }
      }
    }
  }
  if (policy !== undefined) {
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
      errors.push("tenant_defaults.policy must be an object");
    } else {
      const inheritable: readonly string[] = INHERITABLE_POLICY_FIELDS;
      for (const [key, value] of Object.entries(policy)) {
        const check = POLICY_FIELDS[key];
        if (check === undefined) {
          errors.push(`tenant_defaults.policy has an unknown setting: ${key}`);
        } else if (!inheritable.includes(key)) {
          errors.push(`policy setting ${key} is never inherited`);
        } else if (!check(value)) {
          errors.push(`tenant_defaults.policy.${key} has the wrong type`);
        }
      }
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
  const instanceSettings = await getInstanceSettings(c.env.DB);
  return c.json({
    settings: JSON.parse(row?.settings_json ?? "{}"),
    // Instance-level defaults, so the dashboard can mark inherited fields.
    defaults: parseTenantDefaults(instanceSettings.tenant_defaults ?? "").policy,
  });
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
