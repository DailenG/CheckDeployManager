# CheckDeployManager Runbook

Post-deploy setup and day-to-day operations. Hostnames below are placeholders; substitute your own. The sample tenant used throughout the documentation, Harborview Physical Therapy, is fictional.

## 0. Deploy button walkthrough

The Deploy to Cloudflare flow asks for the following. Fields not listed here (project name, D1 database, R2 bucket) are self-explanatory; create new resources unless deliberately reusing existing ones.

| Field | What to enter |
|---|---|
| Git repository | The flow clones this repo into your own GitHub or GitLab account and deploys from that copy; pick the destination account and name |
| Build command | Leave blank; there is no build step |
| Deploy command | `npm run deploy` (runs D1 migrations, then `wrangler deploy`) |
| `ENVIRONMENT` (default `production`) | Keep `production`; `development` disables auth and is local-only |
| Second `ENVIRONMENT` / `DEV_OPERATOR_EMAIL` | Sourced from `.dev.vars.example`; leave blank or remove |
| `ACCESS_TEAM_DOMAIN` | Your Zero Trust team domain as a bare hostname (`<team>.cloudflareaccess.com`) if known, else any placeholder, corrected in 1.3 |
| `ACCESS_APP_AUD` | Placeholder; the real AUD tag is created in 1.2 and set in 1.3 |

Placeholder Access values are safe: management routes fail closed until both values validate real tokens, while the public endpoints serve immediately.

## 1. Post-deploy setup (one time)

Prerequisite: the Deploy to Cloudflare button (or `npm run deploy` from a clone) has already provisioned the D1 database and R2 bucket, applied migrations, and deployed the Worker to `checkdeploymanager.<account>.workers.dev`.

### 1.1 Add the One-time PIN identity provider

Zero Trust > Settings > Authentication > Login methods > Add new > One-time PIN.

New Zero Trust organizations default to the Cloudflare identity provider and do not include OTP automatically. Any IdP works if you prefer another; the policy in the next step is what gates access.

### 1.2 Create the Access application

Zero Trust > Access > Applications > Add an application > Self-hosted.

- Application domain entries: `checkdeploymanager.<account>.workers.dev` with paths `manage*` and `api*`. If you attach a custom hostname later, add the same two paths for it.
- Policy: Action Allow, Include: Emails ending in `@<your-domain>`.
- Save, then open the application's overview and record the **Application Audience (AUD) tag**.

The Access free plan covers up to 50 users.

### 1.3 Set the Worker variables

Workers and Pages > checkdeploymanager > Settings > Variables and Secrets:

- `ACCESS_TEAM_DOMAIN` = `<your-team>.cloudflareaccess.com`
- `ACCESS_APP_AUD` = the AUD tag from 1.2

These are identifiers, not secrets. The Worker validates the `cf-access-jwt-assertion` header on every `/manage` and `/api` request: signature against the team JWKS, audience match, and expiry. Until both variables are set, every management request is rejected (fail closed), so complete this step before first use.

### 1.4 Attach the custom domain (recommended)

Workers and Pages > checkdeploymanager > Settings > Domains and Routes > Add > Custom domain.

The hostname you choose is baked into every generated client policy, so treat it as permanent. After attaching, add the same hostname with `manage*` and `api*` paths to the Access application from 1.2.

## 2. First-run configuration

1. Open `https://<your-hostname>/manage` and authenticate via OTP.
2. Go to **Settings** and configure:
   - **Public base URL**: `https://<your-hostname>` (used in every rules URL, hook URL, and artifact)
   - **Default CIPP server URL**: your CIPP instance, or blank to disable CIPP fields by default
   - **Version suffix label**: short label stamped into published versions (`1.2.3+<label>.<n>`)
   - Retention: metrics days (default 7), webhook days (default 90), stale-fetch hours (default 48), snapshots to keep (default 10)
3. Go to **Upstream** and click **Sync now**. Confirm the snapshot validates and shows as active.
4. Create **tenant zero** for your own organization, publish, and point a test browser at its Config URL (enroll yourself the same way clients are enrolled).
5. Create the first client tenant: branding (logo up to 512 KB, png/jpg/svg, 48x48 recommended), policy settings, publish, then copy artifacts from the Artifacts tab into your deployment tooling.

