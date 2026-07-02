// Webhook receiver (design 3.1). Payloads are stored verbatim and treated
// as hostile: never interpreted, always HTML-escaped when rendered.
import { Hono } from "hono";
import type { Env } from "../types";
import { getActiveGuid, newId, nowIso } from "../lib/db";

export const MAX_HOOK_BYTES = 256 * 1024;

export const hookRoutes = new Hono<{ Bindings: Env }>();

hookRoutes.post("/hook/:guid", async (c) => {
  const guidRow = await getActiveGuid(c.env.DB, c.req.param("guid"));
  if (guidRow === null) return new Response(null, { status: 404 });

  const contentType = c.req.header("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }

  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (declaredLength > MAX_HOOK_BYTES) {
    return c.json({ error: "body exceeds 256 KB" }, 413);
  }
  const body = await c.req.text();
  if (new TextEncoder().encode(body).length > MAX_HOOK_BYTES) {
    return c.json({ error: "body exceeds 256 KB" }, 413);
  }

  let eventType = "unknown";
  try {
    const payload = JSON.parse(body);
    if (payload !== null && typeof payload === "object") {
      const candidate =
        (payload as Record<string, unknown>).reportType ??
        (payload as Record<string, unknown>).event;
      if (typeof candidate === "string" && candidate.length > 0) {
        eventType = candidate;
      }
    }
  } catch {
    return c.json({ error: "body is not valid JSON" }, 400);
  }

  await c.env.DB.prepare(
    "INSERT INTO webhook_events (id, tenant_id, guid, received_at, event_type, payload_json) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), guidRow.tenant_id, guidRow.guid, nowIso(), eventType, body)
    .run();

  return c.json({ received: true });
});
