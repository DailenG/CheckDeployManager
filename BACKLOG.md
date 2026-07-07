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

- [x] v0.3.0 release (GPO artifacts, webhook relay, CIPP warning, footer)
- [x] Sync upstream workflow: one-click updater shipped in every
      deploy-button copy (Actions tab). Clean merges push and redeploy;
      conflicts open an upstream-sync PR with the conflicted files listed,
      resolvable in the GitHub web editor. Guarded to no-op on the
      upstream repo itself.

- [x] Tenant defaults: instance-level branding and policy inheritance.
      New `tenant_defaults` instance setting (JSON `{branding, policy}`,
      strictly validated on the settings PUT) resolved at artifact
      generation as a layer between hardcoded fallbacks and tenant values;
      empty branding strings inherit, absent policy keys inherit,
      `cippTenantId`/`cippServerUrl`/`enableDebugLogging` never inherit.
      Instance default logo (PUT/DELETE `/api/instance/default-logo`)
      served through each tenant's stable `/assets/{guid}/logo` URL.
      Settings page gained the Tenant defaults editor panel; Branding and
      Policy tabs show inherited hints, and the Policy tab normalizes on
      save so values matching the default layer stay inherited. 11 new
      tests (precedence per field class, parse/validation, logo fallback,
      end-to-end artifacts); goldens stayed byte-identical. Runbook
      section documents the propagation caveat. Entry deleted below per
      convention. Deferred phase 2 ideas moved to future candidates.

- [x] Tenant defaults phase 2: baseline rules delta (`baseline_rule_delta`
      instance setting, same shape as a tenant delta, validated on save,
      merged beneath every tenant delta via the new `applyDelta` split out
      of `mergeRuleset`; Settings-page editor plus a **Republish all
      tenants** action reusing the upstream auto-publish loop extracted as
      `republishAllTenants`), Duplicate tenant copying only the rules delta
      draft (branding and policy inherit), and an optional wizard step for
      standard branding defaults. 9 new tests (layering order, tenant
      suppression of baseline indicators, duplicate-id gate, end-to-end
      publish/preview/republish, duplicate isolation).

- [x] v0.4.0 release (tenant defaults with inheritance, baseline rules
      delta with fleet republish, tenant duplicate, wizard defaults step,
      refreshed docs and screenshots)

- [x] v0.5.0 (untagged; superseded same day): toolbar pinning in every
      registry artifact, RMM deployment script with browser toggles,
      CIPP wizard tie-in, wizard branding step gains primary color and
      default logo, workers_dev/preview_urls declared explicitly.

- [x] v0.5.1 release (guided rules draft editor with Easy add and the
      effect summary, policy deployment banner, deploy-copy CI fixes,
      monitoring guide, refreshed docs, screenshots, and wiki)

- [x] Tenant onboarding wizard: shipped in full (Onboard wizard button on
      the tenant list, Continue onboarding on never-published tenants,
      route with seven live-state steps ending at a per-method deployment
      checklist with inline downloads; Intune checklist labeled untested;
      detail response gained last_fetch_at for the verify step, with a
      test). Entry deleted below per convention.

- [x] v0.6.0 release (tenant onboarding wizard, refreshed docs and wiki)

Queue complete.

The numbered sections below are scoped and ready to start, in priority
order. Priority reasoning: the sparkline is the only remaining item that
surfaces operational signal the dashboard already collects but hides
(rollout failures show up as fetch counts going quiet), so it pays off
daily; the lockout drill is cheap insurance against the one failure mode
that takes the whole dashboard away; rate-limiting-as-code hardens public
endpoints but duplicates protections Cloudflare already provides by
default, so it goes last. Sections 4 and up were scoped later and sit in
arrival order, not priority; 1 and 5 share a query and are best built
together.

## 1. Fetch metrics sparkline on the tenant list

**Goal:** make fetch health visible at a glance. The dashboard already
counts every rules fetch per tenant per day (`fetch_metrics`), but the
tenant list shows only "last fetch" -- a tenant whose fetch volume quietly
dropped (policy removed from an RMM, GPO unlinked, mass uninstall) looks
healthy until it goes fully stale. A 7-day per-tenant sparkline turns that
into a shape the eye catches.

