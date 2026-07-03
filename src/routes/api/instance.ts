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
import { readJsonBody } from "./util";

const INTEGER_SETTINGS = new Set([
  "metrics_retention_days",
  "webhook_retention_days",
  "stale_fetch_hours",
  "upstream_keep_snapshots",
]);

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
    } else if (typeof value !== "string") {
      errors.push(`setting ${key} must be a string`);
    } else if (INTEGER_SETTINGS.has(key) && !/^\d+$/.test(value)) {
      errors.push(`setting ${key} must be a non-negative integer string`);
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
