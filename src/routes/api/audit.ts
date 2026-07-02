import { Hono } from "hono";
import type { AppEnv } from "../../middleware";

export const auditRoutes = new Hono<AppEnv>();

auditRoutes.get("/", async (c) => {
  const tenantId = c.req.query("tenant_id");
  const operator = c.req.query("operator");
  const action = c.req.query("action");
  const before = c.req.query("before");
  const limit = Math.min(Number(c.req.query("limit") ?? "100") || 100, 500);

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (tenantId !== undefined) {
    conditions.push("tenant_id = ?");
    bindings.push(tenantId);
  }
  if (operator !== undefined) {
    conditions.push("operator_email = ?");
    bindings.push(operator);
  }
  if (action !== undefined) {
    conditions.push("action = ?");
    bindings.push(action);
  }
  if (before !== undefined) {
    conditions.push("ts < ?");
    bindings.push(before);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await c.env.DB.prepare(
    `SELECT id, ts, operator_email, action, tenant_id, details_json FROM audit_log ${where} ` +
      "ORDER BY ts DESC LIMIT ?",
  )
    .bind(...bindings, limit)
    .all();
  return c.json({ entries: results });
});
