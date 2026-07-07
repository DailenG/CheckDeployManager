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

Queue complete.

The numbered sections below are scoped and ready to start, in priority
order. Priority reasoning: the sparkline is the only remaining item that
surfaces operational signal the dashboard already collects but hides
(rollout failures show up as fetch counts going quiet), so it pays off
daily; the lockout drill is cheap insurance against the one failure mode
that takes the whole dashboard away; rate-limiting-as-code hardens public
endpoints but duplicates protections Cloudflare already provides by
default, so it goes last.

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

## 5. Future candidates (unscoped)

- **Wiki regeneration automation.** CI cannot regenerate the GitNexus wiki
  (needs the local index and an LLM key); today the freshness nudge is a
  soft CI warning. Not scoped because the blocker is external: revisit if
  GitNexus grows a headless/CI mode or the wiki moves to a
  no-LLM-required generator.
