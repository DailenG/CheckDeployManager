# Backlog

Planned work that is scoped but not yet started. Items graduate from here into
commits; keep entries current when scope changes, and delete them when shipped.

## Status board (2026-07-03)

Current work queue, in order. Update as items land.

- [x] v0.1.0 release tag and notes (shipped: releases/tag/v0.1.0)
- [x] Issue templates (bug report, feature request, security pointer)
- [x] CodeQL scanning workflow
- [x] Onboarding wizard: shipped in full (status endpoint with 4 tests,
      `#/setup` wizard with redirect and nav link, README and runbook docs,
      wizard screenshot). Verified end to end headless against a fresh
      local DB: redirect, step unlock order, nav escape, finish, skip
      persistence. Entry deleted below per convention.
- [x] Wiki regeneration for the wizard commit
- [x] v0.2.0 release (setup wizard; package.json bumped to match)
- [x] Webhook relay for false positives: `false_positive_relay_url`
      instance setting; every inbound `/hook/{guid}` event is POSTed once,
      best effort via waitUntil, as `{source, kind, event}` JSON with
      payload_json forwarded verbatim; https only; injectable-fetcher unit
      tests (4); documented in the runbook webhook inbox section.

- [x] CIPP tenant attribution guard: artifact bundles gain a `warnings`
      array; enabling CIPP reporting with an empty `cippTenantId` warns on
      the Artifacts tab (directly deployed artifacts would report events
      without tenant attribution; empty stays fine for the CIPP standard,
      which fills it per tenant). Policy tab label explains the same.

- [x] Dashboard footer: running version (from package.json via the status
      endpoint), releases link, and a client-side newer-release badge.
      Runbook gains "Updating a deployed instance" (merge upstream into
      the deploy-button copy and push, or git pull plus npm run deploy).

- [x] GPO deployment artifacts: gpo_script joins the bundle, rendered from
      a shared registry-writes table that also feeds the .reg files (reg
      goldens stayed byte-identical through the refactor). New-GPO plus one
      Set-GPRegistryValue per value for both browsers, New-GPLink printed
      as guidance, values single-quoted so nothing interpolates. Golden
      test added and wired into the CI PowerShell rules grep; Artifacts
      tab section links the upstream ADMX/ADML pinned at Check v1.1.0.
      Entry deleted below per convention.

Queue complete. Next: cut v0.3.0 bundling the webhook relay, CIPP
attribution warning, version footer, and GPO deployment artifacts.

## 1. Tenant defaults: instance-level branding and policy inheritance

**Goal:** stop per-tenant copy-paste of MSP-standard values and make
fleet-wide changes single-edit. Generalizes the pattern
`default_cipp_server_url` already proves: an instance-level default that a
tenant value overrides, resolved at artifact generation time in
`resolvePolicy`, never copied into tenant rows.

**Decision: inheritance, not copy-on-create.** A Duplicate button or
onboarding-time template copies values that then drift; the operator's
stated pain (change support info or product name once, not per tenant) is
only solved by resolution-time fallback. Artifacts are already rendered on
demand from live rows, so a defaults change reaches every non-overridden
tenant's next artifact with no republish.

**Field classification:**

- Inheritable branding: everything, including `company_name` and the logo.
  Branding is the security entity's brand as end users see it in the
  extension; for a white-label MSP that is the MSP's own name and logo on
  every client (brand recognition is the point), while a client that wants
  its own brand simply overrides. Note `tenants.name` is the internal
  dashboard label, unrelated to branding and never inherited.
- Logo mechanics: artifacts already emit `/assets/{guid}/logo`, so the
  asset route falls back to a new instance-level default logo when the
  tenant has none. Per-tenant URLs stay stable while content inherits; no
  artifact shape change.
- Inheritable policy: `updateInterval`, `enablePageBlocking`,
  `showNotifications`, `enableValidPageBadge`, `validPageBadgeTimeout`,
  `enableCippReporting`, `urlAllowlist`, `domainSquatting`,
  `genericWebhook` events toggle.
- Never inherited: `cippTenantId` (maps the client to its CIPP tenant).
  `default_cipp_server_url` keeps its existing dedicated setting.

**Mechanics:**

- Storage: one new instance setting `tenant_defaults` holding a JSON object
  `{branding: {...}, policy: {...}}`, validated with the same rules as the
  per-tenant PUTs (reuse `validatePolicySettings`). Instance settings PUT
  validates keys against `DEFAULT_INSTANCE_SETTINGS`, so the key rides the
  existing endpoint; the wizard and Settings page need a dedicated editor
  panel since the value is structured, not a string field.
- Resolution: thread the defaults into `resolvePolicy` as a layer between
  hardcoded fallbacks and tenant values (tenant key present wins, else
  defaults key, else current hardcoded fallback). Branding: empty string in
  the tenant row inherits the default. Policy JSON already stores only
  explicitly-set keys, so absent-key-means-inherit needs no migration.
- UI: Branding and Policy tabs show the inherited value as the input
  placeholder with an "inherited" hint so operators can tell an override
  from a default; a Tenant defaults panel lives on the Settings page.
  Optional wizard follow-up: a small "your standard support info" step.
- Propagation caveat for docs: dashboards and artifacts update immediately;
  deployed browsers change only when policy is re-pushed (GPO re-import,
  Intune or CIPP re-sync). State this plainly in the runbook.

**Tests:** resolution precedence (tenant beats default beats fallback) per
field class, empty-string branding inheritance, defaults validation errors,
artifacts golden run with defaults set and tenant overrides mixed.

**Possible phase 2 (defer):** an instance-level baseline rule delta merged
before each tenant delta (standard MSP exclusions such as RMM domains), and
a Duplicate-tenant convenience for the rules delta only. Both are separate
decisions; neither blocks this item.

**Sizing:** roughly a day: resolution layer and tests are contained, the
defaults editor panel is the bulk of the UI work.

## 2. Future candidates (unscoped)

- **Wiki regeneration automation.** CI cannot regenerate the GitNexus wiki
  (needs the local index and an LLM key); today the freshness nudge is a
  soft CI warning. Revisit if GitNexus grows a headless mode.
- **Fetch metrics sparkline** on the tenant list, from existing
  `fetch_metrics` rows; no schema change needed.
- **Access lockout drill doc.** A short runbook section rehearsing the
  break-glass path (edit the Access policy from the Cloudflare dashboard).
- **Rate limiting guidance as code.** The runbook's optional WAF rules could
  ship as a documented Terraform or API snippet for operators who want them.
