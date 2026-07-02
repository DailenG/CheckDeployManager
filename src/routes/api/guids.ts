import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { newId, nowIso } from "../../lib/db";
import { writeAudit } from "../../lib/audit";
import { readJsonBody, requireTenant } from "./util";

export const guidsRoutes = new Hono<AppEnv>();

guidsRoutes.get("/:id/guids", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT g.guid, g.status, g.label, g.created_at, g.revoked_at, " +
      "(SELECT COALESCE(SUM(m.hits + m.not_modified), 0) FROM fetch_metrics m WHERE m.guid = g.guid) AS fetch_hits, " +
      "(SELECT MAX(m.last_fetch_at) FROM fetch_metrics m WHERE m.guid = g.guid) AS last_fetch_at, " +
      "(SELECT COALESCE(SUM(r.hits), 0) FROM revoked_guid_hits r WHERE r.guid = g.guid) AS revoked_hits " +
      "FROM tenant_guids g WHERE g.tenant_id = ? ORDER BY g.created_at",
  )
    .bind(tenant.id)
    .all();
  return c.json({ guids: results });
});

// Rotation mints a new active GUID. The old GUID stays active until it is
// explicitly revoked, so client policies can migrate gradually.
guidsRoutes.post("/:id/guids", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const body = await readJsonBody(c);
  const label = typeof body?.label === "string" ? body.label : null;

  const guid = newId();
  await c.env.DB.prepare(
    "INSERT INTO tenant_guids (guid, tenant_id, label, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(guid, tenant.id, label, nowIso())
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "guid.rotate", tenant.id, {
    guid,
    label,
  });
  return c.json({ guid }, 201);
});

export const guidRevokeRoutes = new Hono<AppEnv>();

guidRevokeRoutes.post("/:guid/revoke", async (c) => {
  const guid = c.req.param("guid");
  const row = await c.env.DB.prepare(
    "SELECT tenant_id, status FROM tenant_guids WHERE guid = ?",
  )
    .bind(guid)
    .first<{ tenant_id: string; status: string }>();
  if (row === null) return c.json({ error: "guid not found" }, 404);
  if (row.status === "revoked") return c.json({ error: "guid already revoked" }, 409);

  await c.env.DB.prepare(
    "UPDATE tenant_guids SET status = 'revoked', revoked_at = ? WHERE guid = ?",
  )
    .bind(nowIso(), guid)
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "guid.revoke", row.tenant_id, {
    guid,
  });
  return c.json({ ok: true });
});
