# Claude Code Build Handoff: CheckDeployManager

You are building CheckDeployManager, an open source, Cloudflare Workers hosted, multi tenant configuration service for the Check by CyberDrain browser extension, designed for an MSP (WideData Corporation) managing many client organizations. The complete approved design lives in `CheckDeployManager-Design.md` in this directory.

## Step 0: Required input

Read `CheckDeployManager-Design.md` in the repository root before writing anything. It contains the verified Check schemas, the D1 schema, the R2 layout, the route contracts, the policy generator sample outputs, the wrangler configuration, the runbook, and the threat model. It is the source of truth. If the file is not present, stop and ask for it. Do not proceed from this prompt alone.

Treat the design as approved and final. Do not re-litigate decisions. If you find a concrete technical conflict between the design and reality (an API that does not exist, a limit that blocks the approach), surface it with evidence and a proposed fix before working around it.

## Non-negotiable guardrails

- Never use an em dash anywhere, in code, comments, strings, generated artifacts, commit messages, or prose. Use hyphens, commas, colons, or restructured sentences.
- Never use `&&` or `||` in any PowerShell, including PowerShell emitted as text by the artifact generator. Sequence with separate statements or semicolons. (Shell commands you run in bash/zsh may use `&&` normally; the ban is PowerShell only.)
- Any PowerShell (written or generated as output text) uses full descriptive function names, no abbreviated helpers, and 7-bit ASCII only.
- No secrets, tokens, real client names, or real GUIDs anywhere in the repository. All fixtures and samples use the fictional tenant from the design (Harborview Physical Therapy).
- Do not fabricate Check schema fields or Cloudflare platform behavior. The design doc records what was verified against docs.check.tech and the CyberDrain/Check repo. If you need a fact not in the design, fetch the live source rather than guessing.
- License is MIT. Repository will live at github.com/DailenG/CheckDeployManager.
- Do not collapse the two delivery paths: detection rules are URL fetched by the extension; branding and enforcement are pushed via managed storage policy. They are separate throughout the code and UI.

## Locked stack decisions

- TypeScript on Cloudflare Workers, `main: src/index.ts`, static assets binding for the dashboard.
- Routing: Hono (small, Workers native). No heavier framework.
- Storage: D1 (binding `DB`) and R2 (binding `STORAGE`) exactly per the design schema and object layout. No KV.
- Dashboard UI: dependency free static HTML, CSS, and vanilla JS served from `src/ui` via the assets binding. No frontend build step, no framework. Dark mode is the default theme with a light toggle.
- Tests: Vitest with `@cloudflare/vitest-pool-workers`.
- Wrangler config: `wrangler.jsonc` exactly as specified in design section 6.2 (blank resource IDs so the Deploy to Cloudflare button and Wrangler auto-provisioning create them; no `routes` block; `ACCESS_TEAM_DOMAIN` and `ACCESS_APP_AUD` vars default empty).

## Local development accommodation (important)

Cloudflare Access only exists at the Cloudflare edge, so local runs need a development auth path that cannot leak into production:

- Add a var `ENVIRONMENT` defaulting to `"production"` in `wrangler.jsonc`, overridden to `"development"` only in a `[env.dev]` style configuration or via `.dev.vars` (which is gitignored).
- When `ENVIRONMENT === "development"`, skip Access JWT validation and use `DEV_OPERATOR_EMAIL` (from `.dev.vars`, default `dev@localhost`) as the audit identity. Log a loud startup warning that auth is bypassed.
- In every other case, require and fully validate the `cf-access-jwt-assertion` JWT (signature via team JWKS, `aud` match, expiry) and fail closed, including when `ACCESS_TEAM_DOMAIN` or `ACCESS_APP_AUD` are unset.
- Ship a `.dev.vars.example` file and gitignore `.dev.vars`.

Local persistence: D1 and R2 run locally under Miniflare via `wrangler dev` (state in `.wrangler/state`). Migrations apply locally with `npx wrangler d1 migrations apply DB --local`. The daily cron is testable locally with `npx wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=17+6+*+*+*"`. The upstream sync fetches the live CyberDrain rules file, so local runs need internet; also provide a checked-in fixture copy of a real upstream snapshot under `test/fixtures/` so tests never depend on the network.

## Build order

Work in the current directory as the repo root. Initialize git and commit at the end of each phase with a conventional commit message. Verify each phase's gate before moving on.

