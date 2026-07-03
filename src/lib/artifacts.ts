// Policy artifact generators (design section 5). Everything renders fresh
// from D1 state; nothing generated is ever stored. Registry layout, extension
// ids, update URLs, and Intune variable names are verified against Check's
// own enterprise deployment files (enterprise/Check-Extension-Policy.reg,
// enterprise/Setup-Windows-Chrome-and-Edge.ps1, enterprise/firefox/policies.json).
import type { Env } from "../types";
import { getInstanceSettings, type TenantBrandingRow } from "./db";

export const CHROME_EXTENSION_ID = "benimdeioplgkhanklclahllklceahbe";
export const EDGE_EXTENSION_ID = "knepjpocdagponkonnbggpcnhnaikajg";
export const FIREFOX_EXTENSION_ID = "check@cyberdrain.com";

const CHROME_UPDATE_URL = "https://clients2.google.com/service/update2/crx";
const EDGE_UPDATE_URL = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

const DEFAULT_WEBHOOK_EVENTS = [
  "false_positive_report",
  "page_blocked",
  "threat_detected",
];

export interface ArtifactBundle {
  guid: string;
  config_url: string;
  hook_url: string;
  logo_url: string;
  chrome_managed_storage: Record<string, unknown>;
  edge_managed_storage: Record<string, unknown>;
  firefox_fragment: Record<string, unknown>;
  firefox_policies_full: Record<string, unknown>;
  reg_chrome: string;
  reg_edge: string;
  intune_variables: string;
  cipp_fields: { field: string; value: string }[];
  warnings: string[];
}

interface ResolvedPolicy {
  updateInterval: number;
  enablePageBlocking: boolean;
  showNotifications: boolean;
  enableValidPageBadge: boolean;
  validPageBadgeTimeout: number;
  enableDebugLogging: boolean;
  urlAllowlist: string[];
  domainSquatting: Record<string, unknown>;
  webhookEnabled: boolean;
  webhookEvents: string[];
  enableCippReporting: boolean;
  cippServerUrl: string;
  cippTenantId: string;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolvePolicy(
  settings: Record<string, unknown>,
  defaultCippServerUrl: string,
): ResolvedPolicy {
  const domainSquatting =
    settings.domainSquatting !== null &&
    typeof settings.domainSquatting === "object" &&
    !Array.isArray(settings.domainSquatting)
      ? (settings.domainSquatting as Record<string, unknown>)
      : { enabled: true, deviationThreshold: 2, Action: "block" };
  const genericWebhook =
    settings.genericWebhook !== null &&
    typeof settings.genericWebhook === "object" &&
    !Array.isArray(settings.genericWebhook)
      ? (settings.genericWebhook as Record<string, unknown>)
      : {};

  const cippServerUrl =
    typeof settings.cippServerUrl === "string" && settings.cippServerUrl.length > 0
      ? settings.cippServerUrl
      : defaultCippServerUrl;
  // A fresh install with no CIPP server configured always emits CIPP off.
  const enableCippReporting =
    cippServerUrl.length > 0 && asBoolean(settings.enableCippReporting, false);

  return {
    updateInterval: asNumber(settings.updateInterval, 24),
    enablePageBlocking: asBoolean(settings.enablePageBlocking, true),
    showNotifications: asBoolean(settings.showNotifications, true),
    enableValidPageBadge: asBoolean(settings.enableValidPageBadge, true),
    validPageBadgeTimeout: asNumber(settings.validPageBadgeTimeout, 5),
    enableDebugLogging: asBoolean(settings.enableDebugLogging, false),
    urlAllowlist: Array.isArray(settings.urlAllowlist)
      ? settings.urlAllowlist.map(String)
      : [],
    domainSquatting,
    webhookEnabled: asBoolean(genericWebhook.enabled, true),
    webhookEvents: Array.isArray(genericWebhook.events)
      ? genericWebhook.events.map(String)
      : DEFAULT_WEBHOOK_EVENTS,
    enableCippReporting,
    cippServerUrl,
    cippTenantId: typeof settings.cippTenantId === "string" ? settings.cippTenantId : "",
  };
}

function buildManagedStorage(
  policy: ResolvedPolicy,
  branding: TenantBrandingRow,
  urls: { configUrl: string; hookUrl: string; logoUrl: string },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    customRulesUrl: urls.configUrl,
    updateInterval: policy.updateInterval,
    enablePageBlocking: policy.enablePageBlocking,
    showNotifications: policy.showNotifications,
    enableValidPageBadge: policy.enableValidPageBadge,
    validPageBadgeTimeout: policy.validPageBadgeTimeout,
    enableDebugLogging: policy.enableDebugLogging,
    urlAllowlist: policy.urlAllowlist,
    enableCippReporting: policy.enableCippReporting,
  };
  if (policy.enableCippReporting) {
    payload.cippServerUrl = policy.cippServerUrl;
    payload.cippTenantId = policy.cippTenantId;
  }
  payload.genericWebhook = {
    enabled: policy.webhookEnabled,
    url: urls.hookUrl,
    events: policy.webhookEvents,
  };
  payload.domainSquatting = policy.domainSquatting;
  payload.customBranding = {
    companyName: branding.company_name,
    productName: branding.product_name,
    supportEmail: branding.support_email,
    supportUrl: branding.support_url,
    privacyPolicyUrl: branding.privacy_policy_url,
    aboutUrl: branding.about_url,
    primaryColor: branding.primary_color,
    logoUrl: urls.logoUrl,
  };
  return payload;
}

function regEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function regString(name: string, value: string): string {
  return `"${regEscape(name)}"="${regEscape(value)}"`;
}

function regDword(name: string, value: number | boolean): string {
  const numeric = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return `"${regEscape(name)}"=dword:${(numeric >>> 0).toString(16).padStart(8, "0")}`;
}

function regNumberedStrings(values: string[]): string[] {
  return values.map((value, index) => regString(String(index + 1), value));
}

// Renders the .reg artifact (design 5.3). Chrome and Edge differ only in
// hive path, extension id, and update URL.
function buildRegFile(
  browser: "chrome" | "edge",
  payload: Record<string, unknown>,
): string {
  const hive =
    browser === "chrome"
      ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome"
      : "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge";
  const extensionId = browser === "chrome" ? CHROME_EXTENSION_ID : EDGE_EXTENSION_ID;
  const updateUrl = browser === "chrome" ? CHROME_UPDATE_URL : EDGE_UPDATE_URL;
  const policyKey = `${hive}\\3rdparty\\extensions\\${extensionId}\\policy`;

  const lines: string[] = ["Windows Registry Editor Version 5.00", ""];

  lines.push(`[${hive}\\ExtensionSettings\\${extensionId}]`);
  lines.push(regString("installation_mode", "force_installed"));
  lines.push(regString("update_url", updateUrl));
  lines.push("");

  lines.push(`[${policyKey}]`);
  lines.push(regString("customRulesUrl", String(payload.customRulesUrl)));
  lines.push(regDword("updateInterval", Number(payload.updateInterval)));
  lines.push(regDword("enablePageBlocking", Boolean(payload.enablePageBlocking)));
  lines.push(regDword("showNotifications", Boolean(payload.showNotifications)));
  lines.push(regDword("enableValidPageBadge", Boolean(payload.enableValidPageBadge)));
  lines.push(regDword("validPageBadgeTimeout", Number(payload.validPageBadgeTimeout)));
  lines.push(regDword("enableDebugLogging", Boolean(payload.enableDebugLogging)));
  lines.push(regDword("enableCippReporting", Boolean(payload.enableCippReporting)));
  if (payload.enableCippReporting === true) {
    lines.push(regString("cippServerUrl", String(payload.cippServerUrl)));
    lines.push(regString("cippTenantId", String(payload.cippTenantId)));
  }
  lines.push("");

  const allowlist = Array.isArray(payload.urlAllowlist)
    ? payload.urlAllowlist.map(String)
    : [];
  if (allowlist.length > 0) {
    lines.push(`[${policyKey}\\urlAllowlist]`);
    lines.push(...regNumberedStrings(allowlist));
    lines.push("");
  }

  const webhook = payload.genericWebhook as Record<string, unknown>;
  lines.push(`[${policyKey}\\genericWebhook]`);
  lines.push(regDword("enabled", Boolean(webhook.enabled)));
  lines.push(regString("url", String(webhook.url)));
  lines.push("");
  const events = Array.isArray(webhook.events) ? webhook.events.map(String) : [];
  if (events.length > 0) {
    lines.push(`[${policyKey}\\genericWebhook\\events]`);
    lines.push(...regNumberedStrings(events));
    lines.push("");
  }

  const domainSquatting = payload.domainSquatting as Record<string, unknown>;
  lines.push(`[${policyKey}\\domainSquatting]`);
  for (const [key, value] of Object.entries(domainSquatting)) {
    if (typeof value === "boolean" || typeof value === "number") {
      lines.push(regDword(key, value));
    } else {
      lines.push(regString(key, String(value)));
    }
  }
  lines.push("");

  const brandingPayload = payload.customBranding as Record<string, unknown>;
  lines.push(`[${policyKey}\\customBranding]`);
  for (const [key, value] of Object.entries(brandingPayload)) {
    lines.push(regString(key, String(value)));
  }
  lines.push("");

  return lines.join("\r\n");
}

