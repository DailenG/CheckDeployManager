import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { runRetentionCleanup, runScheduledTasks } from "../src/lib/cron";
import { newId, nowIso, putInstanceSetting } from "../src/lib/db";
import { createTenant, fetcherReturning, seedUpstream } from "./helpers";
import upstreamFixture from "./fixtures/upstream-snapshot.json";
import driftFixture from "./fixtures/upstream-drift.json";

const fixtureBody = JSON.stringify(upstreamFixture);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function daysAgoDay(days: number): string {
  return daysAgoIso(days).slice(0, 10);
}

async function seedRetentionRows(tenantId: string, guid: string): Promise<void> {
  await env.DB.batch([
    // Metrics: one ancient, one fresh.
    env.DB.prepare(
      "INSERT INTO fetch_metrics (tenant_id, guid, day, hits, not_modified, last_fetch_at) " +
        "VALUES (?, ?, ?, 5, 1, ?)",
    ).bind(tenantId, guid, daysAgoDay(30), daysAgoIso(30)),
    env.DB.prepare(
      "INSERT INTO fetch_metrics (tenant_id, guid, day, hits, not_modified, last_fetch_at) " +
        "VALUES (?, ?, ?, 2, 0, ?)",
    ).bind(tenantId, guid, daysAgoDay(0), nowIso()),
    env.DB.prepare(
      "INSERT INTO revoked_guid_hits (guid, day, hits) VALUES (?, ?, 3)",
    ).bind(guid, daysAgoDay(30)),
    // Webhook events: expired, dispositioned, and fresh-new.
    env.DB.prepare(
      "INSERT INTO webhook_events (id, tenant_id, guid, received_at, event_type, payload_json, status) " +
        "VALUES (?, ?, ?, ?, 'x', '{}', 'new')",
    ).bind(newId(), tenantId, guid, daysAgoIso(120)),
    env.DB.prepare(
      "INSERT INTO webhook_events (id, tenant_id, guid, received_at, event_type, payload_json, status) " +
        "VALUES (?, ?, ?, ?, 'x', '{}', 'reviewed')",
    ).bind(newId(), tenantId, guid, daysAgoIso(1)),
    env.DB.prepare(
      "INSERT INTO webhook_events (id, tenant_id, guid, received_at, event_type, payload_json, status) " +
        "VALUES (?, ?, ?, ?, 'x', '{}', 'new')",
    ).bind(newId(), tenantId, guid, daysAgoIso(1)),
  ]);
}

describe("runRetentionCleanup", () => {
  it("purges expired metrics, dispositioned and expired events, and old snapshots", async () => {
    const { tenantId, guid } = await createTenant();
    await seedRetentionRows(tenantId, guid);
    await seedUpstream(fixtureBody);
    await seedUpstream(JSON.stringify(driftFixture));
    await putInstanceSetting(env.DB, "upstream_keep_snapshots", "1");

    const summary = await runRetentionCleanup(env);
    expect(summary.metricsDeleted).toBe(1);
    expect(summary.revokedHitsDeleted).toBe(1);
    expect(summary.webhookEventsDeleted).toBe(2);
    expect(summary.snapshotsDeleted).toBe(1);

    const metrics = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM fetch_metrics",
    ).first<any>();
    expect(metrics.count).toBe(1);
    const events = await env.DB.prepare(
      "SELECT status FROM webhook_events",
    ).all<any>();
    expect(events.results.length).toBe(1);
    expect(events.results[0].status).toBe("new");
    const snapshots = await env.DB.prepare(
      "SELECT status FROM upstream_snapshots",
    ).all<any>();
    expect(snapshots.results.length).toBe(1);
    expect(snapshots.results[0].status).toBe("active");
  });
});

describe("runScheduledTasks", () => {
  it("syncs upstream then cleans up, attributing the sync to cron", async () => {
    const { tenantId, guid } = await createTenant();
    await seedRetentionRows(tenantId, guid);

    const { sync, cleanup } = await runScheduledTasks(
      env,
      fetcherReturning(fixtureBody),
    );
    expect(sync.status).toBe("updated");
    expect(cleanup.metricsDeleted).toBe(1);

    const audit = await env.DB.prepare(
      "SELECT operator_email FROM audit_log WHERE action = 'upstream.sync' " +
        "ORDER BY ts DESC LIMIT 1",
    ).first<any>();
    expect(audit.operator_email).toBe("cron");
  });
});

describe("scheduled handler wiring", () => {
  it("runs sync and cleanup from the scheduled entry point", async () => {
    // Point upstream at an unroutable address so the wiring test stays
    // offline; the sync records a fetch_error and cleanup still runs.
    await putInstanceSetting(
      env.DB,
      "upstream_source_url",
      "https://127.0.0.1:1/detection-rules.json",
    );
    const { tenantId, guid } = await createTenant();
    await seedRetentionRows(tenantId, guid);

    const controller = createScheduledController({
      scheduledTime: new Date(),
      cron: "17 6 * * *",
    });
    const ctx = createExecutionContext();
    await worker.scheduled(controller, env, ctx);
    await waitOnExecutionContext(ctx);

    const audit = await env.DB.prepare(
      "SELECT details_json FROM audit_log WHERE action = 'upstream.sync' " +
        "ORDER BY ts DESC LIMIT 1",
    ).first<any>();
    expect(JSON.parse(audit.details_json).status).toBe("fetch_error");

    const metrics = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM fetch_metrics",
    ).first<any>();
    expect(metrics.count).toBe(1);
  });
});