**Decision: server-side zero-filled series, inline SVG.** The API returns a
dense array (one integer per day, oldest first) so the client stays a dumb
renderer and the series is unit-testable where the data lives. Inline SVG
polyline, no chart library (the dashboard is dependency-free by design).

**Mechanics:**

- API: extend the existing `GET /api/tenants` list handler with one grouped
  query over `fetch_metrics` (`SUM(hits + not_modified)` per tenant per day,
  last 7 days), zero-fill missing days server-side, and attach
  `fetch_series: number[]` to each tenant row. Window fixed at 7 days: it
  matches the default `metrics_retention_days`, and longer retention does
  not widen the sparkline.
- UI: a small `sparkline(series)` helper in `app.js` returning an inline
  `<svg>` with a single polyline (about 90x24), rendered in the Last fetch
  column; `title` attribute lists per-day counts for hover. All numeric
  data, but keep `esc()` discipline anyway.
- Not-modified hits count as fetches (a 304 is a healthy check-in).
- Tenants with no metrics rows render a flat zero line, same as stale.

**Tests:** seed `fetch_metrics` rows across several days (including gaps
and a day with only 304s), assert the API series is dense, ordered oldest
first, zero-filled, and sums hits plus not_modified; assert a tenant with
no rows gets seven zeros.

**Sizing:** half a day. The query and zero-fill are the substance; the SVG
helper is small.

**Implementation plan:** [docs/plans/deployment-health.md](docs/plans/deployment-health.md)
(shared with sections 5 and 6).

## 2. Access lockout drill runbook section

**Goal:** an operator locked out of the dashboard (broken Access policy,
IdP misconfiguration, team-domain typo) recovers calmly from a rehearsed
page instead of improvising against production. The architecture doc
already names the break-glass path (threat table, "Access lockout" row);
this item turns it into a numbered drill.

**Decision: docs only.** No code changes; the break-glass path must work
when this app is exactly what is broken, so it can only rely on Cloudflare
surfaces.

**Mechanics:** a "Access lockout drill" subsection under runbook
troubleshooting covering:

- Symptoms and blast radius: operator-facing 403s or an OTP loop on
  `/manage` and `/api`; public endpoints (`/rules`, `/preview`, `/assets`,
  `/hook`) keep serving throughout, so clients are unaffected -- state this
  first, it is what makes the drill calm.
- Recovery path: Cloudflare dashboard (independent of Access) > Zero Trust
  > Access > Applications > edit the policy; fix or temporarily broaden the
  email rule; verify from a private window; re-tighten.
- Second-level lockout: if the Zero Trust dashboard itself is unreachable,
  the account owner login and `wrangler` (API token auth) both bypass it;
  worst case, `ACCESS_TEAM_DOMAIN`/`ACCESS_APP_AUD` can be corrected in
  `wrangler.jsonc` and redeployed.
- What NOT to do: never set `ENVIRONMENT=development` on a public
  deployment to bypass Access (the wizard already warns about this).
- Drill checklist: rehearse the path twice a year; verify the account has
  at least two members able to edit Access policies.

**Tests:** none (documentation). Verify each dashboard path name against
the current Cloudflare UI while writing.

**Sizing:** one to two hours.

## 3. Rate limiting guidance as code

**Goal:** the architecture doc prescribes WAF rate limits on the public
endpoints (tenant-enumeration and webhook-abuse mitigations) but leaves
creation to manual clicking. Ship the rules as copy-paste code so every
deployment applies the same limits.

**Decision: documented snippets, not managed infrastructure.** This repo
deploys with zero secrets by design; a Terraform state or an API-token
workflow would break that. Snippets live in docs and are applied by the
operator, who owns the zone.

**Mechanics:**

