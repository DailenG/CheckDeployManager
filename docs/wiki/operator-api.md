<!-- GENERATED FILE, do not edit by hand.
     Mirrored from .gitnexus/wiki (GitNexus knowledge graph wiki), source commit 3fe8c14.
     Regenerate: node .gitnexus/run.cjs wiki, then: npm run docs:wiki -->

# Operator API Module

The Operator API is the authenticated administrative API for managing tenants, rule drafts, publishing, branding, policy settings, GUID rotation, upstream sync state, webhook events, audit logs, and instance settings.

All routes are composed in `src/routes/api/index.ts` through `apiRoutes`, a `Hono<AppEnv>` router. The module applies `requireOperator` to every route with:

```ts
apiRoutes.use("*", requireOperator);
```

Downstream handlers rely on `requireOperator` to populate operator context, especially `c.get("operatorEmail")` for audit records.

```mermaid
flowchart TD
  A[apiRoutes] --> B[requireOperator]
  B --> C[/tenants scoped APIs]
  B --> D[/guids revoke API]
  B --> E[/instance settings]
  B --> F[/upstream sync]
  B --> G[/events and audit]
  C --> H[DB + STORAGE]
  D --> H
  E --> H
  F --> H
  G --> H
```

## Route Composition

`apiRoutes` mounts several feature routers:

```ts
apiRoutes.route("/tenants", tenantsRoutes);
apiRoutes.route("/tenants", rulesApiRoutes);
apiRoutes.route("/tenants", brandingRoutes);
apiRoutes.route("/tenants", policyRoutes);
apiRoutes.route("/tenants", guidsRoutes);
apiRoutes.route("/tenants", artifactsRoutes);
apiRoutes.route("/guids", guidRevokeRoutes);
apiRoutes.route("/instance", instanceRoutes);
apiRoutes.route("/upstream", upstreamRoutes);
apiRoutes.route("/events", eventsRoutes);
apiRoutes.route("/audit", auditRoutes);
```

Most tenant-specific routes are mounted under `/tenants/:id/...`. GUID revocation is mounted separately under `/guids/:guid/revoke` because it addresses a GUID directly rather than a tenant resource.

## Shared Utilities

### `readJsonBody(c)`

`readJsonBody` centralizes tolerant JSON-object parsing. It returns:

- `Record<string, unknown>` when the request body parses as a non-array object
- `null` when parsing fails, the body is `null`, the body is not an object, or the body is an array

Routes use this helper when they want a consistent “invalid JSON object” path without throwing.

Used by:

- `tenantsRoutes`
- `rulesApiRoutes`
- `policyRoutes`
- `guidsRoutes`
- `instanceRoutes`
- `eventsRoutes`

### `requireTenant(c)`

`requireTenant` reads the route parameter named `id` and resolves it through `getTenant(c.env.DB, id)`. It returns a `TenantRow` or `null`.

Tenant-scoped handlers consistently use this pattern:

```ts
const tenant = await requireTenant(c);
if (tenant === null) return c.json({ error: "tenant not found" }, 404);
```

Used by tenant detail, rules, branding, policy, GUID, and artifact routes.

## Tenants API

Implemented in `src/routes/api/tenants.ts`.

### `GET /tenants`

Lists tenants with operational dashboard indicators.

The query joins `tenants` to the current `ruleset_versions` row and computes:

- current published version number
- publish time
- latest fetch time from `fetch_metrics`
- active GUID count
- revoked GUID hit count
- new webhook event count
- `stale` status based on `stale_fetch_hours` from `getInstanceSettings`

The response shape is:

```ts
{
  tenants,
  stale_fetch_hours
}
```

### `POST /tenants`

Creates a tenant and initializes all required tenant-owned rows in one `DB.batch()` call.

It creates:

- a tenant row
- the first active GUID
- an empty rule draft in `tenant_rule_deltas`
- a default branding row
- a default policy settings row
- a preview token via `newToken()`

Required body:

```json
{
  "name": "Tenant Name"
}
```

Optional:

```json
{
  "notes": "Internal notes"
}
```

On success, the route audits `tenant.create` and returns `201` with:

