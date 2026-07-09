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

describe("GPO export script download", () => {
  it("serves the bundled script to operators and fails closed otherwise", async () => {
    const response = await api("/manage/export-checkgpoconfig.ps1");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("Content-Disposition")).toContain(
      "Export-CheckGpoConfig.ps1",
    );
    const body = await response.text();
    expect(body).toContain("Export-CheckGpoConfig.ps1");
    expect(body).toContain("Import-Module GroupPolicy");

    // Same operator gate as the rest of /manage.
    const anonymous = await SELF.fetch(`${BASE}/manage/export-checkgpoconfig.ps1`);
    expect(anonymous.status).toBe(403);
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
    // The onboarding wizard's verify step reads this.
    expect(detailBody.last_fetch_at).toBeNull();

    await env.DB.prepare(
      "INSERT INTO fetch_metrics (tenant_id, guid, day, hits, not_modified, last_fetch_at) " +
        "VALUES (?, ?, ?, 1, 0, ?)",
    )
      .bind(created.id, created.guid, "2026-07-07", "2026-07-07T12:00:00.000Z")
      .run();
    const fetchedDetail = await (await api(`/api/tenants/${created.id}`)).json<any>();
    expect(fetchedDetail.last_fetch_at).toBe("2026-07-07T12:00:00.000Z");
  });

  it("accepts the full key set the GPO-export import path submits", async () => {
    // The onboarding wizard's adopt-config panel whitelists exactly these
    // keys from Export-CheckGpoConfig.ps1 output; every one must validate.
    const created = await createTenantViaApi();
    const imported = await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", {
        settings: {
          updateInterval: 12,
          enablePageBlocking: true,
          showNotifications: false,
          enableValidPageBadge: true,
          validPageBadgeTimeout: 8,
          enableDebugLogging: false,
          urlAllowlist: ["https://training.knowbe4.com/*"],
          domainSquatting: { enabled: true, deviationThreshold: 2, Action: "block" },
          genericWebhook: { enabled: true, events: ["page_blocked"] },
          enableCippReporting: true,
          cippServerUrl: "https://cipp.example.test",
          cippTenantId: "harborviewpt.onmicrosoft.com",
        },
      }),
    );
    expect(imported.status).toBe(200);

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
        company_name: "Example MSP",
        product_name: "Example MSP Phishing Protection",
        primary_color: "#1B6FA8",
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.branding.company_name).toBe("Example MSP");
  });

  it("accepts a valid logo upload and serves it publicly", async () => {
    const created = await createTenantViaApi();
    const form = new FormData();
    form.set("company_name", "Example MSP");
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

describe("tenant defaults", () => {
  const VALID_DEFAULTS = JSON.stringify({
    branding: { company_name: "Fleet MSP", support_email: "help@fleet.test" },
    policy: { updateInterval: 12 },
  });

  async function putSetting(key: string, value: string): Promise<Response> {
    return api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { [key]: value } }),
    );
  }

  it("accepts a valid tenant_defaults object and clears with empty string", async () => {
    expect((await putSetting("tenant_defaults", VALID_DEFAULTS)).status).toBe(200);
    expect((await putSetting("tenant_defaults", "")).status).toBe(200);
  });

  it("rejects malformed and non-inheritable tenant_defaults", async () => {
    expect((await putSetting("tenant_defaults", "{nope")).status).toBe(422);
    expect((await putSetting("tenant_defaults", '["array"]')).status).toBe(422);
    expect(
      (
        await putSetting(
          "tenant_defaults",
          JSON.stringify({ branding: { tenant_name: "x" } }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await putSetting(
          "tenant_defaults",
          JSON.stringify({ policy: { updateInterval: "12" } }),
        )
      ).status,
    ).toBe(422);

    const neverInherited = await putSetting(
      "tenant_defaults",
      JSON.stringify({ policy: { cippTenantId: "x.onmicrosoft.com" } }),
    );
    expect(neverInherited.status).toBe(422);
    const body = await neverInherited.json<any>();
    expect(body.errors.join(" ")).toContain("never inherited");
  });

  it("rejects direct writes to the default logo settings", async () => {
    expect((await putSetting("default_logo_r2_key", "assets/x/logo.png")).status).toBe(
      422,
    );
    expect((await putSetting("default_logo_content_type", "image/png")).status).toBe(
      422,
    );
  });

  it("exposes defaults on the branding and policy GETs and resolves them in artifacts", async () => {
    await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: {
          public_base_url: BASE,
          tenant_defaults: VALID_DEFAULTS,
        },
      }),
    );
    const created = await createTenantViaApi();

    const brandingBody = await (
      await api(`/api/tenants/${created.id}/branding`)
    ).json<any>();
    expect(brandingBody.defaults.company_name).toBe("Fleet MSP");
    expect(brandingBody.default_logo).toBe(false);

    const policyBody = await (await api(`/api/tenants/${created.id}/policy`)).json<any>();
    expect(policyBody.defaults.updateInterval).toBe(12);

    // A fresh tenant inherits everything.
    let { artifacts } = await (
      await api(`/api/tenants/${created.id}/artifacts`)
    ).json<any>();
    expect(artifacts.chrome_managed_storage.updateInterval).toBe(12);
    expect(artifacts.chrome_managed_storage.customBranding.companyName).toBe(
      "Fleet MSP",
    );
    expect(artifacts.chrome_managed_storage.customBranding.supportEmail).toBe(
      "help@fleet.test",
    );

    // Tenant overrides win; untouched fields keep inheriting.
    await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", { settings: { updateInterval: 6 } }),
    );
    await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { company_name: "Client Brand" }),
    );
    ({ artifacts } = await (
      await api(`/api/tenants/${created.id}/artifacts`)
    ).json<any>());
    expect(artifacts.chrome_managed_storage.updateInterval).toBe(6);
    expect(artifacts.chrome_managed_storage.customBranding.companyName).toBe(
      "Client Brand",
    );
    expect(artifacts.chrome_managed_storage.customBranding.supportEmail).toBe(
      "help@fleet.test",
    );
  });

  it("serves the instance default logo until the tenant uploads its own", async () => {
    await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { public_base_url: BASE } }),
    );
    const form = new FormData();
    form.set(
      "logo",
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "logo.png", {
        type: "image/png",
      }),
    );
    const upload = await api("/api/instance/default-logo", {
      method: "PUT",
      body: form,
    });
    expect(upload.status).toBe(200);

    const created = await createTenantViaApi();
    const inherited = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(inherited.status).toBe(200);
    expect(inherited.headers.get("Content-Type")).toBe("image/png");

    // The artifact bundle points at the live asset URL.
    const { artifacts } = await (
      await api(`/api/tenants/${created.id}/artifacts`)
    ).json<any>();
    expect(artifacts.logo_url).toBe(`${BASE}/assets/${created.guid}/logo`);

    // A tenant upload takes over the same URL.
    const tenantForm = new FormData();
    tenantForm.set(
      "logo",
      new File([new Uint8Array([255, 216, 255])], "logo.jpg", { type: "image/jpeg" }),
    );
    await api(`/api/tenants/${created.id}/branding`, {
      method: "PUT",
      body: tenantForm,
    });
    const own = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(own.headers.get("Content-Type")).toBe("image/jpeg");

    // Removing the default returns tenants without a logo to 404.
    await api("/api/instance/default-logo", { method: "DELETE" });
    const second = await createTenantViaApi("Second Client");
    const gone = await SELF.fetch(`${BASE}/assets/${second.guid}/logo`);
    expect(gone.status).toBe(404);
  });

  it("lets a tenant opt out of the default logo for Check's built-in one", async () => {
    await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { public_base_url: BASE } }),
    );
    const form = new FormData();
    form.set(
      "logo",
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "logo.png", {
        type: "image/png",
      }),
    );
    await api("/api/instance/default-logo", { method: "PUT", body: form });
    const created = await createTenantViaApi();

    // Opting out stops the asset URL and drops it from artifacts, so the
    // extension falls back to its built-in logo.
    const optOut = await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { use_default_logo: true }),
    );
    expect(optOut.status).toBe(200);
    expect((await optOut.json<any>()).branding.use_default_logo).toBe(1);
    const asset = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(asset.status).toBe(404);
    const { artifacts } = await (
      await api(`/api/tenants/${created.id}/artifacts`)
    ).json<any>();
    expect(artifacts.logo_url).toBe("");
    expect(artifacts.chrome_managed_storage.customBranding.logoUrl).toBe("");

    // Uploading a custom logo clears the opt-out.
    const tenantForm = new FormData();
    tenantForm.set(
      "logo",
      new File([new Uint8Array([255, 216, 255])], "logo.jpg", { type: "image/jpeg" }),
    );
    const uploaded = await api(`/api/tenants/${created.id}/branding`, {
      method: "PUT",
      body: tenantForm,
    });
    expect((await uploaded.json<any>()).branding.use_default_logo).toBe(0);

    // Removing the tenant logo returns to inheriting the instance default.
    await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { remove_logo: true }),
    );
    const inherited = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(inherited.status).toBe(200);
    expect(inherited.headers.get("Content-Type")).toBe("image/png");

    // An explicit use_default_logo: false also returns to inheriting.
    await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { use_default_logo: true }),
    );
    await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { use_default_logo: false }),
    );
    const again = await SELF.fetch(`${BASE}/assets/${created.guid}/logo`);
    expect(again.status).toBe(200);
  });

  it("rejects oversized and wrong-type default logos", async () => {
    const bigForm = new FormData();
    bigForm.set(
      "logo",
      new File([new Uint8Array(512 * 1024 + 1)], "logo.png", { type: "image/png" }),
    );
    expect(
      (await api("/api/instance/default-logo", { method: "PUT", body: bigForm })).status,
    ).toBe(413);

    const gifForm = new FormData();
    gifForm.set(
      "logo",
      new File([new Uint8Array([71, 73, 70])], "logo.gif", { type: "image/gif" }),
    );
    expect(
      (await api("/api/instance/default-logo", { method: "PUT", body: gifForm })).status,
    ).toBe(400);
  });
});