- New `docs/waf.md` (linked from the runbook's optional-hardening step)
  with two equivalent forms: a Terraform `cloudflare_ruleset` block
  (`ratelimit` phase) and a raw API `curl` against the rulesets endpoint.
- Rules: per-IP rate limit on `/rules/*` and `/assets/*` (generous; the
  extension polls on multi-hour intervals), a tighter one on `/hook/*`
  (webhook inbox spam), and a note that `/manage`+`/api` sit behind Access
  and need none.
- Document plan-tier constraints (rate limiting availability and counting
  characteristics differ on Free vs paid zones) and how to observe rule
  matches (Security events) before switching from log to block.
- Verify parameter names against the current Cloudflare provider and API
  docs at implementation time; both have churned.

**Tests:** none executable in CI (the repo has no zone); include an
"expected behavior" section (curl loop returning 429) the operator can run
as acceptance.

**Sizing:** half a day, mostly verification against current Cloudflare
schemas.

## 4. Color swatch on the Primary color fields

**Goal:** the Primary color inputs (tenant Branding tab, Tenant defaults
panel, wizard branding step) are plain text fields, so a typo like
`#F7700` or `1B6FA8` only shows up after deployment when the extension
renders the wrong brand color. A live swatch inside the field makes the
value verifiable at a glance, and clicking it should open a color picker.

**Decision: progressive enhancement around the existing text inputs.** The
text field stays the source of truth (operators paste brand hex codes);
the swatch and picker are conveniences layered on top, so nothing changes
for keyboard-only or paste workflows.

**Mechanics:**

- A `colorField(id, label, value, inherited)` helper in `app.js` wrapping
  the current text input in a `position: relative` container with a small
  swatch square (about 16x16, `border-radius: 3px`) absolutely positioned
  inside the field's right edge.
- The swatch background tracks the input on every `input` event; an
  invalid or empty value renders a neutral checkerboard/empty style rather
  than silently showing the last good color. Validity check: assign to a
  detached `option.style.color` and see if it sticks (covers hex, rgb(),
  and named colors without a regex).
- Clicking the swatch opens the native picker: a visually hidden
  `<input type="color">` overlaying the swatch, kept in sync both ways.
  Native pickers only speak `#rrggbb`, so seed it from the parsed value
  when valid and write `#rrggbb` back into the text field on change.
  `input[type="color"]` base styling already exists in `styles.css`.
- Apply to all three Primary color fields: `#b-color` (Branding tab, keep
  the inherited-placeholder behavior), `td-b-primary_color` (Settings
  defaults panel), and `setup-td-color` (wizard branding step).

**Tests:** none in CI (pure client-side rendering; the dashboard UI has no
test harness). Manual pass across the three fields, including an inherited
blank value on the Branding tab.

**Sizing:** two to three hours.

## 5. Deployment health verdicts on the tenant list

**Goal:** turn the per-GUID fetch counts the service already records into
judgments an operator can act on without reading numbers. `fetch_metrics`
is per tenant, per GUID, per day (hits, 304 check-ins, last fetch), so the
data for all of these already exists; what is missing is the verdict:

- **Never fetched since publish.** A tenant with a published version whose
  active GUID has zero fetch rows is a rollout that never landed (wrong
  config URL in the RMM, policy not applied). Today this hides behind an
  empty Last fetch cell that looks identical to "new tenant, give it time".
- **Estimated device count and shrinkage.** Managed browsers poll every
  `updateInterval` hours, so yesterday's `hits + not_modified` for a GUID
  approximates its device count times `24 / updateInterval`. A material
  day-over-day or week-over-week drop is devices going dark (policy
  unlinked, mass uninstall) long before the stale badge trips.

**Decision: verdicts computed in the list API, rendered as badges.**
Extends the sparkline item (section 1); both read the same table and
should land as one list-API change if built together. Thresholds start
crude and hardcoded (never-fetched: published plus zero rows ever;
shrinkage: yesterday under half of the trailing-week daily average with at
least 10 expected fetches); refine only if real fleets prove them noisy.

**Mechanics:**

- Extend the `GET /api/tenants` list query with per-tenant aggregates over
  `fetch_metrics` for the active GUID: total rows ever, yesterday's sum,
  trailing 7-day daily average.
- Resolve each tenant's effective `updateInterval` (tenant override, else
  instance default, else 24) server-side for the estimated device count:
  `round(yesterday / (24 / interval))`.
- Tenant list badges: `never fetched` (accent) when published with zero
  rows; `fleet shrinking` (warn) on the drop rule; tooltip carries the
  numbers. Detail header shows "about N devices" with the estimate.
