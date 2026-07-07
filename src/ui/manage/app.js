/* CheckDeployManager dashboard. Vanilla JS, no dependencies, no build step.
   Every value that came from the API or a webhook payload is HTML-escaped
   before rendering; webhook payloads are never parsed or interpreted. */
"use strict";

const view = document.getElementById("view");

/* ---------- utilities ---------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(message, isError) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 3500);
}

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      (body && (body.error || (body.errors || []).join("; "))) ||
      `HTTP ${response.status}`;
    const error = new Error(message);
    error.body = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

function jsonBody(method, payload) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function fmtTime(iso) {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return esc(iso);
  return date.toLocaleString();
}

function ago(iso) {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return esc(iso);
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Copy failed; select and copy manually", true);
  }
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* Store big artifact strings by key so copy and download buttons never embed
   content in HTML attributes. */
const artifactStore = new Map();

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-key], [data-download-key]");
  if (!button) return;
  const copyKey = button.getAttribute("data-copy-key");
  const downloadKey = button.getAttribute("data-download-key");
  if (copyKey) copyText(artifactStore.get(copyKey) ?? "");
  if (downloadKey) {
    downloadText(
      button.getAttribute("data-filename") || "artifact.txt",
      artifactStore.get(downloadKey) ?? "",
      button.getAttribute("data-mime") || "text/plain",
    );
  }
});

/* ---------- theme ---------- */

const themeToggle = document.getElementById("theme-toggle");
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  localStorage.setItem("cdm-theme", theme);
}
applyTheme(localStorage.getItem("cdm-theme") || "dark");
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

/* ---------- router ---------- */

/* Setup wizard state. Status is fetched once at boot and refreshed after
   each wizard action; every step's state derives from it, never from a
   stored step counter. The redirect fires at most once per page load so the
   top nav stays fully usable while onboarding is incomplete. */
let onboardingStatus = null;
let redirectedToSetup = false;
let setupTenantResult = null;

async function refreshOnboardingStatus() {
  try {
    onboardingStatus = await api("/instance/status");
  } catch {
    onboardingStatus = null;
  }
  const showSetup =
    onboardingStatus !== null && !onboardingStatus.onboarding_complete;
  document.getElementById("nav-setup").classList.toggle("hidden", !showSetup);
  renderFooter(onboardingStatus);
}

/* ---------- footer and update check ---------- */

const REPO_URL = "https://github.com/DailenG/CheckDeployManager";
let updateCheckDone = false;

function renderFooter(status) {
  const footer = document.getElementById("app-footer");
  const version = status !== null && status.version ? String(status.version) : "";
  footer.innerHTML = `<span class="brand-mark">Check</span>DeployManager${
    version ? ` <span class="mono">v${esc(version)}</span>` : ""
  } &middot; <a href="${REPO_URL}/releases" target="_blank" rel="noreferrer">Releases</a><span id="update-hint"></span>`;
  if (version && !updateCheckDone) {
    updateCheckDone = true;
    checkForUpdate(version);
  }
}

// Newer-release nudge. Runs once per page load, from the operator's browser
// only (never the Worker), and stays silent on any failure so offline or
// rate-limited instances lose nothing.
async function checkForUpdate(current) {
  try {
    const response = await fetch(
      "https://api.github.com/repos/DailenG/CheckDeployManager/releases/latest",
    );
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/, "");
    if (latest && isNewerVersion(latest, current)) {
      const hint = document.getElementById("update-hint");
      if (hint) {
        hint.innerHTML = ` <a class="badge accent" href="${REPO_URL}/releases/tag/${esc(
          String(release.tag_name),
        )}" target="_blank" rel="noreferrer">v${esc(latest)} available</a>`;
      }
    }
  } catch {
    /* silent */
  }
}

