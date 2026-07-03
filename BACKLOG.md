# Backlog

Planned work that is scoped but not yet started. Items graduate from here into
commits; keep entries current when scope changes, and delete them when shipped.

## Status board (2026-07-03)

Current work queue, in order. Update as items land.

- [x] v0.1.0 release tag and notes (shipped: releases/tag/v0.1.0)
- [x] Issue templates (bug report, feature request, security pointer)
- [x] CodeQL scanning workflow
- [ ] Onboarding wizard (item 1 below). Phase status is tracked inside the
      item: backend endpoint with tests, then wizard page, then redirect,
      then docs, then wiki regeneration.

## 1. Onboarding wizard on first login

**Status (2026-07-03):** in progress.

- [x] 1.1 first-login detection: `onboarding_completed_at` key with
      legacy auto-complete on first seed only (guards against a fresh
      instance auto-completing mid-wizard after its settings step)
- [x] 1.2 `GET /api/instance/status` aggregate endpoint
- [x] 1.4 backend tests (4 new, 102 total passing)
- [ ] 1.3 wizard UI `#/setup`, redirect, nav link
- [ ] 1.5 docs (README runbook note, docs/runbook.md)
- [ ] wiki regeneration after merge

**Goal:** guide a fresh deployment through runbook steps 5 through 8 (instance
settings, first upstream sync, tenant zero, first deployment test) directly in
the management UI. Runbook steps 1 through 4 (identity provider, Access app,
Worker variables, custom domain) cannot be automated from inside the Worker,
since the operator cannot reach `/manage` until they are done, but the wizard
verifies their outcome by existing at all.

**Design principles:** the wizard is a resumable checklist page, not a modal
flow. Every step's status derives from live server state, never from a stored
step counter. That makes it idempotent, safe with multiple operators working
concurrently, and trivially resumable if the operator closes the tab.

### 1.1 First-login detection (backend)

- Add `onboarding_completed_at: ""` to `DEFAULT_INSTANCE_SETTINGS` in
  `src/lib/db.ts`. It is auto-seeded by `getInstanceSettings()`, and the
  existing `PUT /api/instance/settings` validation accepts it for free since
  the handler validates against that same object. It does not appear on the
  Settings page because the UI renders only keys listed in `SETTING_LABELS`.
- Upgrade safety: existing configured instances must not suddenly see a
  wizard. Treat onboarding as complete when `onboarding_completed_at` is set,
  or when the instance shows signs of life (tenant count above zero, or
  `public_base_url` set), and lazily stamp the timestamp in that case.

### 1.2 New aggregate endpoint: `GET /api/instance/status`

One call powers both the redirect decision and per-step state. Added in
`src/routes/api/instance.ts`, read-only composition of existing `db.ts`
helpers (`getInstanceSettings`, `getActiveSnapshot`, tenant listing):

```json
{
  "operator_email": "...",
  "environment": "production",
  "onboarding_complete": false,
  "checks": {
    "settings_configured": false,
    "upstream_synced": false,
    "tenant_count": 0,
    "any_published": false
  }
}
```

`settings_configured` means `public_base_url` is non-empty. `upstream_synced`
means an active snapshot exists (include its version and fetch time when
present). No audit entry: it is a read.

### 1.3 Wizard UI: `#/setup` route in `app.js`

Follow the established contribution pattern: route entry, renderer function,
`api()` for data, `esc()` for every dynamic value, `toast()` for feedback,
re-render via `route()` after state changes.

- Redirect logic: in `route()`, when the hash is empty or `#/tenants` and a
  cached status says onboarding is incomplete, redirect to `#/setup`. Fetch
  status once at boot; refresh after each wizard action. Never redirect away
  from an explicitly typed route, and never trap the operator: the top nav
  stays fully usable throughout.
- Nav affordance: a "Setup" link in the top bar, visible only while
  onboarding is incomplete, so skipping is reversible until dismissed.
- Layout: one page of numbered step panels, each with a live state badge
  (done / to do), reusing `.panel` and `.badge` styles. Steps unlock top to
  bottom; completed steps stay visible with their results.

Steps:

1. **Environment check** (read-only). Operator email and `ENVIRONMENT`, with
   a warning panel if `ENVIRONMENT` is `development` on a non-localhost
   origin. Copy notes that reaching this page proves Access and in-Worker JWT
   validation are working.
2. **Instance settings** (inline mini-form). `public_base_url` prefilled from
   `location.origin`, `version_suffix_label`, optional
   `default_cipp_server_url`. Saves via existing `PUT /api/instance/settings`.
   Retention values stay on the Settings page; the wizard asks only for what
   blocks artifact generation.
3. **First upstream sync.** Button posting to existing `POST /api/upstream`,
   reusing the `renderUpstream()` result handling (updated / unchanged /
   error with joined validation errors). Shows snapshot version and fetch
   time when done. Copy notes it needs outbound internet.
4. **Create tenant zero.** Name input (prefilled "My organization"),
   `POST /api/tenants`, then one-click publish of the default empty delta via
   `POST /api/tenants/{id}/publish` (works today; drafts default to `{}`).
   Result: the tenant's Config URL with a copy button, built from the
   now-set `public_base_url`.
