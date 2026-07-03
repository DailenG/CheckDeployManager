import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { buildArtifactBundle } from "../src/lib/artifacts";
import { HARBORVIEW_ARTIFACT_INPUT } from "./harborview-sample";
import managedStorageGolden from "./golden/managed-storage.json";
import firefoxFragmentGolden from "./golden/firefox-fragment.json";
import firefoxFullGolden from "./golden/firefox-policies-full.json";
import cippFieldsGolden from "./golden/cipp-fields.json";
import chromeRegGolden from "./golden/chrome.reg?raw";
import edgeRegGolden from "./golden/edge.reg?raw";
import intuneGolden from "./golden/intune-variables.ps1?raw";

const bundle = buildArtifactBundle(HARBORVIEW_ARTIFACT_INPUT);

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

describe("artifact golden files (Harborview sample)", () => {
  it("renders the Chrome and Edge managed storage payload", () => {
    expect(bundle.chrome_managed_storage).toEqual(managedStorageGolden);
    expect(bundle.edge_managed_storage).toEqual(managedStorageGolden);
  });

  it("renders the Firefox fragment and full policies.json", () => {
    expect(bundle.firefox_fragment).toEqual(firefoxFragmentGolden);
    expect(bundle.firefox_policies_full).toEqual(firefoxFullGolden);
  });

  it("renders the Chrome .reg file", () => {
    expect(normalizeNewlines(bundle.reg_chrome)).toBe(
      normalizeNewlines(chromeRegGolden),
    );
    expect(bundle.reg_chrome).toContain("\r\n");
  });

  it("renders the Edge .reg file with the Edge hive, id, and update URL", () => {
    expect(normalizeNewlines(bundle.reg_edge)).toBe(normalizeNewlines(edgeRegGolden));
    expect(bundle.reg_edge).toContain(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge",
    );
    expect(bundle.reg_edge).toContain("knepjpocdagponkonnbggpcnhnaikajg");
    expect(bundle.reg_edge).toContain(
      "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
    );
    expect(bundle.reg_edge).not.toContain("Google\\Chrome");
  });

  it("renders the Intune variable block", () => {
    expect(normalizeNewlines(bundle.intune_variables)).toBe(
      normalizeNewlines(intuneGolden),
    );
  });

  it("renders the CIPP field table", () => {
    expect(bundle.cipp_fields).toEqual(cippFieldsGolden);
  });
});

describe("artifact guardrails", () => {
  const everything = JSON.stringify(bundle);

  it("contains no em dash anywhere", () => {
    // U+2014 spelled via charCode so this file passes the repo-wide CI grep.
    expect(everything.includes(String.fromCharCode(0x2014))).toBe(false);
  });

  it("keeps PowerShell text free of && and non-ASCII", () => {
    expect(bundle.intune_variables.includes("&&")).toBe(false);
    for (const char of bundle.intune_variables) {
      expect(char.charCodeAt(0)).toBeLessThanOrEqual(126);
    }
  });

  it("keeps .reg output ASCII", () => {
    for (const char of bundle.reg_chrome + bundle.reg_edge) {
      expect(char.charCodeAt(0)).toBeLessThanOrEqual(126);
    }
  });

  it("replaces non-ASCII branding characters in PowerShell text", () => {
    const withNonAscii = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      branding: {
        ...HARBORVIEW_ARTIFACT_INPUT.branding,
        company_name: "Example™ MSP",
      },
    });
    expect(withNonAscii.intune_variables).toContain('"Example? MSP"');
  });
});

