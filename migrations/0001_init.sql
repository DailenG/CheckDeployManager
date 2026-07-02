CREATE TABLE tenants (
    id TEXT PRIMARY KEY,                -- internal UUID, never exposed publicly
    name TEXT NOT NULL,
    notes TEXT,
    current_version_id TEXT,            -- FK -> ruleset_versions.id (published pointer)
    preview_token TEXT NOT NULL,        -- random 128-bit token for /preview/{token}.json
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tenant_guids (
    guid TEXT PRIMARY KEY,              -- random UUIDv4, the public tenant vector
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    status TEXT NOT NULL DEFAULT 'active',   -- active | revoked
    label TEXT,                         -- operator note, e.g. 'pre-rotation 2026-07'
    created_at TEXT NOT NULL,
    revoked_at TEXT
);
CREATE INDEX idx_guids_tenant ON tenant_guids(tenant_id);

CREATE TABLE tenant_rule_deltas (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    draft_json TEXT NOT NULL DEFAULT '{}',   -- the delta document (see 2.3)
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

CREATE TABLE ruleset_versions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id),
    version_number INTEGER NOT NULL,    -- monotonic per tenant
    r2_key TEXT NOT NULL,               -- rules/{tenant_id}/{version_number}.json
    etag TEXT NOT NULL,                 -- sha256 of body, doubles as HTTP ETag
    upstream_snapshot_id TEXT NOT NULL, -- which base this was merged against
    delta_json TEXT NOT NULL,           -- frozen copy of the delta used
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,           -- operator email, or 'cron' for upstream republish
    note TEXT
);
CREATE INDEX idx_versions_tenant ON ruleset_versions(tenant_id, version_number);

CREATE TABLE tenant_branding (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    company_name TEXT DEFAULT '',
    product_name TEXT DEFAULT '',
    support_email TEXT DEFAULT '',
    support_url TEXT DEFAULT '',
    privacy_policy_url TEXT DEFAULT '',
    about_url TEXT DEFAULT '',
    primary_color TEXT DEFAULT '#F77F00',
    logo_r2_key TEXT,                   -- assets/{tenant_id}/logo.{ext}
    logo_content_type TEXT
);

CREATE TABLE tenant_policy_settings (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
    settings_json TEXT NOT NULL DEFAULT '{}'
    -- managed-schema toggles: enablePageBlocking, showNotifications,
    -- enableValidPageBadge, validPageBadgeTimeout, enableDebugLogging,
    -- updateInterval, urlAllowlist[], domainSquatting{}, genericWebhook prefs,
    -- enableCippReporting, cippServerUrl override, cippTenantId
);

CREATE TABLE instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
    -- public_base_url, default_cipp_server_url, metrics_retention_days (7),
    -- webhook_retention_days (90), stale_fetch_hours (48),
    -- upstream_source_url, upstream_keep_snapshots (10)
);

CREATE TABLE upstream_snapshots (
    id TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    upstream_version TEXT,              -- 'version' field from the file, e.g. 1.2.3
    r2_key TEXT NOT NULL,               -- upstream/{fetched_at}-{hash}.json
    hash TEXT NOT NULL,
    status TEXT NOT NULL,               -- active | superseded | failed_validation
    diff_summary TEXT                   -- human summary vs previous snapshot
);

CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    operator_email TEXT NOT NULL,       -- from verified Access JWT, or 'cron'
    action TEXT NOT NULL,               -- tenant.create, rules.publish, guid.revoke, ...
    tenant_id TEXT,
    details_json TEXT
);  -- retained indefinitely

CREATE TABLE fetch_metrics (
    tenant_id TEXT NOT NULL,
    guid TEXT NOT NULL,
    day TEXT NOT NULL,                  -- YYYY-MM-DD
    hits INTEGER NOT NULL DEFAULT 0,
    not_modified INTEGER NOT NULL DEFAULT 0,
    last_fetch_at TEXT,
    PRIMARY KEY (tenant_id, guid, day)
);  -- rows older than metrics_retention_days purged by cron

CREATE TABLE revoked_guid_hits (
    guid TEXT NOT NULL,
    day TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guid, day)
);  -- surfaces clients still pointed at a dead GUID

CREATE TABLE webhook_events (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    guid TEXT NOT NULL,
    received_at TEXT NOT NULL,
    event_type TEXT NOT NULL,           -- from payload reportType/event
    payload_json TEXT NOT NULL,         -- untrusted; always HTML-escaped on render
    status TEXT NOT NULL DEFAULT 'new'  -- new | reviewed | dismissed
);  -- purged when dispositioned or after webhook_retention_days
