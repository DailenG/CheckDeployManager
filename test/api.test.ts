import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { DEFAULT_INSTANCE_SETTINGS } from "../src/lib/db";
import { SAMPLE_DELTA, seedUpstream } from "./helpers";
import upstreamFixture from "./fixtures/upstream-snapshot.json";

const fixtureBody = JSON.stringify(upstreamFixture);
const BASE = "https://check.example.test";
const DEV_OPERATOR = "operator@example.test";

// Calls the worker with the dev bypass active so requests carry an operator
// identity. Production fail-closed behavior is covered separately via SELF.
async function api(path: string, init?: RequestInit): Promise<Response> {
  const devEnv: Env = {
    ...env,
    ENVIRONMENT: "development",
    DEV_OPERATOR_EMAIL: DEV_OPERATOR,
  };
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, init),
    devEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function createTenantViaApi(name = "Harborview Physical Therapy") {
  const response = await api("/api/tenants", jsonInit("POST", { name }));
  expect(response.status).toBe(201);
  return response.json<any>();
}

describe("auth boundary", () => {
  it("rejects /api requests in production when Access is unconfigured", async () => {
    const response = await SELF.fetch(`${BASE}/api/tenants`);
    expect(response.status).toBe(403);
  });
});

describe("tenants CRUD", () => {
  it("creates a tenant with GUID, preview token, defaults, and audit row", async () => {
    const created = await createTenantViaApi();
    expect(created.guid).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.preview_token).toMatch(/^[0-9a-f]{32}$/);

    const delta = await env.DB.prepare(
      "SELECT draft_json FROM tenant_rule_deltas WHERE tenant_id = ?",
    )
      .bind(created.id)
      .first<any>();
    expect(delta.draft_json).toBe("{}");

    const audit = await env.DB.prepare(
      "SELECT operator_email FROM audit_log WHERE action = 'tenant.create' AND tenant_id = ?",
    )
      .bind(created.id)
      .first<any>();
    expect(audit.operator_email).toBe(DEV_OPERATOR);
  });

  it("rejects creation without a name", async () => {
    const response = await api("/api/tenants", jsonInit("POST", {}));
    expect(response.status).toBe(400);
  });

  it("lists tenants with health indicators", async () => {
    const created = await createTenantViaApi();
    const response = await api("/api/tenants");
    const body = await response.json<any>();
    const tenant = body.tenants.find((t: any) => t.id === created.id);
    expect(tenant.active_guids).toBe(1);
    expect(tenant.stale).toBe(true);
    expect(tenant.revoked_hits).toBe(0);
  });

  it("returns detail, supports rename, and blocks delete while GUIDs are active", async () => {
    const created = await createTenantViaApi();

    const detail = await api(`/api/tenants/${created.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json<any>();
    expect(detailBody.tenant.name).toBe("Harborview Physical Therapy");
    expect(detailBody.guids.length).toBe(1);

    const rename = await api(
      `/api/tenants/${created.id}`,
      jsonInit("PATCH", { name: "Harborview PT" }),
    );
    expect(rename.status).toBe(200);

    const blocked = await api(`/api/tenants/${created.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);

    await api(`/api/guids/${created.guid}/revoke`, { method: "POST" });
    const deleted = await api(`/api/tenants/${created.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const gone = await api(`/api/tenants/${created.id}`);
    expect(gone.status).toBe(404);
  });
});

describe("draft, publish, rollback, versions", () => {
  it("saves a draft and returns dry-run findings", async () => {
    await seedUpstream(fixtureBody);
    const created = await createTenantViaApi();

    const good = await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: SAMPLE_DELTA }),
    );
    const goodBody = await good.json<any>();
    expect(goodBody.saved).toBe(true);
    expect(goodBody.valid).toBe(true);
    expect(goodBody.findings).toEqual([]);

    const bad = await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: { add_exclusion_domain_patterns: ["([bad"] } }),
    );
    const badBody = await bad.json<any>();
    expect(badBody.saved).toBe(true);
    expect(badBody.valid).toBe(false);
    expect(badBody.findings.length).toBeGreaterThan(0);
  });

  it("publishes the draft and serves it on the rules endpoint", async () => {
    await seedUpstream(fixtureBody);
    const created = await createTenantViaApi();
    await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: SAMPLE_DELTA }),
    );
    const publish = await api(`/api/tenants/${created.id}/publish`, {
      method: "POST",
    });
    expect(publish.status).toBe(200);
    const publishBody = await publish.json<any>();
    expect(publishBody.versionNumber).toBe(1);

    const rules = await SELF.fetch(`${BASE}/rules/${created.guid}.json`);
    expect(rules.status).toBe(200);
    const ruleset = await rules.json<any>();
    expect(ruleset.version).toBe("1.2.3+cdm.1");
  });

  it("blocks publish when the draft fails the gates", async () => {
    await seedUpstream(fixtureBody);
    const created = await createTenantViaApi();
    await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: { add_trusted_login_patterns: ["([bad"] } }),
    );
    const publish = await api(`/api/tenants/${created.id}/publish`, {
      method: "POST",
    });
    expect(publish.status).toBe(422);
    const body = await publish.json<any>();
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it("rolls back to a prior version and the endpoint ETag reverts", async () => {
    await seedUpstream(fixtureBody);
    const created = await createTenantViaApi();

    await api(`/api/tenants/${created.id}/rules`, jsonInit("PUT", { delta: {} }));
    await api(`/api/tenants/${created.id}/publish`, { method: "POST" });
    const firstEtag = (
      await SELF.fetch(`${BASE}/rules/${created.guid}.json`)
    ).headers.get("ETag");

    await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: SAMPLE_DELTA }),
    );
    await api(`/api/tenants/${created.id}/publish`, { method: "POST" });
    const secondEtag = (
      await SELF.fetch(`${BASE}/rules/${created.guid}.json`)
    ).headers.get("ETag");
    expect(secondEtag).not.toBe(firstEtag);

    const versions = await api(`/api/tenants/${created.id}/versions`);
    const versionsBody = await versions.json<any>();
    expect(versionsBody.versions.length).toBe(2);
    const firstVersion = versionsBody.versions.find(
      (v: any) => v.version_number === 1,
    );

    const rollback = await api(
      `/api/tenants/${created.id}/rollback/${firstVersion.id}`,
      { method: "POST" },
    );
    expect(rollback.status).toBe(200);
    const reverted = (
      await SELF.fetch(`${BASE}/rules/${created.guid}.json`)
    ).headers.get("ETag");
    expect(reverted).toBe(firstEtag);
  });

  it("rejects rollback to another tenant's version", async () => {
    await seedUpstream(fixtureBody);
    const first = await createTenantViaApi("Tenant One");
    const second = await createTenantViaApi("Tenant Two");
    await api(`/api/tenants/${first.id}/rules`, jsonInit("PUT", { delta: {} }));
    await api(`/api/tenants/${first.id}/publish`, { method: "POST" });
    const versions = await (
      await api(`/api/tenants/${first.id}/versions`)
    ).json<any>();
    const response = await api(
      `/api/tenants/${second.id}/rollback/${versions.versions[0].id}`,
      { method: "POST" },
    );
    expect(response.status).toBe(404);
  });
});

describe("branding", () => {
  it("updates text fields via JSON", async () => {
    const created = await createTenantViaApi();
    const response = await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", {
        company_name: "WideData Corporation",
        product_name: "WideData Phishing Protection",
        primary_color: "#1B6FA8",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.branding.company_name).toBe("WideData Corporation");
  });

  it("accepts a valid logo upload and serves it publicly", async () => {
    const created = await createTenantViaApi();
    const form = new FormData();
    form.set("company_name", "WideData Corporation");
    form.set(
      "logo",
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "logo.png", {
        type: "image/png",
      }),
    );
    const response = await api(`/api/tenants/${created.id}/branding`, {
      method: "PUT",
      body: form,
    });
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.branding.logo_r2_key).toBe(`assets/${created.id}/logo.png`);

    const logo = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("Content-Type")).toBe("image/png");
  });

  it("rejects oversized and wrong-type logos", async () => {
    const created = await createTenantViaApi();

    const bigForm = new FormData();
    bigForm.set(
      "logo",
      new File([new Uint8Array(512 * 1024 + 1)], "logo.png", { type: "image/png" }),
    );
    const oversized = await api(`/api/tenants/${created.id}/branding`, {
      method: "PUT",
      body: bigForm,
    });
    expect(oversized.status).toBe(413);

    const gifForm = new FormData();
    gifForm.set(
      "logo",
      new File([new Uint8Array([71, 73, 70])], "logo.gif", { type: "image/gif" }),
    );
    const wrongType = await api(`/api/tenants/${created.id}/branding`, {
      method: "PUT",
      body: gifForm,
    });
    expect(wrongType.status).toBe(400);
  });
});

describe("policy settings", () => {
  it("stores valid settings and rejects unknown keys", async () => {
    const created = await createTenantViaApi();
    const valid = await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", {
        settings: {
          enablePageBlocking: true,
          updateInterval: 24,
          urlAllowlist: ["https://training.knowbe4.com/*"],
        },
      }),
    );
    expect(valid.status).toBe(200);

    const read = await api(`/api/tenants/${created.id}/policy`);
    const readBody = await read.json<any>();
    expect(readBody.settings.updateInterval).toBe(24);

    const invalid = await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", { settings: { enableTimeTravel: true } }),
    );
    expect(invalid.status).toBe(422);

    const wrongType = await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", { settings: { enablePageBlocking: "yes" } }),
    );
    expect(wrongType.status).toBe(422);
  });
});

describe("GUID lifecycle", () => {
  it("rotates, keeps both active, revokes, and counts revoked hits", async () => {
    await seedUpstream(fixtureBody);
    const created = await createTenantViaApi();
    await api(`/api/tenants/${created.id}/rules`, jsonInit("PUT", { delta: {} }));
    await api(`/api/tenants/${created.id}/publish`, { method: "POST" });

    const rotate = await api(
      `/api/tenants/${created.id}/guids`,
      jsonInit("POST", { label: "pre-rotation 2026-07" }),
    );
    expect(rotate.status).toBe(201);
    const { guid: newGuid } = await rotate.json<any>();

    const oldServes = await SELF.fetch(`${BASE}/rules/${created.guid}.json`);
    const newServes = await SELF.fetch(`${BASE}/rules/${newGuid}.json`);
    expect(oldServes.status).toBe(200);
    expect(newServes.status).toBe(200);

    const revoke = await api(`/api/guids/${created.guid}/revoke`, {
      method: "POST",
    });
    expect(revoke.status).toBe(200);

    const revoked = await SELF.fetch(`${BASE}/rules/${created.guid}.json`);
    expect(revoked.status).toBe(404);
    const hits = await env.DB.prepare(
      "SELECT hits FROM revoked_guid_hits WHERE guid = ?",
    )
      .bind(created.guid)
      .first<any>();
    expect(hits.hits).toBe(1);

    const again = await api(`/api/guids/${created.guid}/revoke`, {
      method: "POST",
    });
    expect(again.status).toBe(409);

    const unknown = await api(
      "/api/guids/00000000-0000-4000-8000-000000000000/revoke",
      { method: "POST" },
    );
    expect(unknown.status).toBe(404);

    const list = await api(`/api/tenants/${created.id}/guids`);
    const listBody = await list.json<any>();
    expect(listBody.guids.length).toBe(2);
    const revokedRow = listBody.guids.find((g: any) => g.guid === created.guid);
    expect(revokedRow.status).toBe("revoked");
    expect(revokedRow.revoked_hits).toBe(1);
  });
});

describe("instance settings", () => {
  it("returns seeded defaults and applies updates", async () => {
    const read = await api("/api/instance/settings");
    const readBody = await read.json<any>();
    expect(readBody.settings.metrics_retention_days).toBe(
      DEFAULT_INSTANCE_SETTINGS.metrics_retention_days,
    );

    const update = await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: {
          public_base_url: "https://check.example.test",
          stale_fetch_hours: "24",
        },
      }),
    );
    expect(update.status).toBe(200);
    const updated = await update.json<any>();
    expect(updated.settings.public_base_url).toBe("https://check.example.test");

    const unknown = await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { favorite_color: "blue" } }),
    );
    expect(unknown.status).toBe(422);

    const badInt = await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { stale_fetch_hours: "soon" } }),
    );
    expect(badInt.status).toBe(422);
  });
});

describe("upstream status", () => {
  it("reports the active snapshot and history", async () => {
    await seedUpstream(fixtureBody);
    const response = await api("/api/upstream");
    const body = await response.json<any>();
    expect(body.active.status).toBe("active");
    expect(body.snapshots.length).toBe(1);
    expect(body.last_sync).not.toBeNull();
  });
});

describe("webhook inbox", () => {
  it("lists, filters, and dispositions events", async () => {
    const created = await createTenantViaApi();
    await SELF.fetch(`${BASE}/hook/${created.guid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportType: "false_positive_report", url: "https://x" }),
    });

    const list = await api("/api/events?status=new");
    const listBody = await list.json<any>();
    expect(listBody.events.length).toBe(1);
    const event = listBody.events[0];
    expect(event.tenant_name).toBe("Harborview Physical Therapy");

    const patch = await api(
      "/api/events",
      jsonInit("PATCH", { id: event.id, status: "reviewed" }),
    );
    expect(patch.status).toBe(200);

    const afterFilter = await api("/api/events?status=new");
    expect((await afterFilter.json<any>()).events.length).toBe(0);

    const badStatus = await api(
      "/api/events",
      jsonInit("PATCH", { id: event.id, status: "archived" }),
    );
    expect(badStatus.status).toBe(400);
  });
});

describe("audit query", () => {
  it("filters by action and tenant", async () => {
    const created = await createTenantViaApi();
    await api(`/api/tenants/${created.id}`, jsonInit("PATCH", { name: "Renamed" }));

    const byAction = await api("/api/audit?action=tenant.update");
    const byActionBody = await byAction.json<any>();
    expect(byActionBody.entries.length).toBe(1);
    expect(byActionBody.entries[0].tenant_id).toBe(created.id);

    const byTenant = await api(`/api/audit?tenant_id=${created.id}`);
    const byTenantBody = await byTenant.json<any>();
    expect(byTenantBody.entries.length).toBe(2);
  });
});
