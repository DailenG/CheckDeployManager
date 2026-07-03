// D1 helpers: typed row shapes and the small set of queries the routes share.

export interface TenantRow {
  id: string;
  name: string;
  notes: string | null;
  current_version_id: string | null;
  preview_token: string;
  created_at: string;
  updated_at: string;
}

export interface TenantGuidRow {
  guid: string;
  tenant_id: string;
  status: "active" | "revoked";
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface RulesetVersionRow {
  id: string;
  tenant_id: string;
  version_number: number;
  r2_key: string;
  etag: string;
  upstream_snapshot_id: string;
  delta_json: string;
  created_at: string;
  created_by: string;
  note: string | null;
}

export interface TenantBrandingRow {
  tenant_id: string;
  company_name: string;
  product_name: string;
  support_email: string;
  support_url: string;
  privacy_policy_url: string;
  about_url: string;
  primary_color: string;
  logo_r2_key: string | null;
  logo_content_type: string | null;
}

export interface UpstreamSnapshotRow {
  id: string;
  fetched_at: string;
  upstream_version: string | null;
  r2_key: string;
  hash: string;
  status: "active" | "superseded" | "failed_validation";
  diff_summary: string | null;
}

export interface WebhookEventRow {
  id: string;
  tenant_id: string;
  guid: string;
  received_at: string;
  event_type: string;
  payload_json: string;
  status: "new" | "reviewed" | "dismissed";
}

export const DEFAULT_INSTANCE_SETTINGS: Record<string, string> = {
  public_base_url: "",
  default_cipp_server_url: "",
  metrics_retention_days: "7",
  webhook_retention_days: "90",
  stale_fetch_hours: "48",
  upstream_source_url:
    "https://raw.githubusercontent.com/CyberDrain/Check/main/rules/detection-rules.json",
  upstream_keep_snapshots: "10",
  version_suffix_label: "cdm",
  // When set, every inbound webhook event is POSTed to this URL (n8n,
  // Power Automate, and similar). Empty disables the relay.
  false_positive_relay_url: "",
  // ISO timestamp once the setup wizard is finished or skipped; empty means
  // the wizard is still offered. Not listed in the Settings page UI.
  onboarding_completed_at: "",
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function newId(): string {
  return crypto.randomUUID();
}

// 128-bit random hex token for preview URLs.
export function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

// Reads all instance settings, seeding any missing defaults on first read.
export async function getInstanceSettings(
  db: D1Database,
): Promise<Record<string, string>> {
  const { results } = await db
    .prepare("SELECT key, value FROM instance_settings")
    .all<{ key: string; value: string }>();
  const settings: Record<string, string> = {};
  for (const row of results) settings[row.key] = row.value;

  const missing = Object.keys(DEFAULT_INSTANCE_SETTINGS).filter(
    (key) => !(key in settings),
  );
  if (missing.length > 0) {
    const stmt = db.prepare(
      "INSERT OR IGNORE INTO instance_settings (key, value) VALUES (?, ?)",
    );
    await db.batch(
      missing.map((key) => stmt.bind(key, DEFAULT_INSTANCE_SETTINGS[key])),
    );
    for (const key of missing) settings[key] = DEFAULT_INSTANCE_SETTINGS[key];
  }
  return settings;
}

export async function putInstanceSetting(
  db: D1Database,
  key: string,
  value: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO instance_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

export async function getTenant(
  db: D1Database,
  id: string,
): Promise<TenantRow | null> {
  return db
    .prepare("SELECT * FROM tenants WHERE id = ?")
    .bind(id)
    .first<TenantRow>();
}

export async function getActiveGuid(
  db: D1Database,
  guid: string,
): Promise<TenantGuidRow | null> {
  return db
    .prepare("SELECT * FROM tenant_guids WHERE guid = ? AND status = 'active'")
    .bind(guid)
    .first<TenantGuidRow>();
}

export async function getGuid(
  db: D1Database,
  guid: string,
): Promise<TenantGuidRow | null> {
  return db
    .prepare("SELECT * FROM tenant_guids WHERE guid = ?")
    .bind(guid)
    .first<TenantGuidRow>();
}

export async function getCurrentVersion(
  db: D1Database,
  tenantId: string,
): Promise<RulesetVersionRow | null> {
  return db
    .prepare(
      "SELECT v.* FROM ruleset_versions v " +
        "JOIN tenants t ON t.current_version_id = v.id WHERE t.id = ?",
    )
    .bind(tenantId)
    .first<RulesetVersionRow>();
}

export async function getDraftDelta(
  db: D1Database,
  tenantId: string,
): Promise<string> {
  const row = await db
    .prepare("SELECT draft_json FROM tenant_rule_deltas WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ draft_json: string }>();
  return row ? row.draft_json : "{}";
}

export async function getActiveSnapshot(
  db: D1Database,
): Promise<UpstreamSnapshotRow | null> {
  return db
    .prepare(
      "SELECT * FROM upstream_snapshots WHERE status = 'active' " +
        "ORDER BY fetched_at DESC LIMIT 1",
    )
    .first<UpstreamSnapshotRow>();
}

export async function countFetchHit(
  db: D1Database,
  tenantId: string,
  guid: string,
  notModified: boolean,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO fetch_metrics (tenant_id, guid, day, hits, not_modified, last_fetch_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(tenant_id, guid, day) DO UPDATE SET " +
        "hits = hits + excluded.hits, " +
        "not_modified = not_modified + excluded.not_modified, " +
        "last_fetch_at = excluded.last_fetch_at",
    )
    .bind(tenantId, guid, today(), notModified ? 0 : 1, notModified ? 1 : 0, nowIso())
    .run();
}

export async function countRevokedHit(
  db: D1Database,
  guid: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO revoked_guid_hits (guid, day, hits) VALUES (?, ?, 1) " +
        "ON CONFLICT(guid, day) DO UPDATE SET hits = hits + 1",
    )
    .bind(guid, today())
    .run();
}
