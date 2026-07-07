# Monitoring Guide: Catching Problematic Setups

How to notice trouble before a client does, using the signals this service
already records plus the tooling Cloudflare provides around every Worker.
Hostnames and values below are placeholders; the sample GUID belongs to the
fictional Harborview tenant used throughout the documentation.

The split to keep in mind: **the dashboard knows about tenants, Cloudflare
knows about traffic.** Anything tied to a real GUID (fetch counts, revoked
stragglers, webhook events) is tracked in the app. Anything that never
matches a tenant (typo'd GUIDs, enumeration probes, crashed requests,
traffic that stopped arriving) is only visible at the Cloudflare layer, by
design: unknown and revoked GUIDs both get a uniform bare 404 so probes
cannot map the tenant space, which also means the app deliberately does not
record unknown paths.

## 1. Signals the dashboard already surfaces

Check these first; they are tenant-attributed and need no Cloudflare
spelunking.

| Symptom | Where it shows |
|---|---|
| Revoked GUID still in use (device still on an old config URL) | Tenant list and the tenant's GUIDs tab: revoked hit counts increment on every request to a revoked GUID. Counts prune with `metrics_retention_days` (default 7), so a nonzero count is always recent |
| Fleet or device stopped fetching (policy removed, GPO unlinked, mass uninstall) | Tenant list: **Last fetch** column and the stale badge once `stale_fetch_hours` (default 48) passes with no fetch |
| Upstream sync broken or rules failing validation | Upstream page: sync status, last diff, failed snapshots flagged; the daily cron result lands here too |
| Suspicious end-user activity (blocked pages, false positives) | Inbox: webhook events per tenant; optionally relayed to your own tooling via `false_positive_relay_url` |
| Who changed what | Audit page: every operator action with timestamp and details |
| Running an outdated version | Dashboard footer: version plus a newer-release badge |

What the dashboard cannot show you: requests for GUIDs that do not exist.
A typo'd config URL in a GPO or RMM never matches a tenant, returns a bare
404, and leaves no tenant-side trace; the affected devices simply never
appear in fetch metrics. That gap is what the Cloudflare tools below close.

## 2. Workers Logs (the main tool)

`wrangler.jsonc` ships `observability.enabled = true`, so every deployment
collects invocation logs automatically: one entry per request with method,
path, response status, and outcome. In the Cloudflare dashboard: your
Worker > **Observability**. Retention and query depth vary by plan; the
free plan is enough for the recipes below.

Recipes, using the query builder's filters:

- **GUID typos in deployed policy.** Filter status = `404` and path
  starts with `/rules/`. A device with a mistyped config URL polls the
  same wrong path forever on its update interval, so a typo shows up as a
  steady drumbeat of 404s on one path. Compare the path against the
  tenant's real config URL on its Artifacts tab; the fix is redeploying
  the corrected artifact to that client.
- **Revoked GUID stragglers, request-level view.** Filter path =
  `/rules/<the-revoked-guid>.json`. The dashboard already counts these
  per GUID; the logs add timing and volume when you need to judge whether
  a straggler is one forgotten lab machine or a whole site still on the
  old policy.
- **Enumeration probing.** Many *distinct* 404 paths under `/rules/` in a
  short window is someone guessing GUIDs, not a typo (a typo is one path
  repeating). The GUID space makes guessing hopeless, but a probe is
  worth knowing about; consider the rate-limiting hardening step in the
  runbook if it persists.
- **Crashes and 5xx.** Filter outcome = `exception` or status >= `500`.
  The Worker is designed to fail closed with clean JSON errors, so any
  exception is a bug worth reporting upstream.
- **Cron health.** Scheduled invocations (the daily 06:17 UTC sync)
  appear in the same logs; pair with the Upstream page, which shows the
  outcome the sync recorded.

Two notes: logs are head-sampled (default rate 1, so complete, but a
lowered `head_sampling_rate` makes counts approximate), and if you need
retention beyond your plan's window, **Logpush** (paid plans) can stream
Workers trace events to an R2 bucket with filters, for example only
non-`ok` outcomes.

## 3. Workers Metrics (the trend view)

Worker > **Metrics** shows request volume, error rates, and CPU time
without any query. The one signal to internalize: **total request volume
is your fleet heartbeat.** Managed browsers poll on `updateInterval`
(default 24 h), so volume is roughly fleet size divided by interval, and a
sustained drop means devices stopped fetching, before any individual
tenant trips its stale badge. Per-tenant attribution then lives on the
tenant list.

## 4. Alerts instead of checking

- **Account > Notifications**: add the Workers usage alert (approaching
  plan limits), which the runbook's hardening step already recommends.
- **Workers Builds events**: a failed build means your last push never
  deployed, the exact failure mode of runbook section 0.1. Builds status
  is visible on the Worker's Deployments tab and as a commit check on
  your repo copy; for push-style alerts, Cloudflare's Event Subscriptions
  can send build started/failed/canceled events to a webhook (Slack,
  Discord, or this service's own inbox relay pattern), and Cloudflare
  publishes a ready-made `workers-builds-notifications-template`.
- **GitHub side**: your repo copy runs the same CI as upstream; a red
  check on a push you made is worth reading before assuming the deploy
  matches your intent (the Workers Build is separate and can succeed
  while CI fails, and vice versa).

## 5. Custom domain zone signals

Once the custom hostname is attached (runbook 1.4), the zone dashboard
adds coverage the `workers.dev` hostname does not get:

- **Analytics > Traffic** for the hostname: status-code mix over time; a
  rising 404 share on a stable fleet is the zone-level echo of the typo
  and straggler recipes above.
- **Security > Events**: matches from WAF custom rules and the optional
  rate-limiting rules (runbook hardening step). After adding rules, watch
  them in log-only mode here before switching to block, so a
  misconfigured rule cannot silently starve the fleet of rules files.

## 6. Zero Trust signals (the management surface)

Zero Trust > **Logs > Access** records every login attempt to `/manage`
and `/api`, allowed and denied, with identity and application. Two
patterns matter:

- **Denied logins for a legitimate operator**: an Access policy or IdP
  change broke the allow rule; fix per the runbook's lockout guidance
  before it becomes a full lockout.
- **Attempts from identities you do not recognize**: expected noise on
  any internet-facing login page, but a spike aimed at your team domain
  is worth a look at the policy's strictness.

The Worker also validates the Access JWT itself and fails closed, so a
misconfigured Access application degrades to 403s, never to an open
management surface; the Access logs are how you notice the 403s are
happening to people who should be getting in.

## 7. Suggested cadence

| When | Check |
|---|---|
| After every client rollout | Tenant's Last fetch moves within one update interval; no new 404 drumbeat in Workers Logs |
| After revoking a GUID | Revoked hits reach zero within one update interval; stragglers get the corrected artifact |
| Weekly | Tenant list stale badges, Inbox, Upstream sync status, Workers Metrics volume trend |
| After any Access or IdP change | Log in from a private window; scan Access logs for unexpected denials |
| After any push to your repo copy | Workers Build succeeded (Deployments tab or commit check); CI green |
