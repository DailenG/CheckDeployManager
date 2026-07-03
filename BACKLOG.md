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

Queue complete.

## 1. Future candidates (unscoped)

- **Wiki regeneration automation.** CI cannot regenerate the GitNexus wiki
  (needs the local index and an LLM key); today the freshness nudge is a
  soft CI warning. Revisit if GitNexus grows a headless mode.
- **Fetch metrics sparkline** on the tenant list, from existing
  `fetch_metrics` rows; no schema change needed.
- **Access lockout drill doc.** A short runbook section rehearsing the
  break-glass path (edit the Access policy from the Cloudflare dashboard).
- **Rate limiting guidance as code.** The runbook's optional WAF rules could
  ship as a documented Terraform or API snippet for operators who want them.
- **Baseline rule delta** (tenant defaults phase 2): an instance-level rule
  delta merged before each tenant delta, for standard MSP exclusions such
  as RMM domains.
- **Duplicate tenant for the rules delta only** (tenant defaults phase 2):
  branding and policy now inherit, so duplication would copy just the delta.
- **Tenant defaults wizard step.** A small "your standard support info"
  step in the setup wizard feeding the tenant_defaults setting.
