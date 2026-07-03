import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import {
  DEFAULT_INSTANCE_SETTINGS,
  getActiveSnapshot,
  getInstanceSettings,
  nowIso,
  putInstanceSetting,
} from "../../lib/db";
import { writeAudit } from "../../lib/audit";
import { republishAllTenants } from "../../lib/publish";
import { validateDelta } from "../../lib/validate";
import { LOGO_TYPES, MAX_LOGO_BYTES } from "./branding";
import { validateTenantDefaults } from "./policy";
import { readJsonBody } from "./util";
import pkg from "../../../package.json";

const INTEGER_SETTINGS = new Set([
  "metrics_retention_days",
  "webhook_retention_days",
  "stale_fetch_hours",
  "upstream_keep_snapshots",
]);

// Written only by the default-logo endpoints below, which keep the R2 object
// and these two keys in step; a direct settings write could split them.
const LOGO_SETTINGS = new Set(["default_logo_r2_key", "default_logo_content_type"]);

export const instanceRoutes = new Hono<AppEnv>();

// Aggregate first-run status for the setup wizard. Read-only composition of
// existing helpers, except for one lazy write: the first time the
// onboarding_completed_at key is seeded on an instance that already shows
// signs of life (tenants exist or public_base_url is set), the instance
// predates the wizard, so stamp it complete rather than surface setup steps
// to a configured deployment. The key-was-missing check is what keeps a
// fresh instance mid-wizard from auto-completing after its settings step.
instanceRoutes.get("/status", async (c) => {
  const preSeed = await c.env.DB.prepare(
    "SELECT value FROM instance_settings WHERE key = 'onboarding_completed_at'",
  ).first<{ value: string }>();
  const settings = await getInstanceSettings(c.env.DB);
  const snapshot = await getActiveSnapshot(c.env.DB);
  const tenantCount =
    (
      await c.env.DB.prepare("SELECT COUNT(*) AS n FROM tenants").first<{
        n: number;
      }>()
    )?.n ?? 0;
  const anyPublished =
    (await c.env.DB.prepare("SELECT 1 FROM ruleset_versions LIMIT 1").first()) !==
    null;

  let completedAt = settings.onboarding_completed_at;
  const legacyInstance =
    preSeed === null &&
    completedAt === "" &&
    (tenantCount > 0 || settings.public_base_url !== "");
  if (legacyInstance) {
    completedAt = nowIso();
    await putInstanceSetting(c.env.DB, "onboarding_completed_at", completedAt);
  }

  return c.json({
    operator_email: c.get("operatorEmail"),
    environment: c.env.ENVIRONMENT,
    version: pkg.version,
    onboarding_complete: completedAt !== "",
    checks: {
      settings_configured: settings.public_base_url !== "",
      upstream_synced: snapshot !== null,
      upstream_version: snapshot?.upstream_version ?? null,
      upstream_fetched_at: snapshot?.fetched_at ?? null,
      tenant_count: tenantCount,
      any_published: anyPublished,
    },
  });
});

instanceRoutes.get("/settings", async (c) => {
  return c.json({ settings: await getInstanceSettings(c.env.DB) });
});

