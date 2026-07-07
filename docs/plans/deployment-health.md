# Implementation Plan: Deployment Health (backlog 1, 5, 6)

Detailed plan for the fetch sparkline (backlog 1), the health verdicts
(backlog 5), and the Analytics Engine dataset (backlog 6). Phases 1-3 ship
together as one change (they share a query and a render pass); phase 4 is
an independent follow-up. Written ahead of implementation; verify line
references against current main before starting.

## Phase 1: list API aggregates (`src/routes/api/tenants.ts`)

All server work lands in the existing `GET /` list handler (currently
around `tenants.ts:16-40`), which already runs one row-per-tenant query
with subselects. Add one more grouped query over `fetch_metrics` and merge
in JS; do not widen the main query with per-day subselects.

1. **Series query.** After the existing query:

   ```sql
   SELECT tenant_id, day, SUM(hits + not_modified) AS fetches
   FROM fetch_metrics
   WHERE day >= ?
   GROUP BY tenant_id, day
   ```

   Bind the UTC date seven days ago (`YYYY-MM-DD`, same format the table
   stores; see `today()` in `src/lib/db.ts`). Fold into
   `Map<tenant_id, Map<day, fetches>>`, then zero-fill each tenant into a
   dense 7-integer array, oldest first, ending at **yesterday** (UTC).
   Today is always a partial day and would make every fleet look like it
   is shrinking, so it is excluded from the series and from every verdict
   below. 304s count as fetches throughout: a `not_modified` check-in is a
   healthy device.

2. **Never-fetched verdict.** Needs "has the active GUID ever been
   fetched", which the series window cannot answer alone. Add one
   subselect to the main query:

   ```sql
   (SELECT COUNT(*) FROM fetch_metrics m JOIN tenant_guids g
     ON g.guid = m.guid
    WHERE g.tenant_id = t.id AND g.status = 'active') AS active_guid_fetch_rows
   ```

   Verdict `never_fetched` when: a published version exists AND
   `active_guid_fetch_rows = 0` AND `published_at` is older than the grace
   window of `max(effective updateInterval, 24) + 6` hours (a fresh
   publish gets one full polling cycle plus slack before it is called a
   failed rollout). Scoped to the active GUID deliberately: after a GUID
   rotation the verdict answers "did the fleet move to the new URL",
   which is exactly when it matters. Retention pruning means "ever" is
   really "within `metrics_retention_days`"; that is fine, because a
   tenant fetched last month but silent for a week is the stale badge's
   job, not this one's.

3. **Effective updateInterval.** Resolve per tenant, mirroring the layer
   order in `resolvePolicy` (`src/lib/artifacts.ts`): tenant's
   `tenant_policy_settings.settings_json` key if present, else
   `parseTenantDefaults(settings.tenant_defaults).policy.updateInterval`,
   else 24. Fetch the per-tenant JSON with one more subselect on the main
   query (`SELECT settings_json FROM tenant_policy_settings ...`) and
   parse in JS; do not duplicate the artifact resolver, a 10-line helper
   in the route file is enough and the two share only this one key.

4. **Device estimate.** `estimated_devices =
   Math.round(yesterday / (24 / interval))` where `yesterday` is the last
   element of the series; `null` when the tenant has no published version
   or the series is all zeros.

5. **Shrinkage verdict.** `shrinking` when
   `yesterday < 0.5 * avg` where `avg` is the mean of the six days before
   yesterday, guarded by `avg >= 10 / (24 / interval)` so single-device
   and near-empty tenants never flap. Constants at the top of the file
   (`SHRINK_RATIO = 0.5`, `SHRINK_MIN_DAILY = 10`), commented as
   deliberately crude per the backlog.

6. **Response shape.** Extend each tenant row with:

   ```
   fetch_series: number[]        // 7 ints, oldest first, ends yesterday
   fetch_health: "ok" | "never_fetched" | "shrinking"
   estimated_devices: number | null
   ```

   Additive only; existing fields and `stale` behavior unchanged. If both
   verdicts somehow apply, `never_fetched` wins (it is the more specific
   diagnosis).

## Phase 2: UI (`src/ui/manage/app.js`)

The tenant list renders in `renderTenants` (currently around lines
246-300): badges array, one `<tr>` per tenant, thead at line 278.

1. **`sparkline(series)` helper** near the other small helpers (`ago`,
   `esc`): returns an inline `<svg>` (about 90x24, `viewBox` computed from
   `max(series, 1)`) with a single `<polyline>`, `stroke` using
   `var(--accent)`, no fill, plus a `<title>` child listing per-day counts
   for hover. All-numeric input, but wrap day labels in `esc()` anyway per
   house discipline. No chart library; the dashboard is dependency-free.

2. **Column.** Render the sparkline inside the existing **Last fetch**
   cell under the `ago()` text rather than adding a column, so the table
   stays four columns and the empty-state `colspan="4"` at line 279 does
   not change. Skip the SVG entirely for all-zero series (a flat line
   reads as data where there is none; the stale badge already covers it).

