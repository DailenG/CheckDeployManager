import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { writeAudit } from "../../lib/audit";
import { readJsonBody } from "./util";

const DISPOSITIONS = new Set(["new", "reviewed", "dismissed"]);

export const eventsRoutes = new Hono<AppEnv>();

// Webhook inbox. Payloads stay untrusted strings end to end; the dashboard
// HTML-escapes them on render.
eventsRoutes.get("/", async (c) => {
  const status = c.req.query("status");
  const tenantId = c.req.query("tenant_id");
  const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500);

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (status !== undefined && DISPOSITIONS.has(status)) {
    conditions.push("e.status = ?");
    bindings.push(status);
  }
  if (tenantId !== undefined) {
    conditions.push("e.tenant_id = ?");
    bindings.push(tenantId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await c.env.DB.prepare(
    "SELECT e.id, e.tenant_id, t.name AS tenant_name, e.guid, e.received_at, " +
      "e.event_type, e.payload_json, e.status " +
      `FROM webhook_events e LEFT JOIN tenants t ON t.id = e.tenant_id ${where} ` +
      "ORDER BY e.received_at DESC LIMIT ?",
  )
    .bind(...bindings, limit)
    .all();
  return c.json({ events: results });
});

eventsRoutes.patch("/", async (c) => {
  const body = await readJsonBody(c);
  const id = typeof body?.id === "string" ? body.id : null;
  const status = typeof body?.status === "string" ? body.status : null;
  if (id === null || status === null || !DISPOSITIONS.has(status)) {
    return c.json(
      { error: "body must include id and a status of new, reviewed, or dismissed" },
      400,
    );
  }
  const row = await c.env.DB.prepare(
    "SELECT tenant_id FROM webhook_events WHERE id = ?",
  )
    .bind(id)
    .first<{ tenant_id: string }>();
  if (row === null) return c.json({ error: "event not found" }, 404);

  await c.env.DB.prepare("UPDATE webhook_events SET status = ? WHERE id = ?")
    .bind(status, id)
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "events.disposition", row.tenant_id, {
    id,
    status,
  });
  return c.json({ ok: true });
});