function isNewerVersion(candidate, current) {
  const a = candidate.split(".").map((part) => parseInt(part, 10) || 0);
  const b = current.split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

const routes = [
  { pattern: /^#\/setup$/, render: renderSetup, nav: "setup" },
  { pattern: /^#\/tenants$/, render: renderTenantList, nav: "tenants" },
  { pattern: /^#\/tenants\/([0-9a-f-]+)\/onboard$/, render: renderTenantOnboard, nav: "tenants" },
  { pattern: /^#\/tenants\/([0-9a-f-]+)(?:\/(\w+))?$/, render: renderTenantDetail, nav: "tenants" },
  { pattern: /^#\/events$/, render: renderEvents, nav: "events" },
  { pattern: /^#\/upstream$/, render: renderUpstream, nav: "upstream" },
  { pattern: /^#\/settings$/, render: renderSettings, nav: "settings" },
  { pattern: /^#\/audit$/, render: renderAudit, nav: "audit" },
];

async function route() {
  const hash = location.hash || "#/tenants";
  if (
    !redirectedToSetup &&
    hash === "#/tenants" &&
    onboardingStatus !== null &&
    !onboardingStatus.onboarding_complete
  ) {
    redirectedToSetup = true;
    location.hash = "#/setup";
    if (location.hash === "#/setup") return;
  }
  for (const entry of routes) {
    const match = hash.match(entry.pattern);
    if (match) {
      document.querySelectorAll("#main-nav a").forEach((a) => {
        a.classList.toggle("active", a.getAttribute("data-nav") === entry.nav);
      });
      view.innerHTML = '<p class="muted">Loading...</p>';
      try {
        await entry.render(...match.slice(1));
      } catch (error) {
        view.innerHTML = `<div class="panel"><strong>Error:</strong> ${esc(error.message)}</div>`;
      }
      return;
    }
  }
  location.hash = "#/tenants";
}

window.addEventListener("hashchange", route);
refreshOnboardingStatus().then(route);

/* ---------- tenant list ---------- */

async function renderTenantList() {
  const data = await api("/tenants");
  const rows = data.tenants
    .map((tenant) => {
      const badges = [];
      if (tenant.current_version_number === null) {
        badges.push('<span class="badge warn">unpublished</span>');
      } else {
        badges.push(`<span class="badge good">v${esc(tenant.current_version_number)}</span>`);
      }
      if (tenant.stale) badges.push('<span class="badge warn">stale</span>');
      if (tenant.revoked_hits > 0) {
        badges.push(`<span class="badge bad">${esc(tenant.revoked_hits)} revoked hits</span>`);
      }
      if (tenant.new_events > 0) {
        badges.push(`<span class="badge accent">${esc(tenant.new_events)} new events</span>`);
      }
      return `<tr class="clickable" data-tenant="${esc(tenant.id)}">
        <td><strong>${esc(tenant.name)}</strong><br><span class="muted mono">${esc(tenant.id)}</span></td>
        <td>${badges.join(" ")}</td>
        <td>${esc(ago(tenant.last_fetch_at))}</td>
        <td>${esc(tenant.active_guids)}</td>
      </tr>`;
    })
    .join("");

  view.innerHTML = `
    <div class="row spread">
      <h1>Tenants</h1>
      <div class="row">
        <button id="onboard-tenant">Onboard wizard</button>
        <button id="new-tenant" class="primary">New tenant</button>
      </div>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>Tenant</th><th>Status</th><th>Last fetch</th><th>Active GUIDs</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No tenants yet. Create the first one.</td></tr>'}</tbody>
      </table>
      <p class="muted" style="margin-bottom:0">Stale means no rules fetch within ${esc(data.stale_fetch_hours)} hours.</p>
    </div>`;

  document.getElementById("new-tenant").addEventListener("click", async () => {
    const name = prompt("Tenant name (client organization):");
    if (!name || !name.trim()) return;
    try {
      const created = await api("/tenants", jsonBody("POST", { name: name.trim() }));
      toast(`Tenant created with GUID ${created.guid}`);
      location.hash = `#/tenants/${created.id}`;
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.getElementById("onboard-tenant").addEventListener("click", async () => {
    const name = prompt(
      "Tenant name (client organization). The wizard walks branding, policy, rules, publish, and deployment:",
    );
    if (!name || !name.trim()) return;
    try {
      const created = await api("/tenants", jsonBody("POST", { name: name.trim() }));
      toast(`Tenant created with GUID ${created.guid}`);
      location.hash = `#/tenants/${created.id}/onboard`;
    } catch (error) {
      toast(error.message, true);
    }
  });
  view.querySelectorAll("tr[data-tenant]").forEach((row) => {
    row.addEventListener("click", () => {
      location.hash = `#/tenants/${row.getAttribute("data-tenant")}`;
    });
  });
}

/* ---------- tenant detail ---------- */

const TENANT_TABS = [
  ["rules", "Rules draft"],
  ["versions", "Versions"],
  ["branding", "Branding"],
  ["policy", "Policy"],
  ["artifacts", "Artifacts"],
  ["guids", "GUIDs"],
];

async function renderTenantDetail(tenantId, tab) {
  tab = tab || "rules";
  const detail = await api(`/tenants/${tenantId}`);
  const tenant = detail.tenant;

  const tabsHtml = TENANT_TABS.map(
    ([key, label]) =>
      `<a href="#/tenants/${esc(tenantId)}/${key}" class="${key === tab ? "active" : ""}">${esc(label)}</a>`,
  ).join("");

  view.innerHTML = `
    <div class="row spread">
      <h1>${esc(tenant.name)}</h1>
      <div class="row">
        ${
          detail.current_version === null
            ? `<button id="continue-onboard" class="small primary">Continue onboarding</button>`
            : ""
        }
        <button id="duplicate-tenant" class="small">Duplicate</button>
        <button id="rename-tenant" class="small">Rename</button>
        <button id="delete-tenant" class="small danger">Delete</button>
      </div>
    </div>
    <p class="muted">Preview URL: <span class="mono">/preview/${esc(tenant.preview_token)}.json</span>
      <button class="small ghost" id="copy-preview">Copy full URL</button></p>
    <div class="tabs">${tabsHtml}</div>
    <div id="tab-body"><p class="muted">Loading...</p></div>`;

  document.getElementById("copy-preview").addEventListener("click", () => {
    copyText(`${location.origin}/preview/${tenant.preview_token}.json`);
  });
  document.getElementById("continue-onboard")?.addEventListener("click", () => {
    location.hash = `#/tenants/${tenantId}/onboard`;
  });
  document.getElementById("duplicate-tenant").addEventListener("click", async () => {
    const name = prompt(
      "Name for the duplicate. Only the rules delta draft is copied; branding and policy inherit the tenant defaults.",
      `${tenant.name} copy`,
    );
    if (!name || !name.trim()) return;
    try {
      const created = await api(
        `/tenants/${tenantId}/duplicate`,
        jsonBody("POST", { name: name.trim() }),
      );
      toast(`Duplicated into "${created.name}" with GUID ${created.guid}`);
      location.hash = `#/tenants/${created.id}`;
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.getElementById("rename-tenant").addEventListener("click", async () => {
    const name = prompt("New tenant name:", tenant.name);
    if (!name || !name.trim() || name.trim() === tenant.name) return;
    try {
      await api(`/tenants/${tenantId}`, jsonBody("PATCH", { name: name.trim() }));
      toast("Renamed");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.getElementById("delete-tenant").addEventListener("click", async () => {
    if (!confirm(`Delete tenant "${tenant.name}"? All GUIDs must already be revoked.`)) return;
    try {
      await api(`/tenants/${tenantId}`, { method: "DELETE" });
      toast("Tenant deleted");
      location.hash = "#/tenants";
    } catch (error) {
      toast(error.message, true);
    }
  });

  const body = document.getElementById("tab-body");
  if (tab === "rules") await renderRulesTab(body, tenantId, detail);
  else if (tab === "versions") await renderVersionsTab(body, tenantId);
  else if (tab === "branding") await renderBrandingTab(body, tenantId, detail);
  else if (tab === "policy") await renderPolicyTab(body, tenantId);
  else if (tab === "artifacts") await renderArtifactsTab(body, tenantId);
  else if (tab === "guids") await renderGuidsTab(body, tenantId);
}

function renderFindings(container, findings) {
  const target = container.querySelector("#findings");
  if (findings.length === 0) {
    target.innerHTML = '<div class="findings ok">All validation gates pass.</div>';
  } else {
    target.innerHTML = `<div class="findings"><strong>Findings:</strong>
      <ul>${findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div>`;
  }
}

/* Guided fields for the three delta keys that are plain string lists. The
   other two (add_phishing_indicators, raw_overrides) stay JSON under
   Advanced; the composed delta is always the source of truth. */
const DELTA_LIST_FIELDS = [
  [
    "add_exclusion_domain_patterns",
    "Exclusion domain patterns",
    "One regex per line; matching pages are excluded from scanning",
  ],
  [
    "add_trusted_login_patterns",
    "Trusted login patterns",
    "One regex per line; matching pages count as legitimate login pages",
  ],
  [
    "suppress_indicator_ids",
    "Suppressed upstream indicator ids",
    "One id per line; removes that upstream indicator for this tenant",
  ],
];

/* Turns a domain (or pasted URL) into the anchored regex the rules engine
   expects. Returns null when no plausible hostname can be extracted. */
function domainToPattern(input, includeSubdomains) {
  let host = input.trim().toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^\*\./, "").replace(/[/?#].*$/, "").replace(/\.+$/, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*$/.test(host)) return null;
  const escaped = host.replace(/\./g, "\\.");
  return includeSubdomains
    ? `^https://([^/]*\\.)?${escaped}(/.*)?$`
    : `^https://${escaped}(/.*)?$`;
}

/* Control characters (0-31, 127) plus the replacement character (65533),
   spelled via charCode so no literal control bytes live in this file. */
const JUNK_CHARS = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    String.fromCharCode(65533) +
    "]",
  "g",
);

/* Splits one-pattern-per-line input, stripping control characters and the
   replacement character. Registry exports (the GPO migration tool, pasted
   .reg values) carry trailing NUL terminators that render as an invisible
   or replacement character and silently break pattern matching. */
function patternLines(text) {
  return text
    .split("\n")
    .map((line) => line.replace(JUNK_CHARS, "").trim())
    .filter(Boolean);
}

/* Recursively strips the same junk from every string in an imported JSON
   object (keys and values), so a dirty export cleans on adoption. */
function cleanImportedValue(value) {
  if (typeof value === "string") {
    return value.replace(JUNK_CHARS, "").trim();
  }
  if (Array.isArray(value)) return value.map(cleanImportedValue);
  if (value !== null && typeof value === "object") {
    const cleaned = {};
    for (const [key, entry] of Object.entries(value)) {
      cleaned[cleanImportedValue(key)] = cleanImportedValue(entry);
    }
    return cleaned;
  }
  return value;
}

/* Strict-enough client parse: the delta must be a JSON object. */
function parseDeltaText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function renderRulesTab(container, tenantId, detail) {
  const storedText = detail.draft ? detail.draft.draft_json : "{}";
  const storedDelta = parseDeltaText(storedText);
  // Saved-draft state feeding the effect summary; updated after each save.
  let savedDelta = detail.draft ? storedDelta : null;
  let dirty = false;
  // Guided mode needs a parseable object to decompose; raw is the fallback.
  let mode = storedDelta !== null ? "guided" : "raw";

  const listKeys = DELTA_LIST_FIELDS.map(([key]) => key);
  const advancedInitial = {};
  for (const [key, value] of Object.entries(storedDelta ?? {})) {
    if (!listKeys.includes(key)) advancedInitial[key] = value;
  }
  const hasAdvanced = Object.keys(advancedInitial).length > 0;

  let rawText = storedText;
  try {
    rawText = JSON.stringify(JSON.parse(storedText), null, 2);
  } catch {
    /* show as stored */
  }

  const guidedFields = DELTA_LIST_FIELDS.map(
    ([key, label, hint]) => `<label class="field">
      <span>${esc(label)} <span class="mono">${esc(key)}</span><br>
        <span class="muted">${esc(hint)}</span></span>
      <textarea id="d-${esc(key)}" class="lines" spellcheck="false">${esc(
        Array.isArray(storedDelta?.[key]) ? storedDelta[key].join("\n") : "",
      )}</textarea>
    </label>`,
  ).join("");

  container.innerHTML = `
    <div class="panel">
      <p class="muted">The delta layers onto the upstream rules at publish:
        patterns and indicators append, suppressed ids remove upstream
        indicators, raw overrides deep-merge last. The instance baseline
        delta (Settings page) applies beneath all of it.</p>
      <div id="guided" ${mode === "raw" ? "hidden" : ""}>
        <div class="easy-add">
          <strong>Easy add</strong>
          <span class="muted">builds the pattern regex from a plain domain,
            no regex knowledge needed</span>
          <div class="row" style="align-items:center;flex-wrap:wrap;margin-top:8px">
            <input type="text" id="pb-domain" placeholder="training.knowbe4.com or a full URL" style="flex:1;min-width:220px">
            <label class="check"><input type="checkbox" id="pb-subs" checked> include subdomains</label>
            <select id="pb-target">
              <option value="add_exclusion_domain_patterns">as exclusion pattern</option>
              <option value="add_trusted_login_patterns">as trusted login pattern</option>
            </select>
            <button id="pb-add" class="primary small">Add</button>
          </div>
        </div>
        ${guidedFields}
        <details id="advanced-block" ${hasAdvanced ? "open" : ""}>
          <summary>Advanced: added indicators and raw overrides (JSON:
            <span class="mono">add_phishing_indicators, raw_overrides</span>)</summary>
          <textarea id="d-advanced" class="tall" spellcheck="false">${esc(
            JSON.stringify(advancedInitial, null, 2),
          )}</textarea>
        </details>
      </div>
      <textarea id="draft" class="tall" spellcheck="false" ${
        mode === "guided" ? "hidden" : ""
      }>${esc(rawText)}</textarea>
      <div class="row" style="margin-top:6px">
        <button id="toggle-mode" class="ghost small">${
          mode === "guided" ? "Edit raw JSON" : "Guided editor"
        }</button>
      </div>
      <div id="effect"></div>
      <div id="findings"></div>
      <div class="row" style="margin-top:10px">
        <button id="save-draft">Save and validate</button>
        <button id="publish" class="primary">Publish</button>
        <span class="muted" id="last-saved">${
          detail.draft
            ? `Last saved ${fmtTime(detail.draft.updated_at)} by ${esc(detail.draft.updated_by)}`
            : "No draft saved yet"
        }</span>
      </div>
    </div>`;

  const el = (id) => container.querySelector(`#${id}`);

  // Composes the delta from whichever editor is active. Throws with a
  // user-facing message when JSON is involved and broken.
  const composeDelta = () => {
    if (mode === "raw") {
      const parsed = parseDeltaText(el("draft").value);
      if (parsed === null) throw new Error("draft is not a valid JSON object");
      return parsed;
    }
    const advancedText = el("d-advanced").value.trim();
    const advanced = advancedText === "" ? {} : parseDeltaText(advancedText);
    if (advanced === null) {
      throw new Error("the Advanced JSON is not a valid object");
    }
    const delta = { ...advanced };
    for (const [key] of DELTA_LIST_FIELDS) {
      const lines = el(`d-${key}`)
        .value.split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      if (lines.length > 0) delta[key] = lines;
      else delete delta[key];
    }
    return delta;
  };

  /* Effect summary: what the SAVED draft contains and how it differs from
     the currently published version's frozen delta. Editors change nothing
     here until saved; that is the point. */
  const publishedDelta = detail.current_version
    ? parseDeltaText(detail.current_version.delta_json)
    : null;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const listDiff = (saved, published) => {
    const savedSet = new Set(saved);
    const publishedSet = new Set(published);
    return {
      added: saved.filter((item) => !publishedSet.has(item)),
      removed: published.filter((item) => !savedSet.has(item)),
    };
  };
  const renderEffect = () => {
    const target = el("effect");
    if (savedDelta === null) {
      target.innerHTML = `<p class="muted">No saved draft: publishing uses an
        empty delta, so this tenant gets the upstream rules plus the instance
        baseline only.</p>`;
      return;
    }
    const listOf = (key) => (Array.isArray(savedDelta[key]) ? savedDelta[key] : []);
    const overrideCount =
      savedDelta.raw_overrides !== null &&
      typeof savedDelta.raw_overrides === "object"
        ? Object.keys(savedDelta.raw_overrides).length
        : 0;
    const parts = [
      plural(listOf("add_exclusion_domain_patterns").length, "exclusion pattern"),
      plural(listOf("add_trusted_login_patterns").length, "trusted login pattern"),
      plural(listOf("suppress_indicator_ids").length, "suppressed indicator id"),
      plural(listOf("add_phishing_indicators").length, "added indicator"),
      overrideCount > 0 ? `raw overrides on ${plural(overrideCount, "key")}` : "no raw overrides",
    ];

    let vsPublished;
    if (detail.current_version === null) {
      vsPublished = "Never published: publishing creates v1 from this draft.";
    } else if (publishedDelta === null) {
      vsPublished = "";
    } else {
      const versionNumber = detail.current_version.version_number;
      const diffs = [];
      for (const [key, , label] of [
        ["add_exclusion_domain_patterns", 0, "exclusion pattern"],
        ["add_trusted_login_patterns", 0, "trusted login pattern"],
        ["suppress_indicator_ids", 0, "suppressed id"],
      ]) {
        const published = Array.isArray(publishedDelta[key]) ? publishedDelta[key] : [];
        const { added, removed } = listDiff(listOf(key), published);
        if (added.length > 0) {
          diffs.push(
            `<span title="${esc(added.join("\n"))}">+${plural(added.length, label)}</span>`,
          );
        }
        if (removed.length > 0) {
          diffs.push(
            `<span title="${esc(removed.join("\n"))}">-${plural(removed.length, label)}</span>`,
          );
        }
      }
      for (const [key, label] of [
        ["add_phishing_indicators", "added indicators"],
        ["raw_overrides", "raw overrides"],
      ]) {
        if (JSON.stringify(savedDelta[key] ?? null) !== JSON.stringify(publishedDelta[key] ?? null)) {
          diffs.push(`${label} changed`);
        }
      }
      vsPublished =
        diffs.length > 0
          ? `Vs published v${esc(versionNumber)}: ${diffs.join(", ")}. Hover a count for the items.`
          : `No differences from published v${esc(versionNumber)}: publishing would mint an identical new version.`;
    }
    target.innerHTML = `<p class="muted">Saved draft: ${parts.join(", ")}.<br>
      ${vsPublished}${dirty ? '<br><span class="badge warn">unsaved edits</span> the summary and Publish use the last saved draft' : ""}</p>`;
  };
  renderEffect();

  // Any edit anywhere marks the draft dirty until the next successful save.
  for (const id of ["draft", "d-advanced", ...listKeys.map((key) => `d-${key}`)]) {
    el(id).addEventListener("input", () => {
      if (!dirty) {
        dirty = true;
        renderEffect();
      }
    });
  }

  el("pb-add").addEventListener("click", () => {
    const pattern = domainToPattern(el("pb-domain").value, el("pb-subs").checked);
    if (pattern === null) {
      toast("Enter a domain like training.knowbe4.com (or paste a URL)", true);
      return;
    }
    const target = el(`d-${el("pb-target").value}`);
    const lines = target.value.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.includes(pattern)) {
      toast("That pattern is already in the list", true);
      return;
    }
    lines.push(pattern);
    target.value = lines.join("\n");
    // Reuse the input listener so the dirty flag and summary update.
    target.dispatchEvent(new Event("input"));
    el("pb-domain").value = "";
    toast(`Added ${pattern}`);
  });
  el("pb-domain").addEventListener("keydown", (event) => {
    if (event.key === "Enter") el("pb-add").click();
  });

  el("toggle-mode").addEventListener("click", () => {
    if (mode === "guided") {
      let composed;
      try {
        composed = composeDelta();
      } catch (error) {
        toast(error.message, true);
        return;
      }
      el("draft").value = JSON.stringify(composed, null, 2);
      mode = "raw";
    } else {
      const parsed = parseDeltaText(el("draft").value);
      if (parsed === null) {
        toast("Fix the JSON first: the guided editor needs a valid object", true);
        return;
      }
      for (const [key] of DELTA_LIST_FIELDS) {
        el(`d-${key}`).value = Array.isArray(parsed[key]) ? parsed[key].join("\n") : "";
      }
      const advanced = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (!listKeys.includes(key)) advanced[key] = value;
      }
      el("d-advanced").value = JSON.stringify(advanced, null, 2);
      if (Object.keys(advanced).length > 0) {
        el("advanced-block").setAttribute("open", "");
      }
      mode = "guided";
    }
    el("guided").hidden = mode === "raw";
    el("draft").hidden = mode === "guided";
    el("toggle-mode").textContent = mode === "guided" ? "Edit raw JSON" : "Guided editor";
  });

  el("save-draft").addEventListener("click", async () => {
    let delta;
    try {
      delta = composeDelta();
    } catch (error) {
      renderFindings(container, [error.message]);
      return;
    }
    try {
      const result = await api(`/tenants/${tenantId}/rules`, jsonBody("PUT", { delta }));
      renderFindings(container, result.findings);
      toast(result.valid ? "Draft saved, gates pass" : "Draft saved with findings", !result.valid);
      savedDelta = delta;
      dirty = false;
      el("last-saved").textContent = `Last saved ${fmtTime(new Date().toISOString())} by ${
        onboardingStatus ? onboardingStatus.operator_email : "you"
      }`;
      renderEffect();
    } catch (error) {
      toast(error.message, true);
    }
  });

  el("publish").addEventListener("click", async () => {
    const message = dirty
      ? "You have unsaved edits. Publish uses the last SAVED draft, not what is in the editor. Publish the saved draft anyway?"
      : "Publish the saved draft for this tenant?";
    if (!confirm(message)) return;
    try {
      const result = await api(`/tenants/${tenantId}/publish`, { method: "POST" });
      toast(`Published version ${result.versionNumber}`);
      location.hash = `#/tenants/${tenantId}/versions`;
    } catch (error) {
      renderFindings(container, (error.body && error.body.errors) || [error.message]);
      toast("Publish blocked by validation gates", true);
    }
  });
}

async function renderVersionsTab(container, tenantId) {
  const data = await api(`/tenants/${tenantId}/versions`);
  const rows = data.versions
    .map((version) => {
      const isCurrent = version.id === data.current_version_id;
      return `<tr>
        <td><strong>v${esc(version.version_number)}</strong>${isCurrent ? ' <span class="badge good">current</span>' : ""}</td>
        <td>${esc(fmtTime(version.created_at))}<br><span class="muted">${esc(version.created_by)}</span></td>
        <td class="mono">${esc(version.etag.slice(0, 12))}</td>
        <td>${esc(version.upstream_version || "")}<br><span class="muted">${esc(version.upstream_diff || "")}</span></td>
        <td>${esc(version.note || "")}</td>
        <td>${
          isCurrent
            ? ""
            : `<button class="small" data-rollback="${esc(version.id)}" data-vnum="${esc(version.version_number)}">Roll back to this</button>`
        }</td>
      </tr>`;
    })
    .join("");
  container.innerHTML = `
    <div class="panel">
      <table>
        <thead><tr><th>Version</th><th>Published</th><th>ETag</th><th>Upstream base</th><th>Note</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">Nothing published yet.</td></tr>'}</tbody>
      </table>
    </div>`;
  container.querySelectorAll("[data-rollback]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm(`Roll back to version ${button.getAttribute("data-vnum")}?`)) return;
      try {
        await api(`/tenants/${tenantId}/rollback/${button.getAttribute("data-rollback")}`, {
          method: "POST",
        });
        toast("Rolled back");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/* Text input with an inherited hint: when the tenant value is blank and an
   instance default exists, the default shows as the placeholder with an
   "inherited" badge so an override is distinguishable from a default. */
function brandingField(id, label, value, inherited) {
  const showHint = !value && inherited;
  return `<label class="field"><span>${esc(label)}${
    showHint ? ' <span class="badge">inherited</span>' : ""
  }</span><input type="text" id="${esc(id)}" value="${esc(value)}" placeholder="${esc(inherited || "")}"></label>`;
}

async function renderBrandingTab(container, tenantId, detail) {
  const data = await api(`/tenants/${tenantId}/branding`);
  const branding = data.branding;
  const defaults = data.defaults || {};
  const hasDefaults = Object.keys(defaults).length > 0 || data.default_logo;
  const activeGuid = (detail.guids.find((g) => g.status === "active") || {}).guid;
  let logoHtml;
  if (branding.logo_r2_key) {
    logoHtml = `<img class="logo-preview" alt="Tenant logo" src="/assets/${esc(activeGuid)}/logo?ts=${Date.now()}">`;
  } else if (data.default_logo && activeGuid) {
    logoHtml = `<img class="logo-preview" alt="Inherited default logo" src="/assets/${esc(activeGuid)}/logo?ts=${Date.now()}">
      <p class="muted"><span class="badge">inherited</span> No tenant logo uploaded; the instance
      default logo (Settings page) is served instead.</p>`;
  } else {
    logoHtml = '<p class="muted">No logo uploaded. Check recommends 48x48, maximum 128x128.</p>';
  }

  container.innerHTML = `
    <div class="panel">
      ${
        hasDefaults
          ? '<p class="muted">Blank fields inherit the tenant defaults from the Settings page.</p>'
          : ""
      }
      <div class="grid2">
        ${brandingField("b-company", "Company name", branding.company_name, defaults.company_name)}
        ${brandingField("b-product", "Product name", branding.product_name, defaults.product_name)}
        ${brandingField("b-email", "Support email", branding.support_email, defaults.support_email)}
        ${brandingField("b-support", "Support URL", branding.support_url, defaults.support_url)}
        ${brandingField("b-privacy", "Privacy policy URL", branding.privacy_policy_url, defaults.privacy_policy_url)}
        ${brandingField("b-about", "About URL", branding.about_url, defaults.about_url)}
        ${brandingField("b-color", "Primary color", branding.primary_color, defaults.primary_color)}
        <label class="field"><span>Logo (png, jpg, or svg; 512 KB max)</span><input type="file" id="b-logo" accept="image/png,image/jpeg,image/svg+xml"></label>
      </div>
      ${logoHtml}
      <div class="row" style="margin-top:12px">
        <button id="save-branding" class="primary">Save branding</button>
        ${branding.logo_r2_key ? '<button id="remove-logo" class="danger">Remove logo</button>' : ""}
      </div>
    </div>`;

  container.querySelector("#save-branding").addEventListener("click", async () => {
    const form = new FormData();
    form.set("company_name", container.querySelector("#b-company").value);
    form.set("product_name", container.querySelector("#b-product").value);
    form.set("support_email", container.querySelector("#b-email").value);
    form.set("support_url", container.querySelector("#b-support").value);
    form.set("privacy_policy_url", container.querySelector("#b-privacy").value);
    form.set("about_url", container.querySelector("#b-about").value);
    form.set("primary_color", container.querySelector("#b-color").value);
    const file = container.querySelector("#b-logo").files[0];
    if (file) form.set("logo", file);
    try {
      await api(`/tenants/${tenantId}/branding`, { method: "PUT", body: form });
      toast("Branding saved");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });
  const removeButton = container.querySelector("#remove-logo");
  if (removeButton) {
    removeButton.addEventListener("click", async () => {
      try {
        await api(`/tenants/${tenantId}/branding`, jsonBody("PUT", { remove_logo: true }));
        toast("Logo removed");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }
}

/* Hardcoded fallbacks mirroring resolvePolicy in src/lib/artifacts.ts. With
   the instance tenant defaults layered on top these form the "default layer":
   a saved value equal to its default-layer value is stored as inherited
   (the key is omitted), so it follows future default changes. */
const POLICY_FALLBACKS = {
  enablePageBlocking: true,
  showNotifications: true,
  enableValidPageBadge: true,
  enableDebugLogging: false,
  validPageBadgeTimeout: 5,
  updateInterval: 24,
  urlAllowlist: [],
  domainSquatting: { enabled: true, deviationThreshold: 2, Action: "block" },
  genericWebhook: {
    enabled: true,
    events: ["false_positive_report", "page_blocked", "threat_detected"],
  },
  enableCippReporting: false,
  cippServerUrl: "",
  cippTenantId: "",
};

async function renderPolicyTab(container, tenantId) {
  const data = await api(`/tenants/${tenantId}/policy`);
  const s = data.settings;
  const defaults = data.defaults || {};
  const layer = { ...POLICY_FALLBACKS, ...defaults };
  const eff = (key) => (s[key] === undefined ? layer[key] : s[key]);
  const inh = (key) =>
    s[key] === undefined && defaults[key] !== undefined
      ? ' <span class="badge">inherited</span>'
      : "";
  const squat = eff("domainSquatting") || {};
  const webhook = eff("genericWebhook") || {};
  const check = (value) => (value ? "checked" : "");

  container.innerHTML = `
    <div class="panel">
      <p class="muted"><span class="badge accent">deployed with policy</span>
        Everything on this tab ships inside the deployment artifacts (reg
        files, GPO script, RMM script, Intune variables, CIPP fields,
        policies.json), not fetched from this service. Deployed browsers pick
        up changes here only when that policy is re-pushed; the Rules draft
        is the opposite, fetched remotely on the update interval.</p>
      ${
        Object.keys(defaults).length > 0
          ? `<p class="muted">Fields marked <span class="badge">inherited</span> follow the
            tenant defaults on the Settings page. Saving keeps a field inherited while its
            value still matches the default; change the value to override it.</p>`
          : ""
      }
      <h2 style="margin-top:0">Extension behavior</h2>
      <label class="check"><input type="checkbox" id="p-block" ${check(eff("enablePageBlocking"))}> Enable page blocking${inh("enablePageBlocking")}</label>
      <label class="check"><input type="checkbox" id="p-notify" ${check(eff("showNotifications"))}> Show notifications${inh("showNotifications")}</label>
      <label class="check"><input type="checkbox" id="p-badge" ${check(eff("enableValidPageBadge"))}> Valid page badge${inh("enableValidPageBadge")}</label>
      <label class="check"><input type="checkbox" id="p-debug" ${check(eff("enableDebugLogging"))}> Debug logging</label>
      <div class="grid2">
        <label class="field"><span>Badge timeout (seconds)${inh("validPageBadgeTimeout")}</span><input type="number" id="p-badge-timeout" value="${esc(eff("validPageBadgeTimeout"))}"></label>
        <label class="field"><span>Rules update interval (hours)${inh("updateInterval")}</span><input type="number" id="p-interval" value="${esc(eff("updateInterval"))}"></label>
      </div>
      <label class="field"><span>URL allowlist (one pattern per line, e.g. https://training.knowbe4.com/*)${inh("urlAllowlist")}</span>
        <textarea id="p-allowlist">${esc((eff("urlAllowlist") || []).join("\n"))}</textarea></label>

      <h2>Domain squatting${inh("domainSquatting")}</h2>
      <label class="check"><input type="checkbox" id="p-squat" ${check(squat.enabled)}> Enable domain squatting detection</label>
      <div class="grid2">
        <label class="field"><span>Deviation threshold</span><input type="number" id="p-squat-threshold" value="${esc(squat.deviationThreshold ?? 2)}"></label>
        <label class="field"><span>Action (block or warn)</span><input type="text" id="p-squat-action" value="${esc(squat.Action ?? "block")}"></label>
      </div>

      <h2>Webhook reporting (to this service)${inh("genericWebhook")}</h2>
      <label class="check"><input type="checkbox" id="p-webhook" ${check(webhook.enabled)}> Send events to the tenant hook URL</label>
      <label class="field"><span>Events (comma separated)</span>
        <input type="text" id="p-webhook-events" value="${esc((webhook.events || POLICY_FALLBACKS.genericWebhook.events).join(", "))}"></label>

      <h2>CIPP reporting${inh("enableCippReporting")}</h2>
      <label class="check"><input type="checkbox" id="p-cipp" ${check(eff("enableCippReporting"))}> Enable CIPP reporting</label>
      <div class="grid2">
        <label class="field"><span>CIPP server URL (blank uses the instance default)</span><input type="text" id="p-cipp-url" value="${esc(s.cippServerUrl || "")}"></label>
        <label class="field"><span>CIPP tenant id / domain (needed to attribute events when deploying outside the CIPP standard, which fills it per tenant)</span><input type="text" id="p-cipp-tenant" value="${esc(s.cippTenantId || "")}"></label>
      </div>
      <button id="save-policy" class="primary">Save policy settings</button>
    </div>`;

  container.querySelector("#save-policy").addEventListener("click", async () => {
    const settings = {
      enablePageBlocking: container.querySelector("#p-block").checked,
      showNotifications: container.querySelector("#p-notify").checked,
      enableValidPageBadge: container.querySelector("#p-badge").checked,
      enableDebugLogging: container.querySelector("#p-debug").checked,
      validPageBadgeTimeout: Number(container.querySelector("#p-badge-timeout").value) || 5,
      updateInterval: Number(container.querySelector("#p-interval").value) || 24,
      urlAllowlist: patternLines(container.querySelector("#p-allowlist").value),
      domainSquatting: {
        enabled: container.querySelector("#p-squat").checked,
        deviationThreshold: Number(container.querySelector("#p-squat-threshold").value) || 2,
        Action: container.querySelector("#p-squat-action").value.trim() || "block",
      },
      genericWebhook: {
        enabled: container.querySelector("#p-webhook").checked,
        events: container
          .querySelector("#p-webhook-events")
          .value.split(",")
          .map((event) => event.trim())
          .filter(Boolean),
      },
      enableCippReporting: container.querySelector("#p-cipp").checked,
      cippServerUrl: container.querySelector("#p-cipp-url").value.trim(),
      cippTenantId: container.querySelector("#p-cipp-tenant").value.trim(),
    };
    // Normalize on save: a value equal to its default-layer value stays
    // inherited (key omitted) instead of being frozen as an override.
    for (const key of Object.keys(settings)) {
      if (JSON.stringify(settings[key]) === JSON.stringify(layer[key])) {
        delete settings[key];
      }
    }
    try {
      await api(`/tenants/${tenantId}/policy`, jsonBody("PUT", { settings }));
      toast("Policy settings saved");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function artifactSection(key, title, description, content, filename, mime) {
  artifactStore.set(key, content);
  return `<h2>${esc(title)}</h2>
    <p class="muted">${esc(description)}</p>
    <div class="row" style="margin-bottom:6px">
      <button class="small" data-copy-key="${esc(key)}">Copy</button>
      <button class="small" data-download-key="${esc(key)}" data-filename="${esc(filename)}" data-mime="${esc(mime)}">Download</button>
    </div>
    <pre class="code">${esc(content)}</pre>`;
}

async function renderArtifactsTab(container, tenantId) {
  let data;
  try {
    data = await api(`/tenants/${tenantId}/artifacts`);
  } catch (error) {
    container.innerHTML = `<div class="panel"><strong>Cannot generate artifacts:</strong> ${esc(error.message)}</div>`;
    return;
  }
  const artifacts = data.artifacts;
  artifactStore.clear();

  const managedJson = JSON.stringify(artifacts.chrome_managed_storage, null, 2);
  const firefoxFragment = JSON.stringify(artifacts.firefox_fragment, null, 2);
  const firefoxFull = JSON.stringify(artifacts.firefox_policies_full, null, 2);
  const cippTable = artifacts.cipp_fields
    .map((row) => `<tr><td>${esc(row.field)}</td><td class="mono">${esc(row.value)}</td></tr>`)
    .join("");

  container.innerHTML = `
    <div class="panel">
      <dl class="kv">
        <dt>Config URL</dt><dd class="mono">${esc(artifacts.config_url)}</dd>
        <dt>Webhook URL</dt><dd class="mono">${esc(artifacts.hook_url)}</dd>
        <dt>Logo URL</dt><dd class="mono">${esc(artifacts.logo_url || "(no logo uploaded)")}</dd>
        <dt>GUID in use</dt><dd class="mono">${esc(artifacts.guid)}</dd>
      </dl>
    </div>
    ${(artifacts.warnings || [])
      .map(
        (warning) =>
          `<div class="panel"><span class="badge warn">warning</span> ${esc(warning)}</div>`,
      )
      .join("")}
    <div class="panel">
      ${artifactSection(
        "managed",
        "Chrome and Edge managed storage JSON",
        "Paste into the 3rdparty extension policy for Chrome (benimdeioplgkhanklclahllklceahbe) and Edge (knepjpocdagponkonnbggpcnhnaikajg), or into your RMM.",
        managedJson,
        "check-managed-storage.json",
        "application/json",
      )}
      ${artifactSection(
        "firefox-fragment",
        "Firefox policies.json fragment",
        "Merge into an existing distribution/policies.json under policies.",
        firefoxFragment,
        "check-firefox-fragment.json",
        "application/json",
      )}
      ${artifactSection(
        "firefox-full",
        "Firefox policies.json (full, with force-install)",
        "Drop-in distribution/policies.json. Fill install_url with your XPI source per the Check docs.",
        firefoxFull,
        "policies.json",
        "application/json",
      )}
      ${artifactSection(
        "reg-chrome",
        "Registry file: Chrome",
        "Import on managed Windows devices, then run gpupdate /force.",
        artifacts.reg_chrome,
        "check-chrome-policy.reg",
        "text/plain",
      )}
      ${artifactSection(
        "reg-edge",
        "Registry file: Edge",
        "Import on managed Windows devices, then run gpupdate /force.",
        artifacts.reg_edge,
        "check-edge-policy.reg",
        "text/plain",
      )}
      ${artifactSection(
        "gpo-script",
        "GPO creation script (Chrome and Edge)",
        "Run on a domain-joined management host with RSAT to create or update a GPO carrying every value from the registry files above. The script prints the New-GPLink command to run when you are ready to link it. Import Check's ADMX templates once per domain (central store) so the values are readable in the Group Policy Management Editor.",
        artifacts.gpo_script,
        "check-gpo-script.ps1",
        "text/plain",
      )}
      <p class="muted">ADMX templates (upstream, pinned):
        <a href="https://github.com/CyberDrain/Check/blob/v1.1.0/enterprise/admx/Check-Extension.admx" target="_blank" rel="noreferrer">Check-Extension.admx</a> &middot;
        <a href="https://github.com/CyberDrain/Check/blob/v1.1.0/enterprise/admx/en-US/Check-Extension.adml" target="_blank" rel="noreferrer">Check-Extension.adml</a> &middot;
        <a href="https://docs.check.tech/deployment/chrome-edge-deployment-instructions/windows/domain-deployment" target="_blank" rel="noreferrer">Domain deployment docs</a></p>
      <h2>RMM deployment script</h2>
      <p class="muted">Ready-made PowerShell for RMM deployment on Windows endpoints
        (run as SYSTEM): force-installs the extension, pins it to the toolbar, and
        writes this tenant's full policy and branding for the selected browsers.
        The checkboxes preset the toggle variables at the top of the script, so
        the choice stays editable after download. Firefox needs install_url
        filled in per the Check docs before its block is useful.</p>
      <div class="row" style="margin-bottom:6px">
        <label class="check"><input type="checkbox" id="rmm-chrome" checked> Chrome</label>
        <label class="check"><input type="checkbox" id="rmm-edge" checked> Edge</label>
        <label class="check"><input type="checkbox" id="rmm-firefox" checked> Firefox</label>
      </div>
      <div class="row" style="margin-bottom:6px">
        <button class="small" data-copy-key="rmm">Copy</button>
        <button class="small" data-download-key="rmm" data-filename="check-rmm-deploy.ps1" data-mime="text/plain">Download</button>
      </div>
      <pre class="code" id="rmm-pre">${esc(artifacts.rmm_script)}</pre>
      ${artifactSection(
        "intune",
        "Intune variable block (Check Setup script)",
        "Paste these values into Check's Setup-Windows-Chrome-and-Edge.ps1 workflow, then package per the Check docs.",
        artifacts.intune_variables,
        "check-intune-variables.ps1",
        "text/plain",
      )}
      <h2>CIPP standard field values</h2>
      <p class="muted">Enter these values in CIPP's Check deployment standard for this tenant.</p>
      <table><thead><tr><th>CIPP standard field</th><th>Value</th></tr></thead><tbody>${cippTable}</tbody></table>
    </div>`;

  // The RMM script ships three $Include* toggles defaulted to $true; the
  // checkboxes rewrite those lines in the stored copy so Copy and Download
  // carry the selection while the script text stays operator-editable.
  const rmmToggles = [
    ["rmm-chrome", "$IncludeChrome"],
    ["rmm-edge", "$IncludeEdge"],
    ["rmm-firefox", "$IncludeFirefox"],
  ];
  const updateRmmScript = () => {
    let script = artifacts.rmm_script;
    for (const [id, variable] of rmmToggles) {
      const checked = container.querySelector(`#${id}`).checked;
      script = script.replace(
        `${variable} = $true`,
        `${variable} = ${checked ? "$true" : "$false"}`,
      );
    }
    artifactStore.set("rmm", script);
    container.querySelector("#rmm-pre").textContent = script;
  };
  for (const [id] of rmmToggles) {
    container.querySelector(`#${id}`).addEventListener("change", updateRmmScript);
  }
  updateRmmScript();
}

async function renderGuidsTab(container, tenantId) {
  const data = await api(`/tenants/${tenantId}/guids`);
  const rows = data.guids
    .map(
      (guid) => `<tr>
      <td class="mono">${esc(guid.guid)}</td>
      <td>${
        guid.status === "active"
          ? '<span class="badge good">active</span>'
          : `<span class="badge bad">revoked ${esc(fmtTime(guid.revoked_at))}</span>`
      }</td>
      <td>${esc(guid.label || "")}</td>
      <td>${esc(guid.fetch_hits)} fetches<br><span class="muted">last ${esc(ago(guid.last_fetch_at))}</span></td>
      <td>${guid.revoked_hits > 0 ? `<span class="badge bad">${esc(guid.revoked_hits)} hits after revoke</span>` : ""}</td>
      <td>${
        guid.status === "active"
          ? `<button class="small danger" data-revoke="${esc(guid.guid)}">Revoke</button>`
          : ""
      }</td>
    </tr>`,
    )
    .join("");

  container.innerHTML = `
    <div class="panel">
      <div class="row spread" style="margin-bottom:10px">
        <p class="muted" style="margin:0">Rotation mints a new GUID while the old one keeps serving.
          Revoke the old GUID once every client policy points at the new one.</p>
        <button id="rotate" class="primary">Rotate (mint new GUID)</button>
      </div>
      <table>
        <thead><tr><th>GUID</th><th>Status</th><th>Label</th><th>Traffic</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  container.querySelector("#rotate").addEventListener("click", async () => {
    const label = prompt("Label for the rotation (optional):", "");
    if (label === null) return;
    try {
      const created = await api(`/tenants/${tenantId}/guids`, jsonBody("POST", { label }));
      toast(`New GUID ${created.guid}`);
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });
  container.querySelectorAll("[data-revoke]").forEach((button) => {
    button.addEventListener("click", async () => {
      const guid = button.getAttribute("data-revoke");
      if (!confirm(`Revoke ${guid}? Clients still using it get 404 immediately.`)) return;
      try {
        await api(`/guids/${guid}/revoke`, { method: "POST" });
        toast("GUID revoked");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/* ---------- webhook inbox ---------- */

async function renderEvents() {
  const statusFilter = renderEvents.filter || "new";
  const query = statusFilter === "all" ? "" : `?status=${statusFilter}`;
  const data = await api(`/events${query}`);

  const items = data.events
    .map((event) => {
      let pretty = event.payload_json;
      try {
        pretty = JSON.stringify(JSON.parse(event.payload_json), null, 2);
      } catch {
        /* keep raw string; it is escaped below either way */
      }
      return `<details class="event panel">
        <summary>
          <span class="badge ${event.status === "new" ? "accent" : ""}">${esc(event.status)}</span>
          <strong>${esc(event.event_type)}</strong>
          from ${esc(event.tenant_name || event.tenant_id)}
          <span class="muted">${esc(fmtTime(event.received_at))}</span>
        </summary>
        <pre class="code">${esc(pretty)}</pre>
        <div class="row">
          <button class="small" data-disposition="reviewed" data-event="${esc(event.id)}">Mark reviewed</button>
          <button class="small" data-disposition="dismissed" data-event="${esc(event.id)}">Dismiss</button>
        </div>
      </details>`;
    })
    .join("");

  view.innerHTML = `
    <div class="row spread">
      <h1>Webhook inbox</h1>
      <select id="event-filter" style="width:auto">
        ${["new", "reviewed", "dismissed", "all"]
          .map(
            (option) =>
              `<option value="${option}" ${option === statusFilter ? "selected" : ""}>${option}</option>`,
          )
          .join("")}
      </select>
    </div>
    <p class="muted">Payloads are stored verbatim and rendered escaped; they are never interpreted.</p>
    ${items || '<div class="panel muted">No events match this filter.</div>'}`;

  document.getElementById("event-filter").addEventListener("change", (event) => {
    renderEvents.filter = event.target.value;
    route();
  });
  view.querySelectorAll("[data-disposition]").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(
          "/events",
          jsonBody("PATCH", {
            id: button.getAttribute("data-event"),
            status: button.getAttribute("data-disposition"),
          }),
        );
        toast("Event updated");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

/* ---------- upstream ---------- */

async function renderUpstream() {
  const data = await api("/upstream");
  const rows = data.snapshots
    .map(
      (snapshot) => `<tr>
      <td>${esc(fmtTime(snapshot.fetched_at))}</td>
      <td>${esc(snapshot.upstream_version || "")}</td>
      <td><span class="badge ${
        snapshot.status === "active" ? "good" : snapshot.status === "failed_validation" ? "bad" : ""
      }">${esc(snapshot.status)}</span></td>
      <td class="mono">${esc(snapshot.hash.slice(0, 12))}</td>
      <td>${esc(snapshot.diff_summary || "")}</td>
    </tr>`,
    )
    .join("");

  view.innerHTML = `
    <div class="row spread">
      <h1>Upstream sync</h1>
      <button id="sync-now" class="primary">Sync now</button>
    </div>
    <div class="panel">
      ${
        data.active
          ? `<dl class="kv">
              <dt>Active snapshot</dt><dd class="mono">${esc(data.active.id)}</dd>
              <dt>Upstream version</dt><dd>${esc(data.active.upstream_version || "unknown")}</dd>
              <dt>Fetched</dt><dd>${esc(fmtTime(data.active.fetched_at))}</dd>
              <dt>Diff vs previous</dt><dd>${esc(data.active.diff_summary || "")}</dd>
            </dl>`
          : '<p class="muted"><strong>No active snapshot yet.</strong> Run a sync before publishing tenants.</p>'
      }
    </div>
    <h2>Snapshot history</h2>
    <div class="panel">
      <table>
        <thead><tr><th>Fetched</th><th>Version</th><th>Status</th><th>Hash</th><th>Diff summary</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No snapshots yet.</td></tr>'}</tbody>
      </table>
    </div>`;

  document.getElementById("sync-now").addEventListener("click", async () => {
    const button = document.getElementById("sync-now");
    button.disabled = true;
    button.textContent = "Syncing...";
    try {
      const outcome = await api("/upstream", { method: "POST" });
      if (outcome.status === "updated") {
        toast(`Updated: ${outcome.diffSummary}; republished ${outcome.republished} tenants`);
      } else if (outcome.status === "unchanged") {
        toast("Upstream unchanged");
      } else {
        toast(`Sync ${outcome.status}: ${(outcome.errors || []).join("; ")}`, true);
      }
      route();
    } catch (error) {
      toast(error.message, true);
      route();
    }
  });
}

/* ---------- instance settings ---------- */

const SETTING_LABELS = [
  ["public_base_url", "Public base URL (e.g. https://check.example.com; used in every generated artifact)"],
  ["default_cipp_server_url", "Default CIPP server URL (blank disables CIPP unless a tenant overrides)"],
  ["false_positive_relay_url", "False positive relay URL (every inbound webhook report is POSTed here as JSON; for n8n, Power Automate, and similar; blank disables)"],
  ["upstream_source_url", "Upstream rules source URL"],
  ["version_suffix_label", "Version suffix label (published versions read upstream+label.n)"],
  ["metrics_retention_days", "Fetch metrics retention (days)"],
  ["webhook_retention_days", "Webhook event retention (days)"],
  ["stale_fetch_hours", "Stale fetch warning threshold (hours)"],
  ["upstream_keep_snapshots", "Upstream snapshots to keep"],
];

/* Branding fields shared by the Tenant defaults panel; ids get a td-b- prefix. */
const DEFAULTS_BRANDING_FIELDS = [
  ["company_name", "Company name"],
  ["product_name", "Product name"],
  ["support_email", "Support email"],
  ["support_url", "Support URL"],
  ["privacy_policy_url", "Privacy policy URL"],
  ["about_url", "About URL"],
  ["primary_color", "Primary color"],
];

/* Tolerant client-side parse of the tenant_defaults setting; the server
   validates strictly on save. */
function parseDefaultsSetting(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        branding:
          parsed.branding && typeof parsed.branding === "object" ? parsed.branding : {},
        policy: parsed.policy && typeof parsed.policy === "object" ? parsed.policy : {},
      };
    }
  } catch {
    /* fall through to empty */
  }
  return { branding: {}, policy: {} };
}

/* Three-way select for boolean policy defaults: no default set, on, or off. */
function triState(id, label, value) {
  const selected = (match) => (value === match ? " selected" : "");
  return `<label class="field"><span>${esc(label)}</span>
    <select id="${esc(id)}">
      <option value=""${value === undefined ? " selected" : ""}>(no default)</option>
      <option value="true"${selected(true)}>on</option>
      <option value="false"${selected(false)}>off</option>
    </select></label>`;
}

function readTriState(id) {
  const value = document.getElementById(id).value;
  return value === "" ? undefined : value === "true";
}

async function renderSettings() {
  const data = await api("/instance/settings");
  const fields = SETTING_LABELS.map(
    ([key, label]) => `<label class="field"><span>${esc(label)}</span>
      <input type="text" data-setting="${esc(key)}" value="${esc(data.settings[key] ?? "")}"></label>`,
  ).join("");

  const defaults = parseDefaultsSetting(data.settings.tenant_defaults || "");
  const db = defaults.branding;
  const dp = defaults.policy;
  const hasDefaultLogo = (data.settings.default_logo_r2_key || "") !== "";
  const squat = dp.domainSquatting;
  const webhook = dp.genericWebhook;

  const brandingInputs = DEFAULTS_BRANDING_FIELDS.map(
    ([key, label]) => `<label class="field"><span>${esc(label)}</span>
      <input type="text" id="td-b-${esc(key)}" value="${esc(db[key] || "")}"></label>`,
  ).join("");

  let prettyBaseline = data.settings.baseline_rule_delta || "{}";
  try {
    prettyBaseline = JSON.stringify(JSON.parse(prettyBaseline), null, 2);
  } catch {
    /* show as stored */
  }

  view.innerHTML = `
    <h1>Instance settings</h1>
    <div class="panel">
      ${fields}
      <button id="save-settings" class="primary">Save settings</button>
    </div>
    <h2>Tenant defaults</h2>
    <p class="muted">Every tenant inherits these values until it sets its own: branding fields
      left blank on a tenant inherit, and policy fields a tenant never overrode inherit.
      Dashboards and artifacts update immediately; deployed browsers pick changes up when
      policy is re-pushed (GPO re-import, Intune or CIPP re-sync). CIPP tenant ids never
      inherit.</p>
    <div class="panel">
      <h2 style="margin-top:0">Branding defaults</h2>
      <div class="grid2">${brandingInputs}</div>
      <h2>Default logo</h2>
      ${
        hasDefaultLogo
          ? `<img class="logo-preview" alt="Instance default logo" src="/api/instance/default-logo?ts=${Date.now()}">`
          : '<p class="muted">No default logo. Tenants without their own logo serve none.</p>'
      }
      <div class="grid2">
        <label class="field"><span>Default logo (png, jpg, or svg; 512 KB max)</span>
          <input type="file" id="td-logo" accept="image/png,image/jpeg,image/svg+xml"></label>
      </div>
      ${hasDefaultLogo ? '<button id="td-remove-logo" class="danger small">Remove default logo</button>' : ""}
      <h2>Policy defaults</h2>
      <p class="muted">Leave a field at (no default) or blank to keep Check's built-in behavior.</p>
      <div class="grid2">
        ${triState("td-p-block", "Enable page blocking", dp.enablePageBlocking)}
        ${triState("td-p-notify", "Show notifications", dp.showNotifications)}
        ${triState("td-p-badge", "Valid page badge", dp.enableValidPageBadge)}
        ${triState("td-p-cipp", "CIPP reporting", dp.enableCippReporting)}
        <label class="field"><span>Badge timeout (seconds; blank for no default)</span>
          <input type="number" id="td-p-badge-timeout" value="${esc(dp.validPageBadgeTimeout ?? "")}"></label>
        <label class="field"><span>Rules update interval (hours; blank for no default)</span>
          <input type="number" id="td-p-interval" value="${esc(dp.updateInterval ?? "")}"></label>
      </div>
      <label class="field"><span>URL allowlist (one pattern per line; blank for no default)</span>
        <textarea id="td-p-allowlist">${esc(((dp.urlAllowlist || [])).join("\n"))}</textarea></label>
      <div class="grid2">
        ${triState("td-p-squat", "Domain squatting detection", squat ? squat.enabled === true : undefined)}
        <label class="field"><span>Squatting deviation threshold</span>
          <input type="number" id="td-p-squat-threshold" value="${esc(squat ? (squat.deviationThreshold ?? 2) : 2)}"></label>
        <label class="field"><span>Squatting action (block or warn)</span>
          <input type="text" id="td-p-squat-action" value="${esc(squat ? (squat.Action ?? "block") : "block")}"></label>
        ${triState("td-p-webhook", "Webhook reporting to this service", webhook ? webhook.enabled === true : undefined)}
        <label class="field"><span>Webhook events (comma separated)</span>
          <input type="text" id="td-p-webhook-events" value="${esc((webhook && webhook.events ? webhook.events : POLICY_FALLBACKS.genericWebhook.events).join(", "))}"></label>
      </div>
      <button id="save-defaults" class="primary">Save tenant defaults</button>
    </div>
    <h2>Baseline rules delta</h2>
    <p class="muted">Applied beneath every tenant delta at merge time; standard MSP exclusions
      such as RMM domains belong here. Same keys as a tenant delta:
      <span class="mono">add_exclusion_domain_patterns, add_trusted_login_patterns,
      add_phishing_indicators, suppress_indicator_ids, raw_overrides</span>.
      A change takes effect on each tenant's next publish; use Republish all tenants
      to roll it out immediately.</p>
    <div class="panel">
      <textarea id="baseline-delta" class="tall" spellcheck="false">${esc(prettyBaseline)}</textarea>
      <div class="row" style="margin-top:10px">
        <button id="save-baseline" class="primary">Save baseline delta</button>
        <button id="republish-all">Republish all tenants</button>
      </div>
    </div>`;

  document.getElementById("save-settings").addEventListener("click", async () => {
    const settings = {};
    view.querySelectorAll("[data-setting]").forEach((input) => {
      settings[input.getAttribute("data-setting")] = input.value.trim();
    });
    try {
      await api("/instance/settings", jsonBody("PUT", { settings }));
      toast("Settings saved");
    } catch (error) {
      toast(error.message, true);
    }
  });

  const removeLogo = document.getElementById("td-remove-logo");
  if (removeLogo) {
    removeLogo.addEventListener("click", async () => {
      try {
        await api("/instance/default-logo", { method: "DELETE" });
        toast("Default logo removed");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  document.getElementById("save-defaults").addEventListener("click", async () => {
    const branding = {};
    for (const [key] of DEFAULTS_BRANDING_FIELDS) {
      const value = document.getElementById(`td-b-${key}`).value.trim();
      if (value !== "") branding[key] = value;
    }

    const policy = {};
    const booleans = [
      ["enablePageBlocking", "td-p-block"],
      ["showNotifications", "td-p-notify"],
      ["enableValidPageBadge", "td-p-badge"],
      ["enableCippReporting", "td-p-cipp"],
    ];
    for (const [key, id] of booleans) {
      const value = readTriState(id);
      if (value !== undefined) policy[key] = value;
    }
    const badgeTimeout = document.getElementById("td-p-badge-timeout").value.trim();
    if (badgeTimeout !== "") policy.validPageBadgeTimeout = Number(badgeTimeout) || 5;
    const interval = document.getElementById("td-p-interval").value.trim();
    if (interval !== "") policy.updateInterval = Number(interval) || 24;
    const allowlist = patternLines(document.getElementById("td-p-allowlist").value);
    if (allowlist.length > 0) policy.urlAllowlist = allowlist;
    const squatEnabled = readTriState("td-p-squat");
    if (squatEnabled !== undefined) {
      // Key order matches the Policy tab's builder so normalize-on-save
      // recognizes an unchanged inherited object.
      policy.domainSquatting = {
        enabled: squatEnabled,
        deviationThreshold:
          Number(document.getElementById("td-p-squat-threshold").value) || 2,
        Action: document.getElementById("td-p-squat-action").value.trim() || "block",
      };
    }
    const webhookEnabled = readTriState("td-p-webhook");
    if (webhookEnabled !== undefined) {
      policy.genericWebhook = {
        enabled: webhookEnabled,
        events: document
          .getElementById("td-p-webhook-events")
          .value.split(",")
          .map((event) => event.trim())
          .filter(Boolean),
      };
    }

    const value =
      Object.keys(branding).length === 0 && Object.keys(policy).length === 0
        ? ""
        : JSON.stringify({ branding, policy });
    try {
      await api(
        "/instance/settings",
        jsonBody("PUT", { settings: { tenant_defaults: value } }),
      );
      const file = document.getElementById("td-logo").files[0];
      if (file) {
        const form = new FormData();
        form.set("logo", file);
        await api("/instance/default-logo", { method: "PUT", body: form });
      }
      toast("Tenant defaults saved");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.getElementById("save-baseline").addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse(document.getElementById("baseline-delta").value);
    } catch (error) {
      toast(`baseline delta is not valid JSON: ${error.message}`, true);
      return;
    }
    const value =
      parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
        ? JSON.stringify(parsed)
        : "";
    try {
      await api(
        "/instance/settings",
        jsonBody("PUT", { settings: { baseline_rule_delta: value } }),
      );
      toast("Baseline delta saved; it applies on each tenant's next publish");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.getElementById("republish-all").addEventListener("click", async () => {
    if (!confirm("Republish every tenant with a published version using its current delta?")) {
      return;
    }
    const button = document.getElementById("republish-all");
    button.disabled = true;
    button.textContent = "Republishing...";
    try {
      const outcome = await api("/instance/republish", { method: "POST" });
      const failed = outcome.failures.length;
      toast(
        `Republished ${outcome.republished} tenants${failed > 0 ? `; ${failed} failed (see audit log)` : ""}`,
        failed > 0,
      );
    } catch (error) {
      toast(error.message, true);
    }
    route();
  });
}

/* ---------- setup wizard ---------- */

function setupStep(number, title, state, body) {
  // "optional" marks steps where skipping is a legitimate finished state;
  // they must not nag with the amber "to do" of steps that block progress.
  const badge =
    state === "done"
      ? '<span class="badge good">done</span>'
      : state === "locked"
        ? '<span class="badge">waiting</span>'
        : state === "optional"
          ? '<span class="badge">optional</span>'
          : '<span class="badge accent">to do</span>';
  return `<div class="panel">
    <div class="row spread"><h2>${number}. ${esc(title)}</h2>${badge}</div>
    ${state === "locked" ? '<p class="muted">Complete the previous step first.</p>' : body}
  </div>`;
}

async function finishSetup(message) {
  try {
    await api(
      "/instance/settings",
      jsonBody("PUT", {
        settings: { onboarding_completed_at: new Date().toISOString() },
      }),
    );
    toast(message);
    await refreshOnboardingStatus();
    location.hash = "#/tenants";
  } catch (error) {
    toast(error.message, true);
  }
}

async function renderSetup() {
  await refreshOnboardingStatus();
  if (onboardingStatus === null) {
    view.innerHTML =
      '<div class="panel"><strong>Error:</strong> could not load instance status.</div>';
    return;
  }
  const status = onboardingStatus;
  const checks = status.checks;
  const settings = (await api("/instance/settings")).settings;

  if (status.onboarding_complete) {
    view.innerHTML = `
      <h1>Setup</h1>
      <div class="panel"><p>Setup is complete. Everything the wizard covered
      lives under Tenants, Upstream, and Settings.</p></div>`;
    return;
  }

  const settingsDone = checks.settings_configured;
  const upstreamDone = checks.upstream_synced;
  const tenantDone = checks.tenant_count > 0 && checks.any_published;
  const devOnRemote =
    status.environment === "development" &&
    !["localhost", "127.0.0.1"].includes(location.hostname);

  const step1 = setupStep(
    1,
    "Environment check",
    "done",
    `<p>You are signed in as <strong>${esc(status.operator_email)}</strong>
     with <span class="mono">ENVIRONMENT=${esc(status.environment)}</span>.
     Reaching this page proves the identity provider, the Access application,
     and in-Worker JWT validation are all working.</p>
     ${
       devOnRemote
         ? `<p class="badge bad">ENVIRONMENT is development on a non-localhost
            origin. The Access bypass is active; set ENVIRONMENT=production
            before real use.</p>`
         : ""
     }`,
  );

  const step2 = setupStep(
    2,
    "Instance settings",
    settingsDone ? "done" : "todo",
    `<p>Only what artifact generation needs. Retention and the upstream
     source URL stay on the Settings page.</p>
     <label class="field"><span>Public base URL (used in every generated artifact)</span>
       <input type="text" id="setup-base-url" value="${esc(settings.public_base_url || location.origin)}"></label>
     <label class="field"><span>Version suffix label</span>
       <input type="text" id="setup-suffix" value="${esc(settings.version_suffix_label ?? "")}"></label>
     <label class="field"><span>Default CIPP server URL (optional; entering one also
       turns on the fleet-wide CIPP reporting default, editable under Settings)</span>
       <input type="text" id="setup-cipp" value="${esc(settings.default_cipp_server_url ?? "")}"></label>
     <button id="setup-save" class="primary">Save settings</button>`,
  );

  const wizardDefaults = parseDefaultsSetting(settings.tenant_defaults || "");
  const hasDefaultLogo = (settings.default_logo_r2_key || "") !== "";
  const defaultsDone =
    Object.keys(wizardDefaults.branding).length > 0 || hasDefaultLogo;
  const stepDefaults = setupStep(
    3,
    "Standard branding defaults (optional)",
    defaultsDone ? "done" : "todo",
    `<p>Your standard support info, set once: every tenant inherits these
       values until it sets its own, so fleet-wide changes stay single-edit.
       Skip freely; the full editor (privacy and about URLs, policy
       defaults) lives on the Settings page.</p>
     <div class="grid2">
       <label class="field"><span>Company name</span>
         <input type="text" id="setup-td-company" value="${esc(wizardDefaults.branding.company_name || "")}"></label>
       <label class="field"><span>Product name</span>
         <input type="text" id="setup-td-product" value="${esc(wizardDefaults.branding.product_name || "")}"></label>
       <label class="field"><span>Support email</span>
         <input type="text" id="setup-td-email" value="${esc(wizardDefaults.branding.support_email || "")}"></label>
       <label class="field"><span>Support URL</span>
         <input type="text" id="setup-td-support" value="${esc(wizardDefaults.branding.support_url || "")}"></label>
       <label class="field"><span>Primary color</span>
         <input type="text" id="setup-td-color" value="${esc(wizardDefaults.branding.primary_color || "")}"></label>
       <label class="field"><span>Default logo (png, jpg, or svg; 512 KB max)</span>
         <input type="file" id="setup-td-logo" accept="image/png,image/jpeg,image/svg+xml"></label>
     </div>
     ${
       hasDefaultLogo
         ? `<img class="logo-preview" alt="Instance default logo" src="/api/instance/default-logo?ts=${Date.now()}">`
         : ""
     }
     <button id="setup-save-defaults" class="primary">Save defaults</button>`,
  );

  const step3 = setupStep(
    4,
    "First upstream sync",
    upstreamDone ? "done" : settingsDone ? "todo" : "locked",
    `${
      upstreamDone
        ? `<p>Active snapshot: version
           <strong>${esc(checks.upstream_version || "unknown")}</strong>,
           fetched ${esc(fmtTime(checks.upstream_fetched_at))}.</p>`
        : `<p>Pulls the current CyberDrain detection rules. The Worker needs
           outbound internet for this call.</p>`
    }
     <button id="setup-sync" class="${upstreamDone ? "" : "primary"}">
       ${upstreamDone ? "Sync again" : "Sync now"}</button>`,
  );

  let step4Body;
  if (tenantDone) {
    if (setupTenantResult !== null) {
      const configUrl = `${(settings.public_base_url || "").replace(/\/+$/, "")}/rules/${setupTenantResult.guid}.json`;
      artifactStore.set("setup-config-url", configUrl);
      step4Body = `<p>Tenant created and published. Its Config URL:</p>
        <p class="mono">${esc(configUrl)}
        <button class="small" data-copy-key="setup-config-url">Copy</button></p>`;
    } else {
      step4Body = `<p>A tenant with a published ruleset already exists. Config
        URLs live on each tenant's Artifacts tab.</p>`;
    }
  } else {
    step4Body = `<p>Creates your first tenant and publishes its default
      ruleset (the upstream rules with an empty delta). Everything here can
      be changed later.</p>
      <label class="field"><span>Tenant name</span>
        <input type="text" id="setup-tenant-name" value="My organization"></label>
      <button id="setup-create-tenant" class="primary">Create and publish</button>`;
  }
  const step4 = setupStep(
    5,
    "Create your first tenant",
    tenantDone ? "done" : upstreamDone ? "todo" : "locked",
    step4Body,
  );

  const artifactsLink =
    setupTenantResult !== null
      ? `#/tenants/${setupTenantResult.id}/artifacts`
      : "#/tenants";
  const step5 = setupStep(
    6,
    "Deploy and verify",
    tenantDone ? "todo" : "locked",
    `<p>Grab deployment files from the tenant's
       <a href="${esc(artifactsLink)}">Artifacts tab</a>: managed storage
       JSON, reg files for GPO, an RMM deployment script, Firefox policies,
       Intune variables, and CIPP fields.</p>
     <p>To verify end to end, point a test browser with the extension at the
       Config URL and watch the Last fetch column on the tenant list.</p>
     <button id="setup-finish" class="primary">Finish setup</button>`,
  );

  view.innerHTML = `
    <div class="row spread">
      <h1>Setup</h1>
      <button id="setup-skip" class="ghost">Skip for now</button>
    </div>
    <p class="muted">Statuses reflect live server state; close this tab and
      come back any time. The rest of the dashboard stays usable from the top
      nav.</p>
    ${step1}${step2}${stepDefaults}${step3}${step4}${step5}`;

  document.getElementById("setup-skip").addEventListener("click", () => {
    finishSetup("Setup skipped; the wizard will not be offered again");
  });

  const save = document.getElementById("setup-save");
  if (save) {
    save.addEventListener("click", async () => {
      try {
        const cippUrl = document.getElementById("setup-cipp").value.trim();
        const updates = {
          public_base_url: document.getElementById("setup-base-url").value.trim(),
          version_suffix_label: document.getElementById("setup-suffix").value.trim(),
          default_cipp_server_url: cippUrl,
        };
        // The CIPP URL only reaches artifacts once CIPP reporting is on, and
        // reporting defaults to off, so entering a URL here also sets the
        // fleet-wide reporting default. An operator who already decided it
        // either way keeps their choice.
        if (cippUrl !== "") {
          const merged = parseDefaultsSetting(settings.tenant_defaults || "");
          if (merged.policy.enableCippReporting === undefined) {
            merged.policy.enableCippReporting = true;
            updates.tenant_defaults = JSON.stringify(merged);
          }
        }
        await api("/instance/settings", jsonBody("PUT", { settings: updates }));
        toast("Settings saved");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  const saveDefaults = document.getElementById("setup-save-defaults");
  if (saveDefaults) {
    saveDefaults.addEventListener("click", async () => {
      // Merge into the stored value so policy defaults and branding fields
      // this step does not cover survive untouched.
      const merged = parseDefaultsSetting(settings.tenant_defaults || "");
      const fields = [
        ["company_name", "setup-td-company"],
        ["product_name", "setup-td-product"],
        ["support_email", "setup-td-email"],
        ["support_url", "setup-td-support"],
        ["primary_color", "setup-td-color"],
      ];
      for (const [key, id] of fields) {
        const value = document.getElementById(id).value.trim();
        if (value !== "") merged.branding[key] = value;
        else delete merged.branding[key];
      }
      const value =
        Object.keys(merged.branding).length === 0 &&
        Object.keys(merged.policy).length === 0
          ? ""
          : JSON.stringify(merged);
      try {
        const logoFile = document.getElementById("setup-td-logo").files[0];
        if (logoFile) {
          const form = new FormData();
          form.set("logo", logoFile);
          await api("/instance/default-logo", { method: "PUT", body: form });
        }
        await api(
          "/instance/settings",
          jsonBody("PUT", { settings: { tenant_defaults: value } }),
        );
        toast("Tenant defaults saved");
        route();
      } catch (error) {
        toast(error.message, true);
      }
    });
  }

  const sync = document.getElementById("setup-sync");
  if (sync) {
    sync.addEventListener("click", async () => {
      sync.disabled = true;
      sync.textContent = "Syncing...";
      try {
        const outcome = await api("/upstream", { method: "POST" });
        if (outcome.status === "updated") {
          toast(`Updated: ${outcome.diffSummary}`);
        } else if (outcome.status === "unchanged") {
          toast("Upstream unchanged");
        } else {
          toast(`Sync ${outcome.status}: ${(outcome.errors || []).join("; ")}`, true);
        }
      } catch (error) {
        toast(error.message, true);
      }
      route();
    });
  }

  const create = document.getElementById("setup-create-tenant");
  if (create) {
    create.addEventListener("click", async () => {
      const name = document.getElementById("setup-tenant-name").value.trim();
      if (!name) {
        toast("Tenant name is required", true);
        return;
      }
      create.disabled = true;
      create.textContent = "Creating...";
      try {
        const created = await api("/tenants", jsonBody("POST", { name }));
        await api(`/tenants/${created.id}/publish`, { method: "POST" });
        setupTenantResult = { id: created.id, guid: created.guid };
        toast("Tenant created and ruleset published");
      } catch (error) {
        toast(error.message, true);
      }
      route();
    });
  }

  document.getElementById("setup-finish")?.addEventListener("click", () => {
    finishSetup("Setup complete");
  });
}

/* ---------- tenant onboarding wizard ---------- */

/* Deployment methods for the wizard's deploy step. Downloads reference
   ArtifactBundle fields; the checklist is the runbook's guidance in brief.
   Method choice is cosmetic and never stored. */
const ONBOARD_METHODS = [
  {
    key: "rmm",
    label: "RMM deployment script",
    downloads: [["rmm_script", "check-rmm-deploy.ps1", "text/plain"]],
    steps: [
      "Open the script and set the three $Include* browser toggles at the top (all on by default; the Artifacts tab has checkboxes that preset them).",
      "Deploy to Windows endpoints as SYSTEM via your RMM. Re-running is safe; the registry writes are idempotent.",
      "Firefox only: fill install_url inside the embedded policies.json with your XPI source per the Check docs first.",
      "After any policy or branding change, download a fresh copy and redeploy.",
    ],
  },
  {
    key: "managed",
    label: "Managed storage JSON (generic RMM)",
    downloads: [["chrome_managed_storage", "check-managed-storage.json", "application/json"]],
    steps: [
      "Push the JSON as the 3rd-party extension policy for Chrome (benimdeioplgkhanklclahllklceahbe) and Edge (knepjpocdagponkonnbggpcnhnaikajg).",
      "Force-install the extension separately (ExtensionSettings installation_mode force_installed), or use the RMM script method which does both.",
      "Re-push after any policy or branding change.",
    ],
  },
  {
    key: "reg",
    label: "Registry files (.reg import)",
    downloads: [
      ["reg_chrome", "check-chrome-policy.reg", "text/plain"],
      ["reg_edge", "check-edge-policy.reg", "text/plain"],
    ],
    steps: [
      "Import both files on managed Windows devices with administrator rights.",
      "Run gpupdate /force or restart the browser to apply.",
      "Re-import after any policy or branding change.",
    ],
  },
  {
    key: "gpo",
    label: "GPO creation script (domain)",
    downloads: [["gpo_script", "check-gpo-script.ps1", "text/plain"]],
    steps: [
      "Run on a domain-joined management host with RSAT; it creates or updates the named GPO.",
      "Link the GPO with the New-GPLink command the script prints.",
      "Optional: import Check's ADMX templates into the central store so the values read cleanly in the Group Policy Management Editor (link on the Artifacts tab).",
      "Re-run the script after any policy or branding change.",
    ],
  },
  {
    key: "firefox",
    label: "Firefox policies.json",
    downloads: [["firefox_policies_full", "policies.json", "application/json"]],
    steps: [
      "Fill install_url with your XPI source per the Check docs (blank by default).",
      "Place the file in the Firefox distribution directory on managed devices.",
      "Restart Firefox; policies load at startup.",
    ],
  },
  {
    key: "intune",
    label: "Intune (Check setup script)",
    untested: true,
    downloads: [["intune_variables", "check-intune-variables.ps1", "text/plain"]],
    steps: [
      "Paste the variable block into Check's Setup-Windows-Chrome-and-Edge.ps1 workflow per the Check deployment docs.",
      "Package per those docs and assign to a pilot ring first.",
      "Confirm the detection script passes, then widen assignment.",
    ],
  },
  {
    key: "cipp",
    label: "CIPP deployment standard",
    downloads: [],
    steps: [
      "Open this tenant's Artifacts tab and copy the CIPP standard field values table.",
      "Enter the values in CIPP's Check deployment standard for the matching CIPP tenant; CIPP fills the tenant id per tenant.",
      "Re-run or re-sync the standard after any policy or branding change.",
    ],
  },
];

async function renderTenantOnboard(tenantId) {
  const detail = await api(`/tenants/${tenantId}`);
  const tenant = detail.tenant;
  const instanceSettings = (await api("/instance/settings")).settings;
  const brandingData = await api(`/tenants/${tenantId}/branding`);
  const policyData = await api(`/tenants/${tenantId}/policy`);
  const published = detail.current_version !== null;

  // Artifacts render fresh only once publishable state exists.
  let artifacts = null;
  let artifactsError = "";
  if (published) {
    try {
      artifacts = (await api(`/tenants/${tenantId}/artifacts`)).artifacts;
    } catch (error) {
      artifactsError = error.message;
    }
  }

  const b = brandingData.branding;
  const bDefaults = brandingData.defaults || {};
  const brandingOwn = [
    "company_name",
    "product_name",
    "support_email",
    "support_url",
    "privacy_policy_url",
    "about_url",
  ].some((key) => (b[key] || "") !== "") || b.logo_r2_key !== null;
  const brandingRows = [
    ["Company name", "company_name"],
    ["Product name", "product_name"],
    ["Support email", "support_email"],
    ["Support URL", "support_url"],
  ]
    .map(([label, key]) => {
      const own = b[key] || "";
      const effective = own || bDefaults[key] || "";
      const source = own ? "" : effective ? ' <span class="badge">inherited</span>' : "";
      return `<dt>${esc(label)}</dt><dd>${esc(effective || "(unset)")}${source}</dd>`;
    })
    .join("");

  const pol = policyData.settings;
  const polDefaults = policyData.defaults || {};
  const cippConfigured =
    (typeof pol.cippServerUrl === "string" && pol.cippServerUrl !== "") ||
    (instanceSettings.default_cipp_server_url || "") !== "";
  const cippOn =
    cippConfigured &&
    (pol.enableCippReporting ?? polDefaults.enableCippReporting ?? false) === true;
  const cippTenantId = typeof pol.cippTenantId === "string" ? pol.cippTenantId : "";
  const ownAllowlist = Array.isArray(pol.urlAllowlist) ? pol.urlAllowlist : null;
  const defaultAllowlist = Array.isArray(polDefaults.urlAllowlist)
    ? polDefaults.urlAllowlist
    : [];
  const allowlistShown = ownAllowlist ?? defaultAllowlist;
  const policyDone = !(cippOn && cippTenantId === "");

  const savedDelta = detail.draft ? parseDeltaText(detail.draft.draft_json) : null;
  const deltaKeyCount = savedDelta === null ? 0 : Object.keys(savedDelta).length;

  const fetched = detail.last_fetch_at !== null;

  // Migration path for operators already running Check via the official
  // GPO + ADMX: scripts/Export-CheckGpoConfig.ps1 reads their GPO on a DC
  // and emits managed-storage-shaped JSON; pasting it here adopts the
  // branding and policy values into this tenant (steps 2 and 3).
  const importPanel = `<div class="panel">
    <details>
      <summary>Migrating from the official Check GPO? Import its config</summary>
      <p class="muted">Run <span class="mono">scripts/Export-CheckGpoConfig.ps1</span>
        (in the repo) on a domain controller; it asks for your existing GPO's
        name and prints JSON. Paste that here, or paste any
        <span class="mono">check-managed-storage.json</span>. Branding and
        policy values are adopted into steps 2 and 3 (re-adopting overwrites
        them; pasted values are cleaned of stray registry control
        characters); the rules URL is ignored, since this tenant's own
        config URL replaces it.</p>
      <textarea id="ob-import" class="tall" spellcheck="false" placeholder="{ ... }"></textarea>
      <button id="ob-import-apply" class="primary" style="margin-top:8px">Adopt config</button>
    </details>
  </div>`;

  const step1 = setupStep(
    1,
    "Tenant created",
    "done",
    `<p><strong>${esc(tenant.name)}</strong>, created ${esc(fmtTime(tenant.created_at))},
      with its own config URL (the unguessable GUID in it is the access
      control) and a preview URL for testing drafts. Rename, duplicate, and
      delete live on the <a href="#/tenants/${esc(tenantId)}">tenant page</a>.</p>`,
  );

  const step2 = setupStep(
    2,
    "Branding (optional)",
    brandingOwn ? "done" : "optional",
    `<p>What the extension shows this client's users. It sits here, before
      deployment, because branding is baked into the files step 6 generates;
      the logo is the one exception, fetched live, so it can change later
      without a re-push. Blank fields inherit the instance defaults, so skip
      freely if the defaults fit.</p>
      <dl class="kv">${brandingRows}</dl>
      <p><a href="#/tenants/${esc(tenantId)}/branding">Open the Branding tab</a>
      to set client-specific values or upload a logo${
        brandingData.default_logo ? " (the instance default logo serves until then)" : ""
      }.</p>`,
  );

  const step3 = setupStep(
    3,
    "Policy essentials",
    policyDone ? "done" : "todo",
    `<p><span class="badge accent">deployed with policy</span>
      ${
        cippOn
          ? `The two settings that most often differ per client: the URL
             allowlist and the CIPP tenant id.`
          : `The setting that most often differs per client: the URL
             allowlist (this client's own domains, training platforms).`
      }
      Like everything on the <a href="#/tenants/${esc(tenantId)}/policy">Policy
      tab</a>, these ship inside the deployment files from step 6 and change
      on devices only when that policy is re-pushed, so set them before
      deploying.</p>
      <label class="field"><span>URL allowlist (one pattern per line${
        ownAllowlist === null && defaultAllowlist.length > 0 ? "; currently inherited" : ""
      })</span>
        <textarea id="ob-allowlist" class="lines" spellcheck="false">${esc(allowlistShown.join("\n"))}</textarea></label>
      ${
        cippOn
          ? `<label class="field"><span>CIPP tenant id / domain (required for direct
              deployments; the CIPP standard fills it per tenant)</span>
              <input type="text" id="ob-cipp-tenant" value="${esc(cippTenantId)}"></label>`
          : ""
      }
      <button id="ob-save-policy" class="primary">Save policy essentials</button>`,
  );

  const step4 = setupStep(
    4,
    "Rules delta (optional)",
    deltaKeyCount > 0 ? "done" : "optional",
    `<p><span class="badge">fetched remotely</span>
      Client-specific rule adjustments layered onto the upstream rules.
      Unlike policy, browsers fetch rules from this service on their update
      interval, so you can tune them any time, even after rollout. Most
      tenants need at most an exclusion for their own domains; skip
      freely.</p>
      <div class="easy-add">
        <strong>Easy add</strong>
        <span class="muted">builds the pattern regex from a plain domain</span>
        <div class="row" style="align-items:center;flex-wrap:wrap;margin-top:8px">
          <input type="text" id="ob-domain" placeholder="clientdomain.com or a full URL" style="flex:1;min-width:220px">
          <label class="check"><input type="checkbox" id="ob-subs" checked> include subdomains</label>
          <select id="ob-target">
            <option value="add_exclusion_domain_patterns">as exclusion pattern</option>
            <option value="add_trusted_login_patterns">as trusted login pattern</option>
          </select>
          <button id="ob-add" class="primary small">Add and save</button>
        </div>
      </div>
      <p class="muted">${
        deltaKeyCount > 0
          ? `Saved draft has ${esc(deltaKeyCount)} delta key${deltaKeyCount === 1 ? "" : "s"}.`
          : "No delta saved yet."
      } The full editor (suppressions, indicators, raw JSON) is the
      <a href="#/tenants/${esc(tenantId)}/rules">Rules draft tab</a>.</p>`,
  );

  const step5 = setupStep(
    5,
    "Publish",
    published ? "done" : "todo",
    published
      ? `<p>Version <strong>v${esc(detail.current_version.version_number)}</strong> is live
          at this tenant's config URL. Later changes republish from the
          <a href="#/tenants/${esc(tenantId)}/rules">Rules draft tab</a>.</p>`
      : `<p>Merges the upstream rules with the instance baseline delta (if
          set) and this tenant's delta, then serves the result at the
          tenant's config URL. Nothing deploys to browsers yet; that is the
          next step.</p>
          <button id="ob-publish" class="primary">Publish</button>
          <div id="findings"></div>`,
  );

  let deployBody;
  if (!published) {
    deployBody = "";
  } else if (artifacts === null) {
    deployBody = `<p class="badge warn">cannot generate artifacts</p>
      <p class="muted">${esc(artifactsError)}</p>`;
  } else {
    const options = ONBOARD_METHODS.map(
      (method) =>
        `<option value="${esc(method.key)}">${esc(method.label)}${method.untested ? " (untested)" : ""}</option>`,
    ).join("");
    deployBody = `<p>Pick the deployment tooling you use for this client; the
        choice only filters the checklist. Every artifact stays on the
        <a href="#/tenants/${esc(tenantId)}/artifacts">Artifacts tab</a>.</p>
      <label class="field"><span>Deployment method</span>
        <select id="ob-method">${options}</select></label>
      <div id="ob-method-body"></div>`;
  }
  const step6 = setupStep(
    6,
    "Deploy to browsers",
    fetched ? "done" : published ? "todo" : "locked",
    deployBody,
  );

  const step7 = setupStep(
    7,
    "Verify",
    fetched ? "done" : published ? "todo" : "locked",
    fetched
      ? `<p>A browser fetched this tenant's rules ${esc(ago(detail.last_fetch_at))}.
          Onboarding is complete; day-to-day health lives on the
          <a href="#/tenants">tenant list</a> (Last fetch column) and in the
          monitoring guide.</p>`
      : `<p>Deploy to a pilot device first (the config URL reaches the
          extension through the policy you just deployed, not by visiting
          it). A fresh install fetches immediately; browsers already running
          fetch within the rules update interval, 24 hours by default.</p>
          <p>Last fetch: <strong>${esc(ago(detail.last_fetch_at))}</strong>
          <button id="ob-refresh" class="small">Check again</button></p>`,
  );

  view.innerHTML = `
    <div class="row spread">
      <h1>Onboarding: ${esc(tenant.name)}</h1>
      <a class="badge" href="#/tenants/${esc(tenantId)}">exit to tenant page</a>
    </div>
    <p class="muted">Everything here leaves this service by one of two doors:
      detection rules are <strong>fetched</strong> by browsers from this
      service (steps 4 and 5), while policy, branding, and the rules URL
      itself are <strong>deployed</strong> to devices as files and registry
      values (steps 2, 3, and 6). Statuses derive from live server state, so
      this wizard is resumable; leave and come back any time. Steps 2 and 4
      are optional.</p>
    ${importPanel}
    ${step1}${step2}${step3}${step4}${step5}${step6}${step7}`;

  document.getElementById("ob-save-policy")?.addEventListener("click", async () => {
    const lines = patternLines(document.getElementById("ob-allowlist").value);
    const settings = { ...pol };
    if (JSON.stringify(lines) === JSON.stringify(defaultAllowlist)) {
      delete settings.urlAllowlist;
    } else {
      settings.urlAllowlist = lines;
    }
    const cippField = document.getElementById("ob-cipp-tenant");
    if (cippField) {
      const value = cippField.value.trim();
      if (value === "") delete settings.cippTenantId;
      else settings.cippTenantId = value;
    }
    try {
      await api(`/tenants/${tenantId}/policy`, jsonBody("PUT", { settings }));
      toast("Policy essentials saved");
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.getElementById("ob-add")?.addEventListener("click", async () => {
    const pattern = domainToPattern(
      document.getElementById("ob-domain").value,
      document.getElementById("ob-subs").checked,
    );
    if (pattern === null) {
      toast("Enter a domain like clientdomain.com (or paste a URL)", true);
      return;
    }
    const key = document.getElementById("ob-target").value;
    const delta = savedDelta === null ? {} : { ...savedDelta };
    const list = Array.isArray(delta[key]) ? [...delta[key]] : [];
    if (list.includes(pattern)) {
      toast("That pattern is already in the draft", true);
      return;
    }
    list.push(pattern);
    delta[key] = list;
    try {
      const result = await api(`/tenants/${tenantId}/rules`, jsonBody("PUT", { delta }));
      toast(result.valid ? `Added ${pattern}` : "Saved with findings; see the Rules tab", !result.valid);
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  document.getElementById("ob-publish")?.addEventListener("click", async () => {
    try {
      const result = await api(`/tenants/${tenantId}/publish`, { method: "POST" });
      toast(`Published version ${result.versionNumber}`);
      route();
    } catch (error) {
      renderFindings(view, (error.body && error.body.errors) || [error.message]);
      toast("Publish blocked by validation gates", true);
    }
  });

  document.getElementById("ob-refresh")?.addEventListener("click", () => route());

  document.getElementById("ob-import-apply")?.addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse(document.getElementById("ob-import").value);
    } catch (error) {
      toast(`Not valid JSON: ${error.message}`, true);
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      toast("Expected a JSON object in the managed-storage shape", true);
      return;
    }
    // Registry exports carry trailing NUL terminators on strings; strip
    // them (and any other control junk) before anything is saved.
    parsed = cleanImportedValue(parsed);
    // Branding: customBranding camelCase keys onto tenant snake_case fields.
    const brandingMap = [
      ["companyName", "company_name"],
      ["productName", "product_name"],
      ["supportEmail", "support_email"],
      ["supportUrl", "support_url"],
      ["privacyPolicyUrl", "privacy_policy_url"],
      ["aboutUrl", "about_url"],
      ["primaryColor", "primary_color"],
    ];
    const importedBranding = {};
    const source = parsed.customBranding;
    if (source !== null && typeof source === "object" && !Array.isArray(source)) {
      for (const [from, to] of brandingMap) {
        if (typeof source[from] === "string" && source[from] !== "") {
          importedBranding[to] = source[from];
        }
      }
    }
    // Policy: whitelist of per-tenant keys; the webhook URL and rules URL
    // are always this instance's own, so only the webhook prefs carry over.
    const policyKeys = [
      "updateInterval",
      "enablePageBlocking",
      "showNotifications",
      "enableValidPageBadge",
      "validPageBadgeTimeout",
      "enableDebugLogging",
      "urlAllowlist",
      "domainSquatting",
      "enableCippReporting",
      "cippServerUrl",
      "cippTenantId",
    ];
    const importedPolicy = { ...pol };
    let policyCount = 0;
    for (const key of policyKeys) {
      if (parsed[key] !== undefined) {
        importedPolicy[key] = parsed[key];
        policyCount += 1;
      }
    }
    if (Array.isArray(importedPolicy.urlAllowlist)) {
      importedPolicy.urlAllowlist = importedPolicy.urlAllowlist.filter(
        (entry) => typeof entry === "string" && entry !== "",
      );
    }
    const webhook = parsed.genericWebhook;
    if (webhook !== null && typeof webhook === "object" && !Array.isArray(webhook)) {
      importedPolicy.genericWebhook = {
        enabled: webhook.enabled === true,
        events: Array.isArray(webhook.events) ? webhook.events.map(String) : [],
      };
      policyCount += 1;
    }
    if (Object.keys(importedBranding).length === 0 && policyCount === 0) {
      toast("Nothing recognizable to adopt in that JSON", true);
      return;
    }
    try {
      if (Object.keys(importedBranding).length > 0) {
        await api(`/tenants/${tenantId}/branding`, jsonBody("PUT", importedBranding));
      }
      if (policyCount > 0) {
        await api(`/tenants/${tenantId}/policy`, jsonBody("PUT", { settings: importedPolicy }));
      }
      toast(
        `Adopted ${Object.keys(importedBranding).length} branding field(s) and ${policyCount} policy value(s)`,
      );
      route();
    } catch (error) {
      toast(error.message, true);
    }
  });

  const methodSelect = document.getElementById("ob-method");
  if (methodSelect && artifacts !== null) {
    const renderMethod = () => {
      const method = ONBOARD_METHODS.find((entry) => entry.key === methodSelect.value);
      const downloads = method.downloads
        .map(([field, filename, mime]) => {
          const content =
            typeof artifacts[field] === "string"
              ? artifacts[field]
              : JSON.stringify(artifacts[field], null, 2);
          const storeKey = `ob-${method.key}-${field}`;
          artifactStore.set(storeKey, content);
          return `<button class="small" data-download-key="${esc(storeKey)}"
            data-filename="${esc(filename)}" data-mime="${esc(mime)}">Download ${esc(filename)}</button>`;
        })
        .join(" ");
      document.getElementById("ob-method-body").innerHTML = `
        ${
          method.untested
            ? `<p><span class="badge warn">untested</span> This checklist mirrors
                Check's own deployment docs but has not been verified by this
                project (no Intune tenant available). Reports welcome on the
                issue tracker.</p>`
            : ""
        }
        <ol>${method.steps.map((step) => `<li>${esc(step)}</li>`).join("")}</ol>
        ${downloads ? `<div class="row">${downloads}</div>` : ""}`;
    };
    methodSelect.addEventListener("change", renderMethod);
    renderMethod();
  }
}

/* ---------- audit log ---------- */

async function renderAudit() {
  const filters = renderAudit.filters || {};
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.operator) params.set("operator", filters.operator);
  const query = params.toString() ? `?${params.toString()}` : "";
  const data = await api(`/audit${query}`);

  const rows = data.entries
    .map(
      (entry) => `<tr>
      <td>${esc(fmtTime(entry.ts))}</td>
      <td>${esc(entry.operator_email)}</td>
      <td class="mono">${esc(entry.action)}</td>
      <td class="mono">${esc(entry.tenant_id || "")}</td>
      <td class="mono wrap">${esc(entry.details_json || "")}</td>
    </tr>`,
    )
    .join("");

  view.innerHTML = `
    <h1>Audit log</h1>
    <div class="panel">
      <div class="row" style="margin-bottom:10px">
        <input type="text" id="audit-action" placeholder="Filter by action, e.g. rules.publish" style="max-width:280px" value="${esc(filters.action || "")}">
        <input type="text" id="audit-operator" placeholder="Filter by operator email" style="max-width:280px" value="${esc(filters.operator || "")}">
        <button id="audit-apply" class="small">Apply</button>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Operator</th><th>Action</th><th>Tenant</th><th>Details</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No entries.</td></tr>'}</tbody>
      </table>
    </div>`;

  document.getElementById("audit-apply").addEventListener("click", () => {
    renderAudit.filters = {
      action: document.getElementById("audit-action").value.trim(),
      operator: document.getElementById("audit-operator").value.trim(),
    };
    route();
  });
}
