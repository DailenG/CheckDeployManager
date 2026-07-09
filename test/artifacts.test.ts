import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { buildArtifactBundle } from "../src/lib/artifacts";
import { parseTenantDefaults } from "../src/lib/tenant-defaults";
import { HARBORVIEW_ARTIFACT_INPUT } from "./harborview-sample";
import managedStorageGolden from "./golden/managed-storage.json";
import firefoxFragmentGolden from "./golden/firefox-fragment.json";
import firefoxFullGolden from "./golden/firefox-policies-full.json";
import cippFieldsGolden from "./golden/cipp-fields.json";
import chromeRegGolden from "./golden/chrome.reg?raw";
import edgeRegGolden from "./golden/edge.reg?raw";
import gpoScriptGolden from "./golden/gpo-script.ps1?raw";
import rmmScriptGolden from "./golden/rmm-script.ps1?raw";
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

  it("renders the GPO creation script in sync with the reg files", () => {
    expect(normalizeNewlines(bundle.gpo_script)).toBe(
      normalizeNewlines(gpoScriptGolden),
    );
    // Every registry value in the reg files must appear as a
    // Set-GPRegistryValue write, for both browser hives.
    expect(bundle.gpo_script).toContain(
      "HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionSettings",
    );
    expect(bundle.gpo_script).toContain(
      "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionSettings",
    );
    expect(bundle.gpo_script).toContain("customRulesUrl");
    expect(bundle.gpo_script).toContain("New-GPLink");
    // Rule 4: generated PowerShell never sequences with && or ||.
    expect(bundle.gpo_script).not.toMatch(/&&|\|\|/);
    // 7-bit ASCII only.
    expect([...bundle.gpo_script].every((ch) => ch.charCodeAt(0) <= 126)).toBe(
      true,
    );
  });

  it("renders the CIPP field table", () => {
    expect(bundle.cipp_fields).toEqual(cippFieldsGolden);
  });

  it("pins the extension to the toolbar in every registry artifact", () => {
    // Chrome and Edge spell the same intent differently; Firefox pins via
    // default_area in the full policies.json.
    expect(bundle.reg_chrome).toContain('"toolbar_pin"="force_pinned"');
    expect(bundle.reg_edge).toContain('"toolbar_state"="force_shown"');
    expect(bundle.reg_chrome).not.toContain("toolbar_state");
    expect(bundle.reg_edge).not.toContain("toolbar_pin");
    expect(bundle.gpo_script).toContain("'toolbar_pin'");
    expect(bundle.gpo_script).toContain("'toolbar_state'");
    const firefoxSettings = (
      (bundle.firefox_policies_full as { policies: Record<string, unknown> })
        .policies.ExtensionSettings as Record<string, Record<string, unknown>>
    )["check@cyberdrain.com"];
    expect(firefoxSettings.default_area).toBe("navbar");
  });

  it("renders the RMM deployment script in sync with the reg files", () => {
    expect(normalizeNewlines(bundle.rmm_script)).toBe(
      normalizeNewlines(rmmScriptGolden),
    );
    // The three browser toggles the dashboard checkboxes rewrite.
    expect(bundle.rmm_script).toContain("$IncludeChrome = $true");
    expect(bundle.rmm_script).toContain("$IncludeEdge = $true");
    expect(bundle.rmm_script).toContain("$IncludeFirefox = $true");
    // Registry writes derive from the same table as the reg files.
    expect(bundle.rmm_script).toContain(
      "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionSettings",
    );
    expect(bundle.rmm_script).toContain(
      "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionSettings",
    );
    expect(bundle.rmm_script).toContain("'toolbar_pin'");
    expect(bundle.rmm_script).toContain("'toolbar_state'");
    expect(bundle.rmm_script).toContain("customRulesUrl");
    // The Firefox block embeds the same policies.json the full artifact ships.
    expect(bundle.rmm_script).toContain('"default_area": "navbar"');
    expect(bundle.rmm_script).toContain("policies.json");
    // Rule 4: generated PowerShell never sequences with && or ||.
    expect(bundle.rmm_script).not.toMatch(/&&|\|\|/);
    // 7-bit ASCII only.
    expect([...bundle.rmm_script].every((ch) => ch.charCodeAt(0) <= 126)).toBe(
      true,
    );
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

describe("tenant defaults resolution", () => {
  const DEFAULTS = {
    branding: {
      company_name: "Fleet MSP",
      support_email: "help@fleet.test",
    },
    policy: {
      updateInterval: 12,
      enablePageBlocking: false,
      urlAllowlist: ["https://fleet.test/*"],
    },
  };

  it("resolves policy precedence: tenant beats default beats fallback", () => {
    // Tenant key absent: the instance default applies.
    const inherited = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      policySettings: {},
      tenantDefaults: DEFAULTS,
    });
    expect(inherited.chrome_managed_storage.updateInterval).toBe(12);
    expect(inherited.chrome_managed_storage.enablePageBlocking).toBe(false);
    expect(inherited.chrome_managed_storage.urlAllowlist).toEqual([
      "https://fleet.test/*",
    ]);

    // Tenant key present: it wins over the default.
    const overridden = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      policySettings: { updateInterval: 6, enablePageBlocking: true },
      tenantDefaults: DEFAULTS,
    });
    expect(overridden.chrome_managed_storage.updateInterval).toBe(6);
    expect(overridden.chrome_managed_storage.enablePageBlocking).toBe(true);

    // Neither set: the hardcoded fallback applies.
    const bare = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      policySettings: {},
    });
    expect(bare.chrome_managed_storage.updateInterval).toBe(24);
    expect(bare.chrome_managed_storage.enablePageBlocking).toBe(true);
  });

  it("inherits branding into empty fields only", () => {
    const resolved = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      branding: {
        ...HARBORVIEW_ARTIFACT_INPUT.branding,
        company_name: "",
        about_url: "",
      },
      tenantDefaults: {
        branding: {
          company_name: "Fleet MSP",
          about_url: "https://fleet.test/about",
          product_name: "Must not win",
        },
        policy: {},
      },
    });
    const customBranding = resolved.chrome_managed_storage.customBranding as Record<
      string,
      string
    >;
    expect(customBranding.companyName).toBe("Fleet MSP");
    expect(customBranding.aboutUrl).toBe("https://fleet.test/about");
    // The tenant's own non-empty value beats the default.
    expect(customBranding.productName).toBe("Example MSP Phishing Protection");
    // Every artifact carries the resolved values, not just managed storage.
    expect(resolved.intune_variables).toContain('"Fleet MSP"');
    expect(
      resolved.cipp_fields.find((f) => f.field === "Company Name")?.value,
    ).toBe("Fleet MSP");
    expect(resolved.reg_chrome).toContain('"companyName"="Fleet MSP"');
  });

  it("emits the logo URL when only the instance default logo exists", () => {
    const noLogo = {
      ...HARBORVIEW_ARTIFACT_INPUT.branding,
      logo_r2_key: null,
      logo_content_type: null,
    };
    const without = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      branding: noLogo,
    });
    expect(without.logo_url).toBe("");
    const withDefault = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      branding: noLogo,
      hasDefaultLogo: true,
    });
    expect(withDefault.logo_url).toBe(
      `https://check.example.com/assets/${HARBORVIEW_ARTIFACT_INPUT.guid}/logo`,
    );
  });

  it("drops the logo URL when the tenant opts into Check's default logo", () => {
    const optedOut = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      branding: {
        ...HARBORVIEW_ARTIFACT_INPUT.branding,
        logo_r2_key: null,
        logo_content_type: null,
        use_default_logo: 1,
      },
      hasDefaultLogo: true,
    });
    expect(optedOut.logo_url).toBe("");
    const customBranding = optedOut.chrome_managed_storage.customBranding as Record<
      string,
      string
    >;
    expect(customBranding.logoUrl).toBe("");
  });

  it("matches the golden bundle when every default is overridden by the tenant", () => {
    // The Harborview sample sets all the fields these defaults cover, so
    // resolution must leave the golden output byte-identical.
    const mixed = buildArtifactBundle({
      ...HARBORVIEW_ARTIFACT_INPUT,
      tenantDefaults: {
        branding: { company_name: "Must not appear" },
        policy: { urlAllowlist: ["https://must-not-appear.test/*"] },
      },
    });
    expect(mixed).toEqual(bundle);
  });

  it("strips non-inheritable keys and malformed values at parse time", () => {
    const parsed = parseTenantDefaults(
      JSON.stringify({
        branding: { company_name: "ok", tenant_id: "never", logo_r2_key: "never" },
        policy: {
          updateInterval: 12,
          cippTenantId: "never-inherited.onmicrosoft.com",
          cippServerUrl: "https://never.test",
          enableDebugLogging: true,
        },
      }),
    );
    expect(parsed.branding).toEqual({ company_name: "ok" });
    expect(parsed.policy).toEqual({ updateInterval: 12 });

    const empty = { branding: {}, policy: {} };
    expect(parseTenantDefaults("")).toEqual(empty);
    expect(parseTenantDefaults("not json")).toEqual(empty);
    expect(parseTenantDefaults("[1, 2]")).toEqual(empty);
    expect(parseTenantDefaults('"string"')).toEqual(empty);
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