3. **Badges.** In the existing badges block:
   - `fetch_health === "never_fetched"`:
     `<span class="badge bad">never fetched</span>` (bad, not accent: a
     published-but-never-fetched tenant is a failed rollout).
   - `fetch_health === "shrinking"`:
     `<span class="badge warn">fleet shrinking</span>`.
   - `estimated_devices !== null && estimated_devices > 0`: append
     `about N devices` to the sparkline `<title>` tooltip, and show it in
     the tenant detail header (rendered in `renderTenantDetail`) as muted
     text. No badge; it is context, not an alarm.

4. **Footnote.** Extend the existing stale-hours footnote line with one
   sentence explaining the sparkline window (7 days, ends yesterday, 304s
   count).

## Phase 3: tests (`test/api.test.ts`)

Seed `fetch_metrics` directly via `env.DB.prepare(...)` in the test (the
suite already talks to D1 directly for setup in places); create tenants
through the API as usual so GUIDs are real. Time-sensitive rows compute
`day` strings relative to the current UTC date; never hardcode dates.

| Case | Seed | Assert |
|---|---|---|
| Dense zero-filled series | rows on days -2 and -5 only, with a 304-only day | `fetch_series.length === 7`, ordered oldest first, gaps zero, 304 day counted |
| No metrics at all, unpublished | nothing | series all zeros, `fetch_health === "ok"` (no publish, no verdict), `estimated_devices === null` |
| Never fetched | publish via API, backdate `published_at` beyond grace, zero rows | `fetch_health === "never_fetched"` |
| Fresh publish grace | publish via API (just now), zero rows | `fetch_health === "ok"` |
| Rotation | publish, rows only on a revoked GUID, none on active | `never_fetched` (verdict is active-GUID scoped) |
| Steady fleet | 6 prior days at 48/day, yesterday 44, interval 24 | `ok`, `estimated_devices === 44` |
| Halved fleet | 6 prior days at 48/day, yesterday 20 | `shrinking` |
| Small fleet no flap | 6 prior days at 4/day, yesterday 1 | `ok` (below `SHRINK_MIN_DAILY`) |
| Interval override | tenant policy `updateInterval: 12`, yesterday 48 | `estimated_devices === 24` |

Backdating `published_at` means updating `ruleset_versions.created_at`
directly in the test after publishing.

## Phase 4 (separate change): Analytics Engine dataset (backlog 6)

1. `wrangler.jsonc`: `"analytics_engine_datasets": [{ "binding":
   "FETCH_EVENTS", "dataset": "checkdeploymanager_fetch_events" }]`.
   Datasets are created on first write; nothing to provision, and the
   deploy button carries the binding like any other.
2. `src/types.ts`: add `FETCH_EVENTS?: AnalyticsEngineDataset` to `Env`,
   optional so copies mid-update (binding not yet deployed) type-check
   the guard naturally.
3. `src/routes/rules.ts`: alongside each existing D1 counter call, one
   guarded write:

   ```ts
   c.env.FETCH_EVENTS?.writeDataPoint({
     blobs: [tenantId, guid, kind],   // kind: hit | not_modified | revoked | unknown
     doubles: [1],
     indexes: [guid],
   });
   ```

   For `unknown` (the 404 path), blob the first 16 hex chars of the
   SHA-256 of the requested path instead of the raw value
   (`sha256Hex` already exists in `src/lib/db.ts`), so attacker-typed
   junk never lands verbatim in telemetry. Never await-block the
   response on it beyond what `writeDataPoint` requires (it is
   fire-and-forget by design).
4. `docs/monitoring.md`: replace the roadmap pointer with a real section:
   the binding, retention (about 90 days), and two or three copy-paste
   SQL API queries (per-GUID daily series, first/last seen for a GUID,
   unknown-404 volume by day), plus the Grafana data source pointer and
   the zero-secret note (query tokens live outside the Worker).
5. Tests: inject a fake `FETCH_EVENTS` with a recording `writeDataPoint`
   through the test env, assert shape per kind; assert the rules route
   serves normally with the binding absent.

## Order of work and guardrails

1. Phase 1 alone, `npm test` green with the new cases.
2. Phase 2, manual pass against `wrangler dev` with seeded metrics.
3. Docs: runbook tenant-list description and `docs/monitoring.md`
   section 1 table gain the new badges; screenshot refresh optional.
4. Backlog sections 1 and 5 deleted per convention; section 6 stays until
   phase 4 ships.

House rules that bite here: run GitNexus `impact` on the list handler and
`renderTenants` before editing and `detect_changes` before committing; no
em dashes; no UUID literals outside the Harborview sample; artifacts and
goldens are untouched by all phases (no generator changes), so golden
churn in a diff signals a mistake. The new API fields are additive, so an
older UI against a newer API (or the reverse, mid-deploy) degrades to the
current behavior.

**Sizing:** phases 1-3 one day; phase 4 half a day.