- The metrics window is `metrics_retention_days` (default 7), which bounds
  the trailing average; document that raising retention sharpens nothing
  in these verdicts (they only look back seven days).

**Tests:** seed fetch_metrics shapes for each verdict (published but never
fetched, steady fleet, halved fleet, brand-new tenant with no publish) and
assert the API emits the right flags and estimates; assert a 304-only
tenant counts as healthy.

**Sizing:** one day, shared with the sparkline item if done together.

**Implementation plan:** [docs/plans/deployment-health.md](docs/plans/deployment-health.md).

## 6. Analytics Engine dataset for long-horizon fetch telemetry

**Goal:** D1 keeps seven days of fetch counts by default, enough for the
dashboard's verdicts but not for "how did this quarter's rollout trend" or
"when exactly did this GUID go quiet". Cloudflare's Workers Analytics
Engine is purpose-built for this: unlimited-cardinality data points
written from the Worker with a binding, queried over a roughly 90-day
window with SQL.

**Decision: write-only from the Worker; queried externally.** Writing
needs only a Wrangler binding (no secret), fitting the zero-secret design.
Querying requires an account API token, so in-dashboard charts are out of
scope by design; the operator queries the SQL API directly or points
Grafana's Cloudflare data source at it. Revisit only if the no-secrets
rule is ever revisited.

**Mechanics:**

- `analytics_engine_datasets` binding (for example `FETCH_EVENTS`) in
  `wrangler.jsonc`; the deploy button and Wrangler provision it like the
  other bindings.
- In the rules route, one `writeDataPoint` per request alongside the
  existing D1 counters: blobs `[tenant_id, guid, kind]` where kind is
  `hit`, `not_modified`, or `revoked`; doubles `[1]`; index the guid.
  Unknown-GUID 404s are recorded as kind `unknown` with a truncated hash
  of the path instead of the raw value, so attacker-controlled junk never
  lands verbatim in telemetry.
- Docs: a monitoring-guide section with two or three copy-paste SQL API
  queries (per-GUID daily series beyond the D1 window, first/last seen
  for a GUID, unknown-404 volume) and a pointer to the Grafana data
  source.
- Graceful no-op when the binding is absent (older copies mid-update).

**Tests:** unit-test the data-point shape via an injected fake binding;
assert the rules route still serves when the binding is missing.

**Sizing:** half a day of code; the useful part is the documented queries.

**Implementation plan:** [docs/plans/deployment-health.md](docs/plans/deployment-health.md),
phase 4.

## 7. Sync upstream cannot push workflow-file changes

**Goal:** a real copy hit this: when an upstream release modifies anything
under `.github/workflows/`, the Sync upstream workflow's push is rejected
with `refusing to allow a GitHub App to create or update workflow ...
without workflows permission`. The default `GITHUB_TOKEN` can never hold
the `workflows` scope, so both the direct push and the conflict-PR branch
push fail, and the run ends in a raw git error instead of guidance.

**Decision: optional token, mandatory clear failure.** Two changes to
`sync-upstream.yml`:

- Accept an optional repository secret (`SYNC_TOKEN`, a fine-grained PAT
  with contents write plus workflows) used for checkout/push when present,
  falling back to `github.token` otherwise. Operators who set it keep the
  one-click path even across workflow-file releases; nobody is required
  to.
- Preflight: after fetching upstream, if the pending merge touches
  `.github/workflows/**` and no `SYNC_TOKEN` is configured, stop before
  merging and write a step summary explaining the three ways out: add the
  secret and rerun, run the manual merge locally (an operator's own push
  carries the scope), or edit the changed workflow files once in the web
  UI and rerun.

Runbook's updating section gains the same explanation. Note the secret
lives in GitHub Actions, not the Worker; the zero-Worker-secrets rule is
untouched.

**Tests:** none runnable in CI (the failure mode needs a foreign repo);
verify by syncing a real copy across a workflow-touching release.

**Sizing:** two hours.

## 8. Future candidates (unscoped)

- **Wiki regeneration automation.** CI cannot regenerate the GitNexus wiki
  (needs the local index and an LLM key); today the freshness nudge is a
  soft CI warning. Not scoped because the blocker is external: revisit if
  GitNexus grows a headless/CI mode or the wiki moves to a
  no-LLM-required generator.