5. **Deploy and verify.** No new backend. Links to the tenant's Artifacts
   tab, shows the Config URL again, and explains verification: point a test
   browser at it and watch the fetch counter on the tenant list. "Finish
   setup" writes `onboarding_completed_at`; a "Skip for now" link does the
   same from any point.

Decision: step 4 creates tenant zero only. No "first client tenant" repeat;
once the operator has done it once, the normal UI teaches the rest.

### 1.4 Tests

- `test/api.test.ts`: fresh DB reports all status checks false; after
  settings, a snapshot fixture, and tenant creation the flags flip; the
  legacy-instance auto-complete path (tenant exists but no timestamp) stamps
  and reports complete; settings PUT accepts `onboarding_completed_at`.
- No UI test harness exists; verify the wizard manually via `wrangler dev`
  against a freshly migrated local DB for the true first-run experience.

### 1.5 Docs and follow-through

- README "Post-deploy runbook": note steps 5 through 8 are now guided in-app;
  keep the manual list as reference.
- `docs/runbook.md`: same, plus the wizard's skip and resume behavior.
- After merge: regenerate the GitNexus index and wiki, then
  `npm run docs:wiki`.

### 1.6 Sizing and order

Roughly 80 to 120 lines of backend (status endpoint, one settings key, tests)
and 200 to 300 lines of UI. Implement in this order: backend endpoint with
tests, wizard page, redirect, docs. Run GitNexus impact analysis on `route()`,
`getInstanceSettings`, and the API index router before editing them; changes
are additive so expected risk is low, but `route()` fronts every view.

## 2. GPO deployment artifacts: per-tenant GPO script plus ADMX pointers

**Goal:** extend the artifact bundle so a Windows domain admin can go from
tenant to working GPO without hand-typing registry values. Check ships
hand-authored ADMX/ADML templates (`enterprise/admx/` in CyberDrain/Check,
AGPL-3.0) that define per-machine policies for Chrome and Edge; those
templates are static and tenant-agnostic, so the per-tenant piece is the GPO
values, which `buildArtifactBundle` already computes for the `.reg` renderer.

**Design decisions:**

- Ship a PowerShell GPO creation script, not an `Import-GPO` backup bundle.
  `registry.pol` is a binary PReg format: harder to generate, review, and
  golden-test. A `New-GPO` / `Set-GPRegistryValue` script is reviewable
  before it runs and reuses the existing pure-renderer pattern.
- Link to the upstream ADMX/ADML at a pinned tag rather than vendoring or
  proxying them. The files are AGPL-3.0 and this repo is MIT; linking avoids
  redistribution entirely. Revisit proxying only if operators report the
  GitHub dependency as a real friction point.
- The script targets both browsers, writing the `ExtensionSettings`
  force-install key and the `3rdparty\extensions\{id}\policy` managed
  storage keys that the ADMX defines, with values identical to the `.reg`
  artifact so the two stay provably in sync.

**Steps:**

1. New pure renderer `buildGpoScript(policy, branding, urls)` in
   `src/lib/artifacts.ts`, added to `ArtifactBundle` as `gpo_script`.
   Registry paths and values must match `buildRegFile` output; derive both
   from one shared table if that stays readable.
2. The script follows CONTRIBUTING rule 4: full descriptive names, 7-bit
   ASCII, no `&&` or `||`, semicolons or separate statements only. Structure:
   parameter block (GPO name, optional domain), RSAT GroupPolicy module
   check, `New-GPO` if absent, one `Set-GPRegistryValue` per key, final
   summary output. No linking to an OU: print the `New-GPLink` command as a
   comment instead, since scope is the operator's call.
3. Golden test `test/golden/gpo-script.ps1` via the existing
   `buildArtifactBundle` fixtures and `scripts/generate-goldens.mjs`. Add
   the new file to the CI "PowerShell text rules" grep alongside
   `intune-variables.ps1`.
4. Artifacts tab in `app.js`: download button for the script plus links to
   the upstream ADMX/ADML files and the docs.check.tech domain deployment
   page. Copy notes the ADMX import is once per domain (central store),
   while the script runs once per tenant.
5. `GET /api/tenants/:id/artifacts` already returns the whole bundle, so no
   route changes; verify payload size stays reasonable.
6. Docs: README artifact list and `docs/architecture.md` section 5 gain the
   new artifact; note the AGPL boundary decision (link, do not vendor).

**Sizing:** roughly half a day: the renderer and goldens are mechanical, the
UI is one panel, and most of the effort is getting the script ergonomics and
the registry table dedup right.

## 3. Future candidates (unscoped)

- **Wiki regeneration automation.** CI cannot regenerate the GitNexus wiki
  (needs the local index and an LLM key); today the freshness nudge is a
  soft CI warning. Revisit if GitNexus grows a headless mode.
- **Fetch metrics sparkline** on the tenant list, from existing
  `fetch_metrics` rows; no schema change needed.
- **Access lockout drill doc.** A short runbook section rehearsing the
  break-glass path (edit the Access policy from the Cloudflare dashboard).
- **Rate limiting guidance as code.** The runbook's optional WAF rules could
  ship as a documented Terraform or API snippet for operators who want them.