describe("CIPP defaults for a fresh install", () => {
  it("emits CIPP off and omits the server URL when none is configured", () => {
    const fresh = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      defaultCippServerUrl: "",
      policySettings: {},
    });
    const payload = fresh.chrome_managed_storage;
    expect(payload.enableCippReporting).toBe(false);
    expect("cippServerUrl" in payload).toBe(false);
    expect("cippTenantId" in payload).toBe(false);
    const cippRow = fresh.cipp_fields.find((f) => f.field === "CIPP Reporting");
    expect(cippRow?.value).toBe("Disabled");
  });

  it("uses the tenant override ahead of the instance default", () => {
    const overridden = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      policySettings: {
        ...HARBORVIEW_ARTIFACT_INPUT.policySettings,
        cippServerUrl: "https://cipp.override.test",
      },
    });
    expect(overridden.chrome_managed_storage.cippServerUrl).toBe(
      "https://cipp.override.test",
    );
  });

  it("warns when CIPP reporting is enabled without a tenant id", () => {
    const missingTenant = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      policySettings: {
        ...HARBORVIEW_ARTIFACT_INPUT.policySettings,
        cippTenantId: "",
      },
    });
    expect(missingTenant.chrome_managed_storage.cippTenantId).toBe("");
    expect(missingTenant.warnings.length).toBe(1);
    expect(missingTenant.warnings[0]).toContain("tenant id");

    // The sample input carries a tenant domain, so no warnings.
    expect(bundle.warnings).toEqual([]);

    // CIPP off entirely: an empty tenant id is not a problem.
    const cippOff = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      defaultCippServerUrl: "",
      policySettings: {},
    });
    expect(cippOff.warnings).toEqual([]);
  });
});

describe("GET /api/tenants/{id}/artifacts", () => {
  async function api(path: string, init?: RequestInit): Promise<Response> {
    const devEnv: Env = { ...env, ENVIRONMENT: "development" };
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`https://check.example.test${path}`, init),
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

  it("refuses until public_base_url is configured", async () => {
    const created = await (
      await api("/api/tenants", jsonInit("POST", { name: "Harborview Physical Therapy" }))
    ).json<any>();
    const blocked = await api(`/api/tenants/${created.id}/artifacts`);
    expect(blocked.status).toBe(409);
  });

  it("renders the full bundle from stored tenant state", async () => {
    await api(
      "/api/instance/settings",
      jsonInit("PUT", {
        settings: {
          public_base_url: "https://check.example.test",
          default_cipp_server_url: "https://cipp.example.test",
        },
      }),
    );
    const created = await (
      await api("/api/tenants", jsonInit("POST", { name: "Harborview Physical Therapy" }))
    ).json<any>();
    await api(
      `/api/tenants/${created.id}/branding`,
      jsonInit("PUT", { company_name: "Example MSP" }),
    );
    await api(
      `/api/tenants/${created.id}/policy`,
      jsonInit("PUT", {
        settings: {
          enableCippReporting: true,
          cippTenantId: "harborviewpt.onmicrosoft.com",
          urlAllowlist: ["https://training.knowbe4.com/*"],
        },
      }),
    );

    const response = await api(`/api/tenants/${created.id}/artifacts`);
    expect(response.status).toBe(200);
    const { artifacts } = await response.json<any>();
    expect(artifacts.guid).toBe(created.guid);
    expect(artifacts.config_url).toBe(
      `https://check.example.test/rules/${created.guid}.json`,
    );
    expect(artifacts.chrome_managed_storage.cippServerUrl).toBe(
      "https://cipp.example.test",
    );
    expect(artifacts.chrome_managed_storage.customBranding.companyName).toBe(
      "Example MSP",
    );
    // No logo uploaded, so logoUrl stays empty.
    expect(artifacts.chrome_managed_storage.customBranding.logoUrl).toBe("");
    expect(artifacts.reg_chrome).toContain(created.guid);
    expect(artifacts.intune_variables).toContain(created.guid);
  });

  it("refuses when the tenant has no active GUID", async () => {
    await api(
      "/api/instance/settings",
      jsonInit("PUT", { settings: { public_base_url: "https://check.example.test" } }),
    );
    const created = await (
      await api("/api/tenants", jsonInit("POST", { name: "Harborview Physical Therapy" }))
    ).json<any>();
    await api(`/api/guids/${created.guid}/revoke`, { method: "POST" });
    const response = await api(`/api/tenants/${created.id}/artifacts`);
    expect(response.status).toBe(409);
  });
});