1. **Scaffold.** package.json (scripts: `dev`, `deploy` running migrations by binding name then `wrangler deploy`, `test`, `migrate:local`), wrangler.jsonc, tsconfig, `.gitignore` (`.wrangler/`, `.dev.vars`, `node_modules/`), LICENSE (MIT), stub README. Gate: `npx wrangler dev` starts and serves a placeholder.
2. **Migrations and data layer.** `migrations/0001_init.sql` verbatim from design section 2.1, `src/lib/db.ts` helpers, instance settings defaults seeded on first read. Gate: local migration applies cleanly.
3. **Upstream sync and merge engine.** `src/lib/upstream.ts` (fetch, hash compare, validate, snapshot to R2, diff summary), `src/lib/validate.ts` (all five gates from design 2.4, tolerant of unknown sections), `src/lib/merge.ts` (delta semantics from design 2.3, version suffix `+wdc.n` style using an instance-configurable suffix label). Gate: unit tests green against the fixture snapshot, including a drift fixture with unknown top-level keys.
4. **Public runtime endpoints.** `/rules/{guid}.json` with the exact header contract from design 3.1 (CORS, ETag, 304, uniform bare 404 for unknown and revoked, HEAD), `/preview/{token}.json` (live merge, no-store), `/assets/{guid}/logo`, `/hook/{guid}` (content type and 256 KB cap, stored as hostile data). Metrics upserts per design. Gate: endpoint tests green.
5. **Access auth layer.** `src/lib/access-jwt.ts` with JWKS caching, plus the development bypass above. Gate: tests for expired, wrong aud, wrong issuer, missing token, and dev-mode bypass.
6. **Management API.** All routes from design 3.2: tenants CRUD, draft get/put with dry-run validation, publish, rollback, versions, branding with logo upload validation (png/jpg/svg, 512 KB), policy settings, artifacts, GUID rotate and revoke, instance settings, upstream status and force sync, webhook inbox with disposition, audit query. Every mutation writes an audit row attributed to the verified operator email. Gate: API tests green.
7. **Policy artifact generator.** `src/lib/artifacts.ts` producing, per tenant: Chrome and Edge managed storage JSON, Firefox policies.json (fragment and full file with force-install), the .reg file (Chrome and Edge variants, registry layout per design 5.3 including the urlAllowlist and events numbered-value subkeys), the Intune variable block matching Check's Setup script variable names exactly (design 5.4, PowerShell guardrails apply to this generated text), and the CIPP field value table. Gate: golden-file tests for every artifact using the Harborview sample; assert generated output contains no em dash and no `&&`.
8. **Dashboard UI.** Dark-default single page app under `src/ui`: tenant list with health badges (last fetch, stale warning, revoked hits), tenant detail tabs (rules draft editor with validate button, versions with rollback, branding with logo upload and preview, policy settings, artifacts with copy and download, GUIDs), webhook inbox (payloads HTML-escaped, never interpreted), upstream status with diff history and sync-now, instance settings, audit log. Keep it clean and functional; no framework. Gate: manual walkthrough via `wrangler dev` completes the full tenant lifecycle locally.
9. **Cron handler.** `scheduled` export running upstream sync then retention cleanup (metrics beyond `metrics_retention_days`, webhook events beyond `webhook_retention_days` or dispositioned, upstream snapshots beyond `upstream_keep_snapshots`). Gate: `--test-scheduled` invocation performs a sync against the fixture-seeded state.
10. **Docs and packaging.** README with the Deploy to Cloudflare button (`https://deploy.workers.cloudflare.com/?url=https://github.com/DailenG/CheckDeployManager`), local development quickstart, and a genericized post-deploy runbook per design 7.2; `docs/runbook.md` (full version); CONTRIBUTING.md (including the no-secrets and fictional-fixtures rules); SECURITY.md summarizing the design section 8 threat model. Gate: docs reference nothing that does not exist in the repo.

## Local run quickstart (implement and document exactly this)

```
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npx wrangler dev
# open http://localhost:8787/manage
```

## Acceptance checklist (verify all before declaring done)

- [ ] `npm test` fully green
- [ ] `npx wrangler dev` serves dashboard, rules, preview, assets, and hook locally with local D1/R2
- [ ] Full lifecycle locally: create tenant, edit delta, validate, publish, curl rules URL (200 with contract headers, then 304 with If-None-Match), rotate GUID, revoke old GUID (404 plus revoked-hit counter), rollback a version (ETag reverts)
- [ ] Upstream sync works live and from fixture; a failing-validation fixture leaves the prior snapshot active and flags status
- [ ] All five artifact types render for the sample tenant and match the design section 5 shapes
- [ ] POST to `/hook/{guid}` with the design's sample false positive payload appears in the inbox, escaped
- [ ] Repo-wide sweep: zero em dashes, zero non-ASCII in any PowerShell text, zero `&&` in PowerShell text, zero secrets, zero real client data
- [ ] Production auth path fails closed when Access vars are unset; dev bypass only activates on `ENVIRONMENT=development`

Finish by printing a concise deployment walkthrough (button flow plus runbook steps 1-9 from the design) and the manual test checklist from design section 9.2.
