// Policy artifact generators (design section 5). Everything renders fresh
// from D1 state; nothing generated is ever stored. Registry layout, extension
// ids, update URLs, and Intune variable names are verified against Check's
// own enterprise deployment files (enterprise/Check-Extension-Policy.reg,
// enterprise/Setup-Windows-Chrome-and-Edge.ps1, enterprise/firefox/policies.json).
import type { Env } from "../types";
import { getInstanceSettings, type TenantBrandingRow } from "./db";
import {
  INHERITABLE_BRANDING_FIELDS,
  parseTenantDefaults,
  type TenantDefaults,
} from "./tenant-defaults";

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
  gpo_script: string;
  rmm_script: string;
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
  tenantSettings: Record<string, unknown>,
  defaultCippServerUrl: string,
  policyDefaults: Record<string, unknown>,
): ResolvedPolicy {
  // Instance-level defaults sit between the hardcoded fallbacks below and
  // the tenant's own settings: a tenant key present wins outright. Tenant
  // policy JSON stores only explicitly-set keys, so absent means inherit.
  const settings = { ...policyDefaults, ...tenantSettings };
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

// Branding inherits per field: the empty string in a tenant row means "use
// the instance default". Logo fields stay untouched; the asset route does
// that fallback so per-tenant URLs stay stable while content inherits.
function resolveBranding(
  branding: TenantBrandingRow,
  brandingDefaults: Record<string, string>,
): TenantBrandingRow {
  const resolved: TenantBrandingRow = { ...branding };
  for (const field of INHERITABLE_BRANDING_FIELDS) {
    const defaultValue = brandingDefaults[field];
    if (resolved[field] === "" && typeof defaultValue === "string") {
      resolved[field] = defaultValue;
    }
  }
  return resolved;
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

interface RegistryWrite {
  subKey: string;
  name: string;
  kind: "string" | "dword";
  value: string | number | boolean;
}

// Single ordered table of every registry value the Check policy needs,
// relative to the browser's policy hive. Both the .reg renderer and the GPO
// script derive from it, so the two artifacts cannot drift. Order matters:
// consecutive entries with the same subKey become one .reg section.
function registryWrites(
  browser: "chrome" | "edge",
  payload: Record<string, unknown>,
): RegistryWrite[] {
  const extensionId = browser === "chrome" ? CHROME_EXTENSION_ID : EDGE_EXTENSION_ID;
  const updateUrl = browser === "chrome" ? CHROME_UPDATE_URL : EDGE_UPDATE_URL;
  const policyKey = `3rdparty\\extensions\\${extensionId}\\policy`;
  const writes: RegistryWrite[] = [];
  const str = (subKey: string, name: string, value: string) => {
    writes.push({ subKey, name, kind: "string", value });
  };
  const dword = (subKey: string, name: string, value: number | boolean) => {
    writes.push({ subKey, name, kind: "dword", value });
  };

  str(`ExtensionSettings\\${extensionId}`, "installation_mode", "force_installed");
  str(`ExtensionSettings\\${extensionId}`, "update_url", updateUrl);
  // Keep the extension visible on the toolbar: a managed security extension
  // users cannot see is one they cannot act on. Chrome and Edge spell the
  // same intent differently; Firefox pins via default_area in policies.json.
  if (browser === "chrome") {
    str(`ExtensionSettings\\${extensionId}`, "toolbar_pin", "force_pinned");
  } else {
    str(`ExtensionSettings\\${extensionId}`, "toolbar_state", "force_shown");
  }

  str(policyKey, "customRulesUrl", String(payload.customRulesUrl));
  dword(policyKey, "updateInterval", Number(payload.updateInterval));
  dword(policyKey, "enablePageBlocking", Boolean(payload.enablePageBlocking));
  dword(policyKey, "showNotifications", Boolean(payload.showNotifications));
  dword(policyKey, "enableValidPageBadge", Boolean(payload.enableValidPageBadge));
  dword(policyKey, "validPageBadgeTimeout", Number(payload.validPageBadgeTimeout));
  dword(policyKey, "enableDebugLogging", Boolean(payload.enableDebugLogging));
  dword(policyKey, "enableCippReporting", Boolean(payload.enableCippReporting));
  if (payload.enableCippReporting === true) {
    str(policyKey, "cippServerUrl", String(payload.cippServerUrl));
    str(policyKey, "cippTenantId", String(payload.cippTenantId));
  }

  const allowlist = Array.isArray(payload.urlAllowlist)
    ? payload.urlAllowlist.map(String)
    : [];
  allowlist.forEach((value, index) => {
    str(`${policyKey}\\urlAllowlist`, String(index + 1), value);
  });

  const webhook = payload.genericWebhook as Record<string, unknown>;
  dword(`${policyKey}\\genericWebhook`, "enabled", Boolean(webhook.enabled));
  str(`${policyKey}\\genericWebhook`, "url", String(webhook.url));
  const events = Array.isArray(webhook.events) ? webhook.events.map(String) : [];
  events.forEach((value, index) => {
    str(`${policyKey}\\genericWebhook\\events`, String(index + 1), value);
  });

  const domainSquatting = payload.domainSquatting as Record<string, unknown>;
  for (const [key, value] of Object.entries(domainSquatting)) {
    if (typeof value === "boolean" || typeof value === "number") {
      dword(`${policyKey}\\domainSquatting`, key, value);
    } else {
      str(`${policyKey}\\domainSquatting`, key, String(value));
    }
  }

  const brandingPayload = payload.customBranding as Record<string, unknown>;
  for (const [key, value] of Object.entries(brandingPayload)) {
    str(`${policyKey}\\customBranding`, key, String(value));
  }

  return writes;
}

// Renders the .reg artifact (design 5.3). Chrome and Edge differ only in
// hive path, extension id, and update URL. Byte-for-byte output is locked
// by the golden tests; the section grouping mirrors the write order.
function buildRegFile(
  browser: "chrome" | "edge",
  payload: Record<string, unknown>,
): string {
  const hive =
    browser === "chrome"
      ? "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Google\\Chrome"
      : "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge";

  const lines: string[] = ["Windows Registry Editor Version 5.00", ""];
  let currentSubKey: string | null = null;
  for (const write of registryWrites(browser, payload)) {
    if (write.subKey !== currentSubKey) {
      if (currentSubKey !== null) lines.push("");
      lines.push(`[${hive}\\${write.subKey}]`);
      currentSubKey = write.subKey;
    }
    lines.push(
      write.kind === "string"
        ? regString(write.name, String(write.value))
        : regDword(write.name, write.value as number | boolean),
    );
  }
  lines.push("");

  return lines.join("\r\n");
}

// URL of Check's hand-authored ADMX templates, pinned to a release tag so a
// policy rename upstream cannot silently change what operators import. The
// AGPL-3.0 templates are linked, never vendored into this MIT codebase.
export const CHECK_ADMX_URL =
  "https://github.com/CyberDrain/Check/tree/v1.1.0/enterprise/admx";

// Ready-to-run GPO creation script. Every registry value derives from the
// same registryWrites table as the .reg files, so the two artifacts cannot
// drift. PowerShell guardrails apply to the generated text: full descriptive
// names, 7-bit ASCII only, no && or || sequencing. Values are single-quoted
// so nothing in a URL, pattern, or branding string interpolates.
function buildGpoScript(payload: Record<string, unknown>): string {
  const lines: string[] = [
    "<#",
    "Creates or updates a Group Policy Object that force-installs the Check",
    "browser extension for Chrome and Edge, pins it to the toolbar, and",
    "applies this tenant's policy and branding values. Generated by",
    "CheckDeployManager; download a fresh",
    "copy from the tenant's Artifacts tab after any policy or branding",
    "change, then re-run.",
    "",
    "Requires the Group Policy PowerShell module (RSAT) and permission to",
    "create and edit GPOs; run on a domain-joined management host.",
    "",
    "Registry values are written directly, so the ADMX templates are not",
    "required for enforcement. Import them once per domain (central store)",
    "to make these values readable in the Group Policy Management Editor:",
    `${CHECK_ADMX_URL}`,
    "#>",
    "param(",
    "    [string]$GroupPolicyName = 'Check Browser Extension',",
    "    [string]$DomainName = ''",
    ")",
    "",
    "$ErrorActionPreference = 'Stop'",
    "Import-Module GroupPolicy",
    "",
    "$domainParameters = @{}",
    "if ($DomainName -ne '') { $domainParameters['Domain'] = $DomainName }",
    "",
    "$groupPolicyObject = Get-GPO -Name $GroupPolicyName @domainParameters -ErrorAction SilentlyContinue",
    "if ($null -eq $groupPolicyObject) {",
    "    $groupPolicyObject = New-GPO -Name $GroupPolicyName @domainParameters",
    '    Write-Output "Created GPO named $GroupPolicyName."',
    "} else {",
    '    Write-Output "Updating existing GPO named $GroupPolicyName."',
    "}",
    "",
  ];

  let valueCount = 0;
  for (const browser of ["chrome", "edge"] as const) {
    const hive =
      browser === "chrome"
        ? "HKLM\\SOFTWARE\\Policies\\Google\\Chrome"
        : "HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge";
    lines.push(browser === "chrome" ? "# Google Chrome" : "# Microsoft Edge");
    for (const write of registryWrites(browser, payload)) {
      const key = powershellSingleQuote(`${hive}\\${write.subKey}`);
      const name = powershellSingleQuote(write.name);
      if (write.kind === "string") {
        lines.push(
          `Set-GPRegistryValue -Guid $groupPolicyObject.Id @domainParameters -Key ${key} -ValueName ${name} -Type String -Value ${powershellSingleQuote(String(write.value))} | Out-Null`,
        );
      } else {
        const numeric =
          typeof write.value === "boolean"
            ? write.value
              ? 1
              : 0
            : Number(write.value);
        lines.push(
          `Set-GPRegistryValue -Guid $groupPolicyObject.Id @domainParameters -Key ${key} -ValueName ${name} -Type DWord -Value ${numeric} | Out-Null`,
        );
      }
      valueCount += 1;
    }
    lines.push("");
  }

  lines.push(
    `Write-Output 'Applied ${valueCount} registry values for Chrome and Edge.'`,
  );
  lines.push(
    "Write-Output 'Link the GPO to an organizational unit when ready, for example:'",
  );
  lines.push(
    "Write-Output \"  New-GPLink -Name '$GroupPolicyName' -Target 'OU=Workstations,DC=example,DC=com'\"",
  );
  lines.push("");
  return lines.join("\r\n");
}

// Standalone RMM deployment script. Registry values derive from the same
// registryWrites table as the .reg files and GPO script, so the three
// artifacts cannot drift; the Firefox block embeds the same policies.json
// the dedicated artifact ships. The three $Include* variables at the top are
// the browser toggles the dashboard checkboxes preset before download.
// PowerShell guardrails apply: full descriptive names, 7-bit ASCII only,
// no && or || sequencing, single-quoted values so nothing interpolates.
function buildRmmScript(
  payload: Record<string, unknown>,
  firefoxFull: Record<string, unknown>,
): string {
  const lines: string[] = [
    "<#",
    "Deploys the Check browser extension policy for this tenant on a Windows",
    "endpoint: force-install, pinned toolbar icon, and the full policy and",
    "branding payload for the browsers selected below. Designed to run as",
    "SYSTEM from an RMM. Generated by CheckDeployManager; download a fresh",
    "copy from the tenant's Artifacts tab after any policy or branding",
    "change, then redeploy.",
    "",
    "Chrome and Edge read the values from HKLM policy keys on their next",
    "policy refresh or restart; no gpupdate is needed for direct registry",
    "writes. Firefox reads distribution\\policies.json at startup. The",
    "embedded policies.json ships install_url blank; fill it with your XPI",
    "source per the Check docs before enabling the Firefox block, or the",
    "force-install cannot resolve a download location.",
    "#>",
    "",
    "# Browser toggles: set to $false to skip a browser.",
    "$IncludeChrome = $true",
    "$IncludeEdge = $true",
    "$IncludeFirefox = $true",
    "",
    "$ErrorActionPreference = 'Stop'",
    "",
    "function Set-CheckPolicyRegistryValue {",
    "    param(",
    "        [string]$Key,",
    "        [string]$Name,",
    "        $Value,",
    "        [string]$Type",
    "    )",
    "    if (-not (Test-Path -Path $Key)) {",
    "        New-Item -Path $Key -Force | Out-Null",
    "    }",
    "    New-ItemProperty -Path $Key -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null",
    "}",
    "",
  ];

  for (const browser of ["chrome", "edge"] as const) {
    const hive =
      browser === "chrome"
        ? "HKLM:\\SOFTWARE\\Policies\\Google\\Chrome"
        : "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge";
    const variable = browser === "chrome" ? "$IncludeChrome" : "$IncludeEdge";
    const label = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
    lines.push(`if (${variable}) {`);
    lines.push(`    Write-Output 'Applying the ${label} policy values.'`);
    for (const write of registryWrites(browser, payload)) {
      const key = powershellSingleQuote(`${hive}\\${write.subKey}`);
      const name = powershellSingleQuote(write.name);
      if (write.kind === "string") {
        lines.push(
          `    Set-CheckPolicyRegistryValue -Key ${key} -Name ${name} -Type 'String' -Value ${powershellSingleQuote(String(write.value))}`,
        );
      } else {
        const numeric =
          typeof write.value === "boolean"
            ? write.value
              ? 1
              : 0
            : Number(write.value);
        lines.push(
          `    Set-CheckPolicyRegistryValue -Key ${key} -Name ${name} -Type 'DWord' -Value ${numeric}`,
        );
      }
    }
    lines.push("}");
    lines.push("");
  }

  const policiesJson = toAscii(JSON.stringify(firefoxFull, null, 2));
  lines.push("if ($IncludeFirefox) {");
  lines.push("    $firefoxPoliciesJson = @'");
  for (const jsonLine of policiesJson.split("\n")) {
    lines.push(jsonLine);
  }
  lines.push("'@");
  lines.push(
    "    $firefoxInstallDirectories = @('C:\\Program Files\\Mozilla Firefox', 'C:\\Program Files (x86)\\Mozilla Firefox') | Where-Object { Test-Path -Path $_ }",
  );
  lines.push("    if ($null -eq $firefoxInstallDirectories) {");
  lines.push(
    "        Write-Output 'Firefox installation not found; skipping the Firefox block.'",
  );
  lines.push("    } else {");
  lines.push(
    "        foreach ($firefoxDirectory in @($firefoxInstallDirectories)) {",
  );
  lines.push(
    "            $distributionDirectory = Join-Path -Path $firefoxDirectory -ChildPath 'distribution'",
  );
  lines.push("            if (-not (Test-Path -Path $distributionDirectory)) {");
  lines.push(
    "                New-Item -ItemType Directory -Path $distributionDirectory -Force | Out-Null",
  );
  lines.push("            }");
  lines.push(
    "            $policiesFilePath = Join-Path -Path $distributionDirectory -ChildPath 'policies.json'",
  );
  lines.push("            if (Test-Path -Path $policiesFilePath) {");
  lines.push(
    "                Copy-Item -Path $policiesFilePath -Destination ($policiesFilePath + '.bak') -Force",
  );
  lines.push(
    '                Write-Output "Backed up the existing policies.json in $distributionDirectory."',
  );
  lines.push("            }");
  // ASCII encoding writes no byte order mark on any PowerShell edition; a
  // BOM is known to break Firefox's policies.json parsing, and the script
  // text is already reduced to 7-bit ASCII.
  lines.push(
    "            Set-Content -Path $policiesFilePath -Value $firefoxPoliciesJson -Encoding Ascii",
  );
  lines.push(
    '            Write-Output "Wrote policies.json to $distributionDirectory."',
  );
  lines.push("        }");
  lines.push("    }");
  lines.push("}");
  lines.push("");
  lines.push(
    "Write-Output 'Check policy deployment finished. Browsers apply the new policy on their next policy refresh or restart.'",
  );
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

// Literal single-quoted PowerShell string: nothing interpolates, only the
// quote itself needs doubling.
function powershellSingleQuote(value: string): string {
  return `'${toAscii(value).replace(/'/g, "''")}'`;
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
  // Instance-level tenant defaults; omitted means none are set.
  tenantDefaults?: TenantDefaults;
  // True when the instance has a default logo, so the asset URL is live even
  // for tenants that never uploaded their own.
  hasDefaultLogo?: boolean;
}

// Pure renderer: everything derives from the input, so golden tests and the
// golden generation script can run it without a database.
export function buildArtifactBundle(input: ArtifactInput): ArtifactBundle {
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const defaults = input.tenantDefaults ?? { branding: {}, policy: {} };
  const branding = resolveBranding(input.branding, defaults.branding);
  const policy = resolvePolicy(
    input.policySettings,
    input.defaultCippServerUrl,
    defaults.policy,
  );
  const configUrl = `${baseUrl}/rules/${input.guid}.json`;
  const hookUrl = `${baseUrl}/hook/${input.guid}`;
  const logoUrl =
    input.branding.logo_r2_key !== null || input.hasDefaultLogo === true
      ? `${baseUrl}/assets/${input.guid}/logo`
      : "";
  const urls = { configUrl, hookUrl, logoUrl };

  const managedStorage = buildManagedStorage(policy, branding, urls);
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

  const firefoxFull = buildFirefoxFull(firefoxFragment);
  return {
    guid: input.guid,
    config_url: configUrl,
    hook_url: hookUrl,
    logo_url: logoUrl,
    chrome_managed_storage: managedStorage,
    edge_managed_storage: managedStorage,
    firefox_fragment: firefoxFragment,
    firefox_policies_full: firefoxFull,
    reg_chrome: buildRegFile("chrome", managedStorage),
    reg_edge: buildRegFile("edge", managedStorage),
    gpo_script: buildGpoScript(managedStorage),
    rmm_script: buildRmmScript(managedStorage, firefoxFull),
    intune_variables: buildIntuneVariables(policy, branding, urls),
    cipp_fields: buildCippFields(policy, branding, urls),
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
      tenantDefaults: parseTenantDefaults(settings.tenant_defaults ?? ""),
      hasDefaultLogo: (settings.default_logo_r2_key ?? "") !== "",
    }),
  };
}
