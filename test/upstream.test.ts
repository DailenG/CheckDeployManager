import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pruneSnapshots, syncUpstream } from "../src/lib/upstream";
import { publishTenant } from "../src/lib/publish";
import {
  createTenant,
  fetcherFailing,
  fetcherReturning,
  SAMPLE_DELTA,
  seedUpstream,
} from "./helpers";
import upstreamFixture from "./fixtures/upstream-snapshot.json";
import driftFixture from "./fixtures/upstream-drift.json";

const fixtureBody = JSON.stringify(upstreamFixture);
const driftBody = JSON.stringify(driftFixture);

describe("syncUpstream", () => {
  it("stores the first snapshot as active", async () => {
    const outcome = await seedUpstream(fixtureBody);
    expect(outcome.status).toBe("updated");
    expect(outcome.diffSummary).toContain("initial snapshot");

    const row = await env.DB.prepare(
      "SELECT * FROM upstream_snapshots WHERE id = ?",
    )
      .bind(outcome.snapshotId)
      .first<any>();
    expect(row.status).toBe("active");
    expect(row.upstream_version).toBe((upstreamFixture as any).version);

    const object = await env.STORAGE.get(row.r2_key);
    expect(object).not.toBeNull();
    expect(await object!.text()).toBe(fixtureBody);
  });

  it("reports unchanged when the hash matches", async () => {
    await seedUpstream(fixtureBody);
    const outcome = await seedUpstream(fixtureBody);
    expect(outcome.status).toBe("unchanged");
    const { results } = await env.DB.prepare(
      "SELECT id FROM upstream_snapshots",
    ).all();
    expect(results.length).toBe(1);
  });

  it("supersedes the previous snapshot on change and summarizes the diff", async () => {
    const first = await seedUpstream(fixtureBody);
    const second = await seedUpstream(driftBody);
    expect(second.status).toBe("updated");
    expect(second.diffSummary).toContain("version 1.2.3 -> 9.9.9");
    expect(second.diffSummary).toContain("new sections");

    const firstRow = await env.DB.prepare(
      "SELECT status FROM upstream_snapshots WHERE id = ?",
    )
      .bind(first.snapshotId)
      .first<any>();
    expect(firstRow.status).toBe("superseded");
  });

  it("keeps the prior snapshot active when validation fails", async () => {
    const good = await seedUpstream(fixtureBody);
    const bad = JSON.stringify({ version: "6.6.6" });
    const outcome = await seedUpstream(bad);
    expect(outcome.status).toBe("failed_validation");
    expect(outcome.errors!.length).toBeGreaterThan(0);

    const activeRow = await env.DB.prepare(
      "SELECT id FROM upstream_snapshots WHERE status = 'active'",
    ).first<any>();
    expect(activeRow.id).toBe(good.snapshotId);

    const failedRow = await env.DB.prepare(
      "SELECT status, diff_summary FROM upstream_snapshots WHERE id = ?",
    )
      .bind(outcome.snapshotId)
      .first<any>();
    expect(failedRow.status).toBe("failed_validation");
    expect(failedRow.diff_summary).toContain("validation failed");
  });

  it("returns fetch_error without touching snapshots when the fetch fails", async () => {
    await seedUpstream(fixtureBody);
    const network = await syncUpstream(env, "test", fetcherFailing());
    expect(network.status).toBe("fetch_error");
    const http = await syncUpstream(env, "test", fetcherReturning("nope", 500));
    expect(http.status).toBe("fetch_error");
    const { results } = await env.DB.prepare(
      "SELECT id FROM upstream_snapshots",
    ).all();
    expect(results.length).toBe(1);
  });

  it("auto-republishes tenants with a published version using the frozen delta", async () => {
    await seedUpstream(fixtureBody);
    const { tenantId } = await createTenant();
    const published = await publishTenant(
      env,
      tenantId,
      JSON.stringify(SAMPLE_DELTA),
      "operator@example.test",
    );
    expect(published.ok).toBe(true);

    const outcome = await seedUpstream(driftBody);
    expect(outcome.status).toBe("updated");
    expect(outcome.republished).toBe(1);
    expect(outcome.republishFailures).toEqual([]);

    const version = await env.DB.prepare(
      "SELECT v.* FROM ruleset_versions v JOIN tenants t ON t.current_version_id = v.id " +
        "WHERE t.id = ?",
    )
      .bind(tenantId)
      .first<any>();
    expect(version.version_number).toBe(2);
    expect(version.created_by).toBe("cron");

    // The republished artifact is merged against the new snapshot and still
    // carries the tenant delta.
    const object = await env.STORAGE.get(version.r2_key);
    const merged = JSON.parse(await object!.text());
    expect(merged.version).toBe("9.9.9+cdm.2");
    const ids = merged.phishing_indicators.map((i: any) => i.id);
    expect(ids).not.toContain("phi_004");
  });

  it("skips tenants with no published version", async () => {
    await seedUpstream(fixtureBody);
    await createTenant();
    const outcome = await seedUpstream(driftBody);
    expect(outcome.status).toBe("updated");
    expect(outcome.republished).toBe(0);
  });
});

describe("pruneSnapshots", () => {
  it("keeps the newest N snapshots and deletes older R2 objects", async () => {
    const bodies = [fixtureBody, driftBody, JSON.stringify({ ...driftFixture, version: "10.0.0" })];
    const outcomes = [];
    for (const body of bodies) outcomes.push(await seedUpstream(body));

    const removed = await pruneSnapshots(env, 2);
    expect(removed).toBe(1);

    const { results } = await env.DB.prepare(
      "SELECT id FROM upstream_snapshots",
    ).all<any>();
    expect(results.length).toBe(2);
    expect(results.map((r: any) => r.id)).not.toContain(outcomes[0].snapshotId);

    const oldRow = outcomes[0];
    const object = await env.STORAGE.get(
      `upstream/${String(oldRow.snapshotId)}`,
    );
    expect(object).toBeNull();
  });

  it("never deletes the active snapshot even when keep is zero", async () => {
    await seedUpstream(fixtureBody);
    const removed = await pruneSnapshots(env, 0);
    expect(removed).toBe(0);
    const active = await env.DB.prepare(
      "SELECT id FROM upstream_snapshots WHERE status = 'active'",
    ).first();
    expect(active).not.toBeNull();
  });
});