describe("baseline rule delta", () => {
  const BASELINE = JSON.stringify({
    add_exclusion_domain_patterns: ["^https://[^/]*\\.rmm-vendor\\.example(/.*)?$"],
    add_phishing_indicators: [
      { id: "msp_001", pattern: "evil\\.example", severity: "high", action: "block" },
    ],
  });

  it("validates baseline_rule_delta on the settings PUT", async () => {
    const ok = await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { baseline_rule_delta: BASELINE } }),
    );
    expect(ok.status).toBe(200);

    const badJson = await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { baseline_rule_delta: "{nope" } }),
    );
    expect(badJson.status).toBe(422);

    const unknownKey = await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: { baseline_rule_delta: JSON.stringify({ add_everything: [] }) },
      }),
    );
    expect(unknownKey.status).toBe(422);
    const body = await unknownKey.json<any>();
    expect(body.errors.join(" ")).toContain("baseline_rule_delta");
  });

  it("applies beneath the tenant delta on publish and preview", async () => {
    await seedUpstream(fixtureBody);
    await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { baseline_rule_delta: BASELINE } }),
    );
    const created = await createTenantViaApi();
    await api(
      `/api/tenants/${created.id}/rules`,
      jsonInit("PUT", { delta: { suppress_indicator_ids: ["msp_001"] } }),
    );
    await api(`/api/tenants/${created.id}/publish`, { method: "POST" });

    const published = await (
      await SELF.fetch(`${BASE}/rules/${created.guid}.json`)
    ).json<any>();
    // Baseline exclusion present; baseline indicator suppressed by tenant.
    expect(published.exclusion_system.domain_patterns).toContain(
      "^https://[^/]*\\.rmm-vendor\\.example(/.*)?$",
    );
    expect(published.phishing_indicators.map((i: any) => i.id)).not.toContain(
      "msp_001",
    );

    // The live preview merges the baseline too.
    const preview = await (
      await SELF.fetch(`${BASE}/preview/${created.preview_token}.json`)
    ).json<any>();
    expect(preview.exclusion_system.domain_patterns).toContain(
      "^https://[^/]*\\.rmm-vendor\\.example(/.*)?$",
    );
  });

  it("republish-all rolls a baseline change out to every published tenant", async () => {
    await seedUpstream(fixtureBody);
    const first = await createTenantViaApi("First Client");
    const second = await createTenantViaApi("Second Client");
    await api(`/api/tenants/${first.id}/publish`, { method: "POST" });
    await api(`/api/tenants/${second.id}/publish`, { method: "POST" });

    await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { baseline_rule_delta: BASELINE } }),
    );
    const republish = await api("/api/instance/republish", { method: "POST" });
    expect(republish.status).toBe(200);
    const outcome = await republish.json<any>();
    expect(outcome.republished).toBe(2);
    expect(outcome.failures).toEqual([]);

    for (const tenant of [first, second]) {
      const rules = await (
        await SELF.fetch(`${BASE}/rules/${tenant.guid}.json`)
      ).json<any>();
      expect(rules.exclusion_system.domain_patterns).toContain(
        "^https://[^/]*\\.rmm-vendor\\.example(/.*)?$",
      );
      expect(rules.phishing_indicators.map((i: any) => i.id)).toContain("msp_001");
    }
  });
});