```ts
{
  id,
  name,
  guid,
  preview_token
}
```

### `GET /tenants/:id`

Returns a tenant detail bundle:

- `tenant`
- all tenant GUIDs
- current version row, if `tenant.current_version_id` is set
- current draft row

The GUIDs, current version, and draft are loaded concurrently with `Promise.all`.

### `PATCH /tenants/:id`

Updates tenant `name` and `notes`.

Behavior:

- Missing `name` keeps the existing name.
- Blank or non-string `name` keeps the existing name.
- Missing `notes` keeps existing notes.
- String `notes` updates notes.
- Non-string `notes` clears notes to `null`.

The route updates `updated_at` with `nowIso()` and audits `tenant.update`.

### `DELETE /tenants/:id`

Decommissions a tenant.

Deletion is guarded: all tenant GUIDs must already be revoked. If any active GUID remains, the route returns `409`:

```json
{
  "error": "tenant still has active GUIDs; revoke them before deleting"
}
```

Before deleting rows, it removes tenant-owned R2 objects:

- ruleset version objects from `ruleset_versions.r2_key`
- branding logo from `tenant_branding.logo_r2_key`

Then it batches deletion of webhook events, metrics, revoked GUID hits, versions, draft, branding, policy settings, GUIDs, and the tenant row. The route audits `tenant.delete`.

## Tenant Rules API

Implemented in `src/routes/api/rules.ts`.

### `GET /tenants/:id/rules`

Returns the draft rule delta row:

```ts
{
  draft
}
```

The draft row includes `draft_json`, `updated_at`, and `updated_by`.

### `PUT /tenants/:id/rules`

Saves a draft delta and performs validation.

Required body:

```json
{
  "delta": {}
}
```

The route serializes `body.delta` to JSON, validates it with `validateDelta`, and, if structurally valid, performs a dry-run merge with `buildMergedRuleset`.

Important behavior: invalid drafts still save. The route records findings and returns whether the saved draft is publishable:

```ts
{
  saved: true,
  valid: findings.length === 0,
  findings
}
```

This allows operators to persist in-progress work while keeping publish gated elsewhere.

The route audits `rules.draft_save` with:

- whether the draft was valid
- up to the first 10 findings

### `POST /tenants/:id/publish`

Publishes the current draft for a tenant.

The route loads the draft with `getDraftDelta` and delegates publishing to:

```ts
publishTenant(c.env, tenant.id, draft, c.get("operatorEmail"))
```

If publishing fails, it returns `422` with `errors`. On success, it returns the `publishTenant` result directly.

### `POST /tenants/:id/rollback/:versionId`

Moves the tenant’s `current_version_id` back to an existing version owned by the same tenant.

The route verifies the version exists with:

```sql
SELECT * FROM ruleset_versions WHERE id = ? AND tenant_id = ?
```

If no matching version exists, it returns `404`.

On success, it updates `tenants.current_version_id`, audits `rules.rollback`, and returns the selected version ID, version number, and ETag.

### `GET /tenants/:id/versions`

Lists tenant ruleset versions newest-first and includes upstream snapshot metadata when available.

Response includes:

```ts
{
  versions,
  current_version_id: tenant.current_version_id
}
```

## Branding API

Implemented in `src/routes/api/branding.ts`.

### `GET /tenants/:id/branding`

Returns the `tenant_branding` row for the tenant.

### `PUT /tenants/:id/branding`

Updates branding fields and optionally uploads or removes a logo.

Supported text fields are defined by `TEXT_FIELDS`:

```ts
[
  "company_name",
  "product_name",
  "support_email",
  "support_url",
  "privacy_policy_url",
  "about_url",
  "primary_color",
]
```

The route accepts either JSON or `multipart/form-data`.

For JSON, string values are copied from the body. `remove_logo: true` deletes the existing logo.

For multipart requests, the same text fields are read from form fields. A `logo` file can be uploaded, and `remove_logo=true` removes the existing logo.

Logo constraints are:

- MIME type must be `image/png`, `image/jpeg`, or `image/svg+xml`
- max size is `MAX_LOGO_BYTES`, currently `512 * 1024`
- stored at `assets/${tenant.id}/logo.${extension}` in `c.env.STORAGE`

