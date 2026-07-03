# Contributing to CheckDeployManager

Thanks for helping. This project is a small, focused Cloudflare Workers service; contributions should keep it that way.

## Development setup

```
npm install
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

Tests run offline against fixtures:

```
npm test
```

The stack is fixed: TypeScript on Workers, Hono for routing, D1 and R2 for storage, a dependency-free vanilla JS dashboard with no build step, and Vitest with `@cloudflare/vitest-pool-workers`. Please do not introduce frontend frameworks, KV, or additional runtime dependencies without discussion.

## Repository rules (enforced in review)

1. **No secrets, ever.** No tokens, API keys, credentials, or `.dev.vars` contents. The design requires zero Worker secrets; keep it that way.
2. **No real client data.** No real client names, real tenant GUIDs, real hostnames of managed organizations, or captured webhook payloads. All fixtures and samples use the fictional tenant from the design: Harborview Physical Therapy, GUID `f4a7c1d2-9b3e-4c8a-a1d6-2e5b7c9f0a34`.
3. **No em dashes** anywhere: code, comments, strings, docs, commit messages, or generated artifacts. Use hyphens, commas, colons, or restructure the sentence.
4. **PowerShell text rules.** Any PowerShell, including PowerShell emitted as text by the artifact generator, uses full descriptive variable and function names, 7-bit ASCII only, and never uses `&&` or `||`; sequence with separate statements or semicolons.
5. **Do not fabricate Check schema fields or Cloudflare platform behavior.** If a fact is not in `docs/architecture.md`, verify it against docs.check.tech, the CyberDrain/Check repository, or Cloudflare documentation before relying on it.
6. **The two delivery paths stay separate.** Detection rules are URL fetched by the extension; branding and enforcement are pushed via managed storage policy. Do not collapse them in code or UI.

## Testing expectations

- Every validation gate has a failing fixture.
- Artifact generators are golden-file tested. If you intentionally change generator output, regenerate goldens with `node scripts/generate-goldens.mjs` (bundle it first if your Node cannot strip types: `npx esbuild scripts/generate-goldens.mjs --bundle --format=esm --platform=node --outfile=.wrangler/tmp.mjs && node .wrangler/tmp.mjs`) and include the diff in your PR description.
- Tests must not depend on the network. The upstream fixture under `test/fixtures/` is a checked-in snapshot of the real CyberDrain rules file; refresh it deliberately, not incidentally.
- `npm test` and `npx tsc --noEmit` must both pass.

## Documentation

- `docs/architecture.md` and `docs/runbook.md` are hand-written and maintained; update them when behavior they describe changes.
- `docs/wiki/` is generated, never hand-edited. It mirrors the GitNexus knowledge-graph wiki (`.gitnexus/wiki`, which is local-only and not committed). After code changes that alter module structure or flows, refresh it with `node .gitnexus/run.cjs analyze`, then `node .gitnexus/run.cjs wiki`, then `npm run docs:wiki`, and commit the resulting diff.
- Each mirrored page carries a header comment naming the source commit, so a stale wiki is detectable at review time.

## Commit style

Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
