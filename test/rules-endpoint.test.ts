import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { publishTenant } from "../src/lib/publish";
import { nowIso } from "../src/lib/db";
import { createTenant, SAMPLE_DELTA, SAMPLE_GUID, seedUpstream } from "./helpers";
import upstreamFixture from "./fixtures/upstream-snapshot.json";

const fixtureBody = JSON.stringify(upstreamFixture);
const BASE = "https://check.example.test";

describe("/rules/{guid}.json", () => {
  let tenantId: string;

  beforeEach(async () => {
    await seedUpstream(fixtureBody);
    const tenant = await createTenant({ guid: SAMPLE_GUID });
    tenantId = tenant.tenantId;
    const published = await publishTenant(
      env,
      tenantId,
      JSON.stringify(SAMPLE_DELTA),
      "operator@example.test",
    );
    expect(published.ok).toBe(true);
  });

  it("serves the published artifact with the exact header contract", async () => {
    const response = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("ETag")).toMatch(/^"sha256-[0-9a-f]{12}"$/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const ruleset = await response.json<any>();
    expect(ruleset.version).toBe("1.2.3+cdm.1");
    const ids = ruleset.phishing_indicators.map((i: any) => i.id);
    expect(ids).not.toContain("phi_004");
    const patterns = ruleset.exclusion_system.domain_patterns as string[];
    expect(patterns).toContain("^https://[^/]*\\.harborviewpt\\.com(/.*)?$");
  });

  it("returns 304 on a matching If-None-Match and counts it separately", async () => {
    const first = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`);
    const etag = first.headers.get("ETag")!;

    const second = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`, {
      headers: { "If-None-Match": etag },
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("ETag")).toBe(etag);

    const metrics = await env.DB.prepare(
      "SELECT hits, not_modified FROM fetch_metrics WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .first<any>();
    expect(metrics.hits).toBe(1);
    expect(metrics.not_modified).toBe(1);
  });

  it("supports HEAD with the same headers and no body", async () => {
    const response = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`, {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toMatch(/^"sha256-[0-9a-f]{12}"$/);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await response.text()).toBe("");
  });

  it("answers OPTIONS preflight", async () => {
    const response = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
  });

  it("returns a uniform bare 404 for unknown, malformed, and revoked GUIDs", async () => {
    const unknown = await SELF.fetch(
      `${BASE}/rules/00000000-0000-4000-8000-000000000000.json`,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("");

    const malformed = await SELF.fetch(`${BASE}/rules/not-a-guid`);
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toBe("");

    await env.DB.prepare(
      "UPDATE tenant_guids SET status = 'revoked', revoked_at = ? WHERE guid = ?",
    )
      .bind(nowIso(), SAMPLE_GUID)
      .run();
    const revoked = await SELF.fetch(`${BASE}/rules/${SAMPLE_GUID}.json`);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe("");

    const hits = await env.DB.prepare(
      "SELECT hits FROM revoked_guid_hits WHERE guid = ?",
    )
      .bind(SAMPLE_GUID)
      .first<any>();
    expect(hits.hits).toBe(1);
  });

  it("returns 404 for a tenant with no published version", async () => {
    const bare = await createTenant();
    const response = await SELF.fetch(`${BASE}/rules/${bare.guid}.json`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("/preview/{token}.json", () => {
  it("serves the draft merged live with no-store", async () => {
    await seedUpstream(fixtureBody);
    const { tenantId, previewToken } = await createTenant();
    await env.DB.prepare(
      "UPDATE tenant_rule_deltas SET draft_json = ? WHERE tenant_id = ?",
    )
      .bind(JSON.stringify(SAMPLE_DELTA), tenantId)
      .run();

    const response = await SELF.fetch(`${BASE}/preview/${previewToken}.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const ruleset = await response.json<any>();
    expect(ruleset.version).toBe("1.2.3+cdm.1");
    const ids = ruleset.phishing_indicators.map((i: any) => i.id);
    expect(ids).not.toContain("phi_004");
  });

  it("returns a bare 404 for an unknown token", async () => {
    await seedUpstream(fixtureBody);
    const response = await SELF.fetch(`${BASE}/preview/deadbeef.json`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("returns validation findings for a broken draft", async () => {
    await seedUpstream(fixtureBody);
    const { tenantId, previewToken } = await createTenant();
    await env.DB.prepare(
      "UPDATE tenant_rule_deltas SET draft_json = ? WHERE tenant_id = ?",
    )
      .bind(JSON.stringify({ add_exclusion_domain_patterns: ["([bad"] }), tenantId)
      .run();
    const response = await SELF.fetch(`${BASE}/preview/${previewToken}.json`);
    expect(response.status).toBe(422);
    const body = await response.json<any>();
    expect(body.errors.length).toBeGreaterThan(0);
  });
});

describe("/assets/{guid}/logo", () => {
  it("serves the logo with cache and content type headers", async () => {
    const { tenantId, guid } = await createTenant();
    const logoKey = `assets/${tenantId}/logo.png`;
    await env.STORAGE.put(logoKey, new Uint8Array([137, 80, 78, 71]));
    await env.DB.prepare(
      "UPDATE tenant_branding SET logo_r2_key = ?, logo_content_type = 'image/png' " +
        "WHERE tenant_id = ?",
    )
      .bind(logoKey, tenantId)
      .run();

    const response = await SELF.fetch(`${BASE}/assets/${guid}/logo`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
  });

  it("returns bare 404 when there is no logo or the GUID is revoked", async () => {
    const { tenantId, guid } = await createTenant();
    const missing = await SELF.fetch(`${BASE}/assets/${guid}/logo`);
    expect(missing.status).toBe(404);

    await env.DB.prepare(
      "UPDATE tenant_guids SET status = 'revoked' WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .run();
    const revoked = await SELF.fetch(`${BASE}/assets/${guid}/logo`);
    expect(revoked.status).toBe(404);
    expect(await revoked.text()).toBe("");
  });
});

describe("/hook/{guid}", () => {
  const falsePositivePayload = {
    reportType: "false_positive_report",
    url: "https://portal.harborviewpt.com/login",
    reason: "Legitimate patient portal flagged during onboarding",
    timestamp: "2026-07-01T12:00:00.000Z",
  };

  it("stores a false positive report and acknowledges it", async () => {
    const { tenantId, guid } = await createTenant();
    const response = await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(falsePositivePayload),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    const row = await env.DB.prepare(
      "SELECT * FROM webhook_events WHERE tenant_id = ?",
    )
      .bind(tenantId)
      .first<any>();
    expect(row.event_type).toBe("false_positive_report");
    expect(row.status).toBe("new");
    expect(JSON.parse(row.payload_json)).toEqual(falsePositivePayload);
  });

  it("falls back to the event field and then to unknown", async () => {
    const { guid } = await createTenant();
    await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "page_blocked" }),
    });
    await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ something: "else" }),
    });
    const { results } = await env.DB.prepare(
      "SELECT event_type FROM webhook_events ORDER BY received_at",
    ).all<any>();
    expect(results.map((r: any) => r.event_type)).toEqual([
      "page_blocked",
      "unknown",
    ]);
  });

  it("enforces content type, size cap, JSON body, and GUID checks", async () => {
    const { guid } = await createTenant();

    const wrongType = await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(wrongType.status).toBe(415);

    const oversized = await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(256 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const notJson = await SELF.fetch(`${BASE}/hook/${guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);

    const unknownGuid = await SELF.fetch(
      `${BASE}/hook/00000000-0000-4000-8000-000000000000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(unknownGuid.status).toBe(404);

    const { results } = await env.DB.prepare(
      "SELECT id FROM webhook_events",
    ).all();
    expect(results.length).toBe(0);
  });
});