The route updates only fields that were provided. It audits `branding.update` with changed text fields and logo update/removal flags.

## Policy API

Implemented in `src/routes/api/policy.ts`.

Policy settings are managed-schema tenant settings stored as JSON in `tenant_policy_settings.settings_json`.

### `validatePolicySettings(settings)`

Validates setting keys and value types against `POLICY_FIELDS`.

Known fields include:

- boolean toggles such as `enablePageBlocking`, `showNotifications`, `enableValidPageBadge`, `enableDebugLogging`, `enableCippReporting`
- numeric settings such as `validPageBadgeTimeout` and `updateInterval`
- string settings such as `cippServerUrl` and `cippTenantId`
- string arrays such as `urlAllowlist`
- object settings such as `domainSquatting` and `genericWebhook`

Unknown keys produce:

```ts
unknown policy setting: ${key}
```

Type mismatches produce:

```ts
policy setting ${key} has the wrong type
```

### `GET /tenants/:id/policy`

Returns parsed policy settings:

```ts
{
  settings: JSON.parse(row?.settings_json ?? "{}")
}
```

### `PUT /tenants/:id/policy`

Requires:

```json
{
  "settings": {}
}
```

The route validates the settings object, returns `422` on validation errors, and upserts `tenant_policy_settings`. It audits `policy.update` with the changed keys.

## Tenant GUID API

Implemented in `src/routes/api/guids.ts`.

### `GET /tenants/:id/guids`

Lists GUIDs for a tenant with usage metrics:

- GUID status and label
- creation and revocation timestamps
- total fetch hits from `fetch_metrics`
- last fetch timestamp
- revoked GUID hits from `revoked_guid_hits`

### `POST /tenants/:id/guids`

Mints a new active GUID for the tenant.

Optional body:

```json
{
  "label": "Migration GUID"
}
```

This is a rotation operation, but the previous GUIDs remain active until explicitly revoked. The route audits `guid.rotate` and returns `201`:

```ts
{
  guid
}
```

### `POST /guids/:guid/revoke`

Revokes a GUID by GUID value.

The route:

1. Finds the GUID in `tenant_guids`.
2. Returns `404` if not found.
3. Returns `409` if already revoked.
4. Sets `status = 'revoked'` and `revoked_at = nowIso()`.
5. Audits `guid.revoke`.

## Artifacts API

Implemented in `src/routes/api/artifacts.ts`.

### `GET /tenants/:id/artifacts`

Generates tenant artifacts on demand with:

```ts
generateArtifacts(c.env, tenant.id, c.req.query("guid") ?? undefined)
```

Generated artifacts are not stored by this route. They are rendered fresh on each request.

If generation fails, the route returns `409` with the generation error. On success:

```ts
{
  artifacts: result.artifacts
}
```

The optional `guid` query parameter lets callers generate artifacts for a specific GUID context.

## Instance Settings API

Implemented in `src/routes/api/instance.ts`.

### `GET /instance/settings`

Returns effective instance settings from `getInstanceSettings(c.env.DB)`.

### `PUT /instance/settings`

Requires:

```json
{
  "settings": {
    "key": "value"
  }
}
```

Validation rules:

- every key must exist in `DEFAULT_INSTANCE_SETTINGS`
- every value must be a string
- integer-backed settings must be non-negative integer strings

Integer-backed settings are:

```ts
[
  "metrics_retention_days",
  "webhook_retention_days",
  "stale_fetch_hours",
  "upstream_keep_snapshots",
]
```

Each valid update is written through `putInstanceSetting`. The route audits `instance.settings_update` and returns the refreshed effective settings.

## Upstream API

Implemented in `src/routes/api/upstream.ts`.

### `GET /upstream`

Returns upstream synchronization state:

- active snapshot from `getActiveSnapshot`
- latest 25 snapshot rows from `upstream_snapshots`
- most recent `upstream.sync` audit entry

Response:

```ts
{
  active,
  snapshots,
  last_sync
}
```

### `POST /upstream`

Forces an upstream sync with:

