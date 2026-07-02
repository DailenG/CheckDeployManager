// Daily scheduled work (design 1.3 and build phase 9): upstream sync first,
// then retention cleanup for metrics, webhook events, and old snapshots.
import type { Env } from "../types";
import { getInstanceSettings } from "./db";
import { pruneSnapshots, syncUpstream, type SyncOutcome } from "./upstream";

export interface CleanupSummary {
  metricsDeleted: number;
  revokedHitsDeleted: number;
  webhookEventsDeleted: number;
  snapshotsDeleted: number;
}

export async function runRetentionCleanup(env: Env): Promise<CleanupSummary> {
  const settings = await getInstanceSettings(env.DB);
  const metricsDays = Number(settings.metrics_retention_days) || 7;
  const webhookDays = Number(settings.webhook_retention_days) || 90;
  const keepSnapshots = Number(settings.upstream_keep_snapshots) || 10;

  const metricsCutoffDay = new Date(Date.now() - metricsDays * 86400000)
    .toISOString()
    .slice(0, 10);
  const webhookCutoff = new Date(Date.now() - webhookDays * 86400000).toISOString();

  const metrics = await env.DB.prepare("DELETE FROM fetch_metrics WHERE day < ?")
    .bind(metricsCutoffDay)
    .run();
  const revoked = await env.DB.prepare("DELETE FROM revoked_guid_hits WHERE day < ?")
    .bind(metricsCutoffDay)
    .run();
  // Webhook events go when dispositioned or once past the retention window.
  const events = await env.DB.prepare(
    "DELETE FROM webhook_events WHERE status != 'new' OR received_at < ?",
  )
    .bind(webhookCutoff)
    .run();
  const snapshotsDeleted = await pruneSnapshots(env, keepSnapshots);

  return {
    metricsDeleted: metrics.meta.changes ?? 0,
    revokedHitsDeleted: revoked.meta.changes ?? 0,
    webhookEventsDeleted: events.meta.changes ?? 0,
    snapshotsDeleted,
  };
}

export async function runScheduledTasks(
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<{ sync: SyncOutcome; cleanup: CleanupSummary }> {
  const sync = await syncUpstream(env, "cron", fetcher);
  const cleanup = await runRetentionCleanup(env);
  return { sync, cleanup };
}