// PowerShell guardrails apply to this generated text: 7-bit ASCII only, no
// em dash, no && sequencing, full variable names from Check's Setup script.
function toAscii(value: string): string {
  let out = "";
  for (const char of value) {
    out += char.charCodeAt(0) <= 126 ? char : "?";
  }
  return out;
}

function powershellQuote(value: string): string {
  return `"${toAscii(value).replace(/`/g, "``").replace(/"/g, '`"')}"`;
}

function powershellArray(values: string[]): string {
  if (values.length === 0) return "@()";
  return `@(${values.map(powershellQuote).join(", ")})`;
}

// Variable block for Check's Setup-Windows-Chrome-and-Edge.ps1 (design 5.4).
function buildIntuneVariables(
  policy: ResolvedPolicy,
  branding: TenantBrandingRow,
  urls: { configUrl: string; hookUrl: string; logoUrl: string },
): string {
  const lines = [
    `$enableCippReporting = ${policy.enableCippReporting ? 1 : 0}`,
    `$cippServerUrl = ${powershellQuote(policy.enableCippReporting ? policy.cippServerUrl : "")}`,
    `$cippTenantId = ${powershellQuote(policy.enableCippReporting ? policy.cippTenantId : "")}`,
    `$customRulesUrl = ${powershellQuote(urls.configUrl)}`,
    `$urlAllowlist = ${powershellArray(policy.urlAllowlist)}`,
    `$enableGenericWebhook = ${policy.webhookEnabled ? 1 : 0}`,
    `$webhookUrl = ${powershellQuote(urls.hookUrl)}`,
    `$webhookEvents = ${powershellArray(policy.webhookEvents)}`,
    `$companyName = ${powershellQuote(branding.company_name)}`,
    `$productName = ${powershellQuote(branding.product_name)}`,
    `$supportEmail = ${powershellQuote(branding.support_email)}`,
    `$supportUrl = ${powershellQuote(branding.support_url)}`,
    `$privacyPolicyUrl = ${powershellQuote(branding.privacy_policy_url)}`,
    `$aboutUrl = ${powershellQuote(branding.about_url)}`,
    `$primaryColor = ${powershellQuote(branding.primary_color)}`,
    `$logoUrl = ${powershellQuote(urls.logoUrl)}`,
    `$domainSquattingEnabled = ${policy.domainSquatting.enabled === true ? 1 : 0}`,
  ];
  return lines.join("\n") + "\n";
}

function buildCippFields(
  policy: ResolvedPolicy,
  branding: TenantBrandingRow,
  urls: { configUrl: string; logoUrl: string },
): { field: string; value: string }[] {
  return [
    { field: "Custom Rules / Config URL", value: urls.configUrl },
    {
      field: "CIPP Reporting",
      value: policy.enableCippReporting ? "Enabled" : "Disabled",
    },
    {
      field: "CIPP Server URL",
      value: policy.enableCippReporting ? policy.cippServerUrl : "",
    },
    {
      field: "Tenant ID / Domain",
      value:
        policy.cippTenantId.length > 0
          ? policy.cippTenantId
          : "(auto-filled per CIPP tenant)",
    },
    { field: "Company Name", value: branding.company_name },
    { field: "Product Name", value: branding.product_name },
    { field: "Support Email", value: branding.support_email },
    { field: "Support URL", value: branding.support_url },
    { field: "Privacy Policy URL", value: branding.privacy_policy_url },
    { field: "About URL", value: branding.about_url },
    { field: "Primary Color", value: branding.primary_color },
    { field: "Logo URL", value: urls.logoUrl },
  ];
}

// Mirrors Check's enterprise/firefox/policies.json template. The install_url
// is intentionally blank there; the deployer fills in their XPI source.
function buildFirefoxFull(
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  return {
    policies: {
      Extensions: {
        Install: [""],
        Locked: [FIREFOX_EXTENSION_ID],
      },
      ExtensionSettings: {
        [FIREFOX_EXTENSION_ID]: {
          installation_mode: "force_installed",
          install_url: "",
          default_area: "navbar",
        },
      },
      "3rdparty": (fragment as { policies: Record<string, unknown> }).policies[
        "3rdparty"
      ],
    },
  };
}

