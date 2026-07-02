import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { getActiveSnapshot } from "../../lib/db";
import { syncUpstream } from "../../lib/upstream";

export const upstreamRoutes = new Hono<AppEnv>();

upstreamRoutes.get("/", async (c) => {
  const active = await getActiveSnapshot(c.env.DB);
  const { results: snapshots } = await c.env.DB.prepare(
    "SELECT id, fetched_at, upstream_version, hash, status, diff_summary " +
      "FROM upstream_snapshots ORDER BY fetched_at DESC LIMIT 25",
  ).all();
  const lastSync = await c.env.DB.prepare(
    "SELECT ts, operator_email, details_json FROM audit_log " +
      "WHERE action = 'upstream.sync' ORDER BY ts DESC LIMIT 1",
  ).first();
  return c.json({ active, snapshots, last_sync: lastSync });
});

// Force a sync now. The outcome is audited inside syncUpstream.
upstreamRoutes.post("/", async (c) => {
  const outcome = await syncUpstream(c.env, c.get("operatorEmail"));
  const status = outcome.status === "fetch_error" ? 502 : 200;
  return c.json(outcome, status);
});
