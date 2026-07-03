# Backlog

Planned work that is scoped but not yet started. Items graduate from here into
commits; keep entries current when scope changes, and delete them when shipped.

## 1. Onboarding wizard on first login

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
