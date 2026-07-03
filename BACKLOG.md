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

Queue complete. Next scoped item: GPO deployment artifacts (item 1 below).

## 1. GPO deployment artifacts: per-tenant GPO script plus ADMX pointers

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
