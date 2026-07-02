import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import {
  DEFAULT_INSTANCE_SETTINGS,
  getInstanceSettings,
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