```ts
syncUpstream(c.env, c.get("operatorEmail"))
```

`syncUpstream` performs its own audit logging. If the outcome status is `fetch_error`, the route returns HTTP `502`; otherwise it returns `200`.

## Events API

Implemented in `src/routes/api/events.ts`.

The events API manages webhook event inbox disposition. Payloads are treated as untrusted strings by this module.

Allowed dispositions are:

```ts
new
reviewed
dismissed
```

### `GET /events`

Lists webhook events, optionally filtered by:

- `status`
- `tenant_id`
- `limit`

`status` is only applied when it is one of the allowed dispositions. `limit` defaults to `100` and is capped at `500`.

The query joins `webhook_events` to `tenants` to include `tenant_name`.

### `PATCH /events`

Updates an event disposition.

Required body:

```json
{
  "id": "event-id",
  "status": "reviewed"
}
```

The route validates the status, verifies the event exists, updates `webhook_events.status`, and audits `events.disposition`.

## Audit API

Implemented in `src/routes/api/audit.ts`.

### `GET /audit`

Lists audit log entries ordered newest-first.

Optional filters:

- `tenant_id`
- `operator`
- `action`
- `before`
- `limit`

`before` filters by timestamp:

```sql
ts < ?
```

`limit` defaults to `100` and is capped at `500`.

The route returns:

```ts
{
  entries: results
}
```

## Persistence and External Dependencies

The Operator API primarily uses `c.env.DB`, a D1-style database binding, and `c.env.STORAGE`, an R2-style object storage binding.

Database-heavy routes use prepared statements with positional bindings. This keeps user-controlled values out of SQL strings. Dynamic SQL is limited to assembled `WHERE` clauses from fixed column names and assignment lists from fixed field allowlists.

Object storage is used for:

- tenant branding logos
- ruleset artifacts cleaned up during tenant deletion

Publishing, artifact generation, upstream sync, ID creation, timestamps, and settings resolution are delegated to library modules:

- `generateArtifacts` from `src/lib/artifacts`
- `writeAudit` from `src/lib/audit`
- `getTenant`, `getDraftDelta`, `getInstanceSettings`, `putInstanceSetting`, `getActiveSnapshot`, `newId`, `newToken`, and `nowIso` from `src/lib/db`
- `buildMergedRuleset` and `publishTenant` from `src/lib/publish`
- `syncUpstream` from `src/lib/upstream`
- `validateDelta` from `src/lib/validate`

## Audit Pattern

Most mutating routes write an audit record after the database or storage change succeeds.

Audited actions include:

- `tenant.create`
- `tenant.update`
- `tenant.delete`
- `rules.draft_save`
- `rules.rollback`
- `branding.update`
- `policy.update`
- `guid.rotate`
- `guid.revoke`
- `instance.settings_update`
- `events.disposition`

`upstream.sync` is handled inside `syncUpstream`.

The operator identity comes from:

```ts
c.get("operatorEmail")
```

which is expected to be set by `requireOperator`.

## Error Handling Conventions

The module uses compact JSON error responses.

Common patterns:

- `400` for invalid request bodies or missing required fields
- `404` for missing tenants, events, GUIDs, or tenant-owned versions
- `409` for state conflicts, such as deleting a tenant with active GUIDs or revoking an already revoked GUID
- `413` for oversized logo uploads
- `422` for validation failures that are syntactically valid requests
- `502` for upstream fetch errors

Most handlers return plain objects through `c.json(...)` and avoid throwing for expected validation failures.

## Contribution Notes

When adding tenant-scoped endpoints, prefer `requireTenant(c)` so missing tenants behave consistently.

When accepting JSON object bodies, prefer `readJsonBody(c)` unless the route needs a different parse error message or supports multipart data.

When adding mutable operator actions, write an audit record with `writeAudit` after the mutation succeeds. Use the existing action naming style: `<area>.<operation>`.

When adding settings-like APIs, follow the existing allowlist pattern used by `POLICY_FIELDS`, `TEXT_FIELDS`, and `DEFAULT_INSTANCE_SETTINGS` rather than accepting arbitrary keys.