describe("tenant duplicate", () => {
  it("copies only the rules delta draft into a fresh tenant", async () => {
    const source = await createTenantViaApi();
    await api(
      `/api/tenants/${source.id}/rules`,
      jsonInit("PUT", { delta: SAMPLE_DELTA }),
    );
    await api(
      `/api/tenants/${source.id}/branding`,
      jsonInit("PUT", { company_name: "Source Brand" }),
    );
    await api(
      `/api/tenants/${source.id}/policy`,
      jsonInit("PUT", { settings: { updateInterval: 6 } }),
    );

    const response = await api(
      `/api/tenants/${source.id}/duplicate`,
      jsonInit("POST", { name: "Harborview copy" }),
    );
    expect(response.status).toBe(201);
    const copy = await response.json<any>();
    expect(copy.guid).not.toBe(source.guid);
    expect(copy.preview_token).not.toBe(source.preview_token);

    // The rules draft came along.
    const draft = await (await api(`/api/tenants/${copy.id}/rules`)).json<any>();
    expect(JSON.parse(draft.draft.draft_json)).toEqual(SAMPLE_DELTA);

    // Branding and policy start fresh so they inherit tenant defaults.
    const branding = await (
      await api(`/api/tenants/${copy.id}/branding`)
    ).json<any>();
    expect(branding.branding.company_name).toBe("");
    const policy = await (await api(`/api/tenants/${copy.id}/policy`)).json<any>();
    expect(policy.settings).toEqual({});
  });

  it("requires a name and an existing source tenant", async () => {
    const source = await createTenantViaApi();
    const unnamed = await api(
      `/api/tenants/${source.id}/duplicate`,
      jsonInit("POST", {}),
    );
    expect(unnamed.status).toBe(400);
    const missing = await api(
      "/api/tenants/00000000-0000-4000-8000-000000000000/duplicate",
      jsonInit("POST", { name: "Ghost" }),
    );
    expect(missing.status).toBe(404);
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

describe("instance status", () => {
  it("reports a fresh instance as not onboarded with all checks false", async () => {
    const response = await api("/api/instance/status");
    expect(response.status).toBe(200);
    const body = await response.json<any>();
    expect(body.operator_email).toBe(DEV_OPERATOR);
    expect(body.environment).toBe("development");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.onboarding_complete).toBe(false);
    expect(body.checks).toEqual({
      settings_configured: false,
      upstream_synced: false,
      upstream_version: null,
      upstream_fetched_at: null,
      tenant_count: 0,
      any_published: false,
    });
  });

  it("flips checks as settings, upstream, tenant, and publish land", async () => {
    // First read seeds the onboarding key, mirroring a fresh instance
    // loading the wizard before any configuration happens.
    await api("/api/instance/status");
    await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: { public_base_url: "https://check.example.test" },
      }),
    );
    await seedUpstream(fixtureBody);
    const created = await api(
      "/api/tenants",
      jsonInit("POST", { name: "Harborview Physical Therapy" }),
    );
    const tenant = await created.json<any>();
    const published = await api(`/api/tenants/${tenant.id}/publish`, {
      method: "POST",
    });
    expect(published.status).toBe(200);

    const body = await (await api("/api/instance/status")).json<any>();
    expect(body.checks.settings_configured).toBe(true);
    expect(body.checks.upstream_synced).toBe(true);
    expect(body.checks.upstream_version).not.toBeNull();
    expect(body.checks.upstream_fetched_at).not.toBeNull();
    expect(body.checks.tenant_count).toBe(1);
    expect(body.checks.any_published).toBe(true);
    // Completion stays explicit: every step can be done and the wizard
    // still waits for Finish setup (or Skip) to write the timestamp.
    expect(body.onboarding_complete).toBe(false);
  });

  it("stamps a legacy instance complete on first sighting", async () => {
    // A tenant exists but the onboarding key has never been seeded, so the
    // instance predates the wizard and must not suddenly see setup steps.
    await api(
      "/api/tenants",
      jsonInit("POST", { name: "Harborview Physical Therapy" }),
    );
    await env.DB.prepare(
      "DELETE FROM instance_settings WHERE key = 'onboarding_completed_at'",
    ).run();

    const body = await (await api("/api/instance/status")).json<any>();
    expect(body.onboarding_complete).toBe(true);
    const settings = await (await api("/api/instance/settings")).json<any>();
    expect(settings.settings.onboarding_completed_at).not.toBe("");
  });

  it("accepts onboarding_completed_at through the settings PUT", async () => {
    await api("/api/instance/status");
    const response = await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: { onboarding_completed_at: "2026-07-03T00:00:00.000Z" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await (await api("/api/instance/status")).json<any>();
    expect(body.onboarding_complete).toBe(true);
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