## 3. Routine operations

### Publishing a rules change

1. Tenant > Rules draft: edit the delta JSON. Keys: `add_exclusion_domain_patterns`, `add_trusted_login_patterns`, `add_phishing_indicators`, `suppress_indicator_ids`, `raw_overrides`.
2. **Save and validate** runs the gates in dry-run and reports findings.
3. Use the tenant preview URL in a test browser to confirm behavior against the live draft.
4. **Publish**. The merge runs against the active upstream snapshot, writes an immutable version to R2, and moves the serving pointer. Extensions pick it up within their update interval (24 h by default; `max-age` on the endpoint is 300 s).

### Rolling back

Tenant > Versions > Roll back to this. The pointer moves to the selected immutable version instantly; the endpoint ETag reverts with it.

### GUID rotation and revocation

1. Tenant > GUIDs > Rotate. The new GUID serves immediately; the old one keeps serving.
2. Regenerate artifacts (they use the newest active GUID) and roll them out to client policies.
3. Watch traffic move to the new GUID, then **Revoke** the old one.
4. After revocation, the old URL returns a bare 404 and hits are counted on the GUIDs tab; a nonzero count means some endpoints still carry the old policy.

### Upstream sync

The cron runs daily (06:17 UTC). Each sync fetches the CyberDrain rules file; on change it validates, snapshots to R2, records a diff summary, and republishes every tenant with a published version using that tenant's frozen delta. A snapshot that fails validation never replaces the active one; it is stored, flagged in the history, and the dashboard shows the failure. Force a sync any time from Upstream > Sync now.

### Webhook inbox

False positive reports and other extension events POST to `/hook/{guid}` and land in the Inbox. Payloads are stored verbatim, treated as hostile, and always rendered escaped. Disposition events as reviewed or dismissed; dispositioned events are purged by the daily cleanup, undispositioned ones after the retention window.

### Decommissioning a tenant

Revoke all GUIDs, wait for revoked-hit counters to drain (confirming no clients still point at it), then Tenant > Delete. Deletion removes the tenant's rows and R2 objects; audit entries are retained.

## 4. Verification checklist

After bring-up or a significant change:

1. `curl -i https://<host>/rules/<guid>.json`: expect 200, `Content-Type: application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`, `Cache-Control: public, max-age=300`, an `ETag`, and `X-Content-Type-Options: nosniff`. Repeat with `If-None-Match: <etag>` and expect 304.
2. Load Check in a test browser, set the Config URL to the tenant preview URL, use Update Rules Now, and confirm the Configuration Overview shows the tenant version string (`x.y.z+<label>.<n>`).
3. Add a phishing-simulation domain to the delta, publish, and verify the extension no longer flags it.
4. Import the generated `.reg` on a test VM, run `gpupdate /force`, and verify the managed-by-policy banner and values in the extension options page.
5. Firefox: place the generated `policies.json` in the distribution directory, restart, and verify branding and Config URL.
6. Intune: paste the generated variable block into Check's setup script workflow, package, deploy to a pilot ring, and confirm the detection script passes.
7. Click Report False Positive on a blocked test page and confirm the event lands in the Inbox.
8. Rotation drill: rotate, confirm both GUIDs serve, revoke the old, confirm 404 and the revoked-hit counter increments.
9. Rollback drill: publish a deliberately noisy rule, roll back one version, and confirm the endpoint ETag reverts.

## 5. Recovery

- **Bad tenant publish**: roll back from the Versions tab (pointer move, audited).
- **Bad upstream snapshot**: failed validation never activates. For a bad-but-valid upstream change, roll back affected tenants; versions record which snapshot they merged against.
- **Bad Worker deploy**: `npx wrangler rollback` restores the previous deployment.
- **Data disaster**: D1 Time Travel restore, plus R2 objects are immutable per publish.
- **GUID compromise**: rotate, roll client policies, revoke the old GUID, watch the revoked-hit counter drain.
- **Access lockout**: the account owner can edit the Access policy from the Cloudflare dashboard, which is independent of this app.