instanceRoutes.put("/settings", async (c) => {
  const body = await readJsonBody(c);
  if (
    body === null ||
    body.settings === null ||
    typeof body.settings !== "object" ||
    Array.isArray(body.settings)
  ) {
    return c.json({ error: "body must be JSON with a settings object" }, 400);
  }
  const updates = body.settings as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!(key in DEFAULT_INSTANCE_SETTINGS)) {
      errors.push(`unknown setting: ${key}`);
    } else if (LOGO_SETTINGS.has(key)) {
      errors.push(`setting ${key} is managed through /api/instance/default-logo`);
    } else if (typeof value !== "string") {
      errors.push(`setting ${key} must be a string`);
    } else if (INTEGER_SETTINGS.has(key) && !/^\d+$/.test(value)) {
      errors.push(`setting ${key} must be a non-negative integer string`);
    } else if (key === "tenant_defaults") {
      errors.push(...validateTenantDefaults(value));
    } else if (key === "baseline_rule_delta" && value !== "") {
      errors.push(
        ...validateDelta(value).errors.map((error) => `baseline_rule_delta: ${error}`),
      );
    }
  }
  if (errors.length > 0) return c.json({ errors }, 422);

  for (const [key, value] of Object.entries(updates)) {
    await putInstanceSetting(c.env.DB, key, value as string);
  }
  await writeAudit(c.env.DB, c.get("operatorEmail"), "instance.settings_update", null, {
    keys: Object.keys(updates),
  });
  return c.json({ ok: true, settings: await getInstanceSettings(c.env.DB) });
});

// Instance default logo: served by /assets/{guid}/logo whenever the tenant
// has none of its own. Same constraints as the per-tenant upload.
instanceRoutes.get("/default-logo", async (c) => {
  const settings = await getInstanceSettings(c.env.DB);
  if (settings.default_logo_r2_key === "") {
    return c.json({ error: "no default logo set" }, 404);
  }
  const object = await c.env.STORAGE.get(settings.default_logo_r2_key);
  if (object === null) return c.json({ error: "no default logo set" }, 404);
  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": settings.default_logo_content_type || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

instanceRoutes.put("/default-logo", async (c) => {
  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({ error: "body must be multipart/form-data with a logo file" }, 400);
  }
  const form = await c.req.formData();
  const logo = form.get("logo");
  if (!(logo instanceof File)) {
    return c.json({ error: "logo file is required" }, 400);
  }
  const extension = LOGO_TYPES[logo.type];
  if (extension === undefined) {
    return c.json({ error: "logo must be png, jpg, or svg" }, 400);
  }
  if (logo.size > MAX_LOGO_BYTES) {
    return c.json({ error: "logo exceeds 512 KB" }, 413);
  }
  // "instance-default" cannot collide with tenant keys: those use UUIDs.
  const key = `assets/instance-default/logo.${extension}`;
  await c.env.STORAGE.put(key, await logo.arrayBuffer(), {
    httpMetadata: { contentType: logo.type },
  });
  const previous = await getInstanceSettings(c.env.DB);
  if (previous.default_logo_r2_key !== "" && previous.default_logo_r2_key !== key) {
    await c.env.STORAGE.delete(previous.default_logo_r2_key);
  }
  await putInstanceSetting(c.env.DB, "default_logo_r2_key", key);
  await putInstanceSetting(c.env.DB, "default_logo_content_type", logo.type);
  await writeAudit(c.env.DB, c.get("operatorEmail"), "instance.default_logo_update", null, {
    contentType: logo.type,
  });
  return c.json({ ok: true });
});

// Fleet republish: re-merges every tenant with a published version using
// its frozen delta. The way a baseline_rule_delta change reaches tenants
// without waiting for their next individual publish.
instanceRoutes.post("/republish", async (c) => {
  const operator = c.get("operatorEmail");
  const outcome = await republishAllTenants(
    c.env,
    operator,
    "baseline republish",
    operator,
  );
  await writeAudit(c.env.DB, operator, "rules.republish_all", null, {
    republished: outcome.republished,
    failures: outcome.failures.length,
  });
  return c.json(outcome);
});

instanceRoutes.delete("/default-logo", async (c) => {
  const settings = await getInstanceSettings(c.env.DB);
  if (settings.default_logo_r2_key !== "") {
    await c.env.STORAGE.delete(settings.default_logo_r2_key);
  }
  await putInstanceSetting(c.env.DB, "default_logo_r2_key", "");
  await putInstanceSetting(c.env.DB, "default_logo_content_type", "");
  await writeAudit(c.env.DB, c.get("operatorEmail"), "instance.default_logo_remove", null, {});
  return c.json({ ok: true });
});