export interface ArtifactInput {
  guid: string;
  baseUrl: string;
  defaultCippServerUrl: string;
  branding: TenantBrandingRow;
  policySettings: Record<string, unknown>;
}

// Pure renderer: everything derives from the input, so golden tests and the
// golden generation script can run it without a database.
export function buildArtifactBundle(input: ArtifactInput): ArtifactBundle {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const policy = resolvePolicy(input.policySettings, input.defaultCippServerUrl);
  const configUrl = `${baseUrl}/rules/${input.guid}.json`;
  const hookUrl = `${baseUrl}/hook/${input.guid}`;
  const logoUrl =
    input.branding.logo_r2_key !== null ? `${baseUrl}/assets/${input.guid}/logo` : "";
  const urls = { configUrl, hookUrl, logoUrl };

  const managedStorage = buildManagedStorage(policy, input.branding, urls);
  const firefoxFragment = {
    policies: {
      "3rdparty": {
        Extensions: {
          [FIREFOX_EXTENSION_ID]: managedStorage,
        },
      },
    },
  };

  // Deployment mistakes worth flagging next to the files that carry them.
  // CIPP's own deployment standard fills cippTenantId per tenant, so an
  // empty value is only a problem for directly deployed artifacts.
  const warnings: string[] = [];
  if (policy.enableCippReporting && policy.cippTenantId.length === 0) {
    warnings.push(
      "CIPP reporting is enabled but no CIPP tenant id or domain is set. " +
        "Artifacts deployed directly (managed storage, reg files, Intune) " +
        "will report events without tenant attribution. Set it on the " +
        "Policy tab; ignore this only when deploying via the CIPP " +
        "deployment standard, which fills it per tenant.",
    );
  }

  return {
    guid: input.guid,
    config_url: configUrl,
    hook_url: hookUrl,
    logo_url: logoUrl,
    chrome_managed_storage: managedStorage,
    edge_managed_storage: managedStorage,
    firefox_fragment: firefoxFragment,
    firefox_policies_full: buildFirefoxFull(firefoxFragment),
    reg_chrome: buildRegFile("chrome", managedStorage),
    reg_edge: buildRegFile("edge", managedStorage),
    intune_variables: buildIntuneVariables(policy, input.branding, urls),
    cipp_fields: buildCippFields(policy, input.branding, urls),
    warnings,
  };
}

export type ArtifactResult =
  | { ok: true; artifacts: ArtifactBundle }
  | { ok: false; error: string };

export async function generateArtifacts(
  env: Env,
  tenantId: string,
  requestedGuid?: string,
): Promise<ArtifactResult> {
  const settings = await getInstanceSettings(env.DB);
  const baseUrl = settings.public_base_url.replace(/\/+$/, "");
  if (baseUrl.length === 0) {
    return {
      ok: false,
      error:
        "public_base_url is not set; configure it under instance settings before generating artifacts",
    };
  }

  let guidRow: { guid: string } | null;
  if (requestedGuid !== undefined) {
    guidRow = await env.DB.prepare(
      "SELECT guid FROM tenant_guids WHERE guid = ? AND tenant_id = ? AND status = 'active'",
    )
      .bind(requestedGuid, tenantId)
      .first();
  } else {
    guidRow = await env.DB.prepare(
      "SELECT guid FROM tenant_guids WHERE tenant_id = ? AND status = 'active' " +
        "ORDER BY created_at DESC LIMIT 1",
    )
      .bind(tenantId)
      .first();
  }
  if (guidRow === null) {
    return { ok: false, error: "tenant has no active GUID" };
  }
  const guid = guidRow.guid;

  const branding =
    (await env.DB.prepare("SELECT * FROM tenant_branding WHERE tenant_id = ?")
      .bind(tenantId)
      .first<TenantBrandingRow>()) ??
    ({
      tenant_id: tenantId,
      company_name: "",
      product_name: "",
      support_email: "",
      support_url: "",
      privacy_policy_url: "",
      about_url: "",
      primary_color: "#F77F00",
      logo_r2_key: null,
      logo_content_type: null,
    } as TenantBrandingRow);

  const policyRow = await env.DB.prepare(
    "SELECT settings_json FROM tenant_policy_settings WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ settings_json: string }>();
  return {
    ok: true,
    artifacts: buildArtifactBundle({
      guid,
      baseUrl,
      defaultCippServerUrl: settings.default_cipp_server_url,
      branding,
      policySettings: JSON.parse(policyRow?.settings_json ?? "{}"),
    }),
  };
}
