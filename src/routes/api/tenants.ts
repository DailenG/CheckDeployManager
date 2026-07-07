import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import {
  getInstanceSettings,
  newId,
  newToken,
  nowIso,
  type TenantRow,
} from "../../lib/db";
import { writeAudit } from "../../lib/audit";
import { readJsonBody, requireTenant } from "./util";

export const tenantsRoutes = new Hono<AppEnv>();

// List tenants with the dashboard health indicators (design 3.2).
tenantsRoutes.get("/", async (c) => {
  const settings = await getInstanceSettings(c.env.DB);
  const staleHours = Number(settings.stale_fetch_hours) || 48;

  const { results } = await c.env.DB.prepare(
    "SELECT t.id, t.name, t.notes, t.created_at, t.updated_at, " +
      "v.version_number AS current_version_number, v.created_at AS published_at, " +
      "(SELECT MAX(m.last_fetch_at) FROM fetch_metrics m WHERE m.tenant_id = t.id) AS last_fetch_at, " +
      "(SELECT COUNT(*) FROM tenant_guids g WHERE g.tenant_id = t.id AND g.status = 'active') AS active_guids, " +
      "(SELECT COALESCE(SUM(r.hits), 0) FROM revoked_guid_hits r " +
      " JOIN tenant_guids g ON g.guid = r.guid WHERE g.tenant_id = t.id) AS revoked_hits, " +
      "(SELECT COUNT(*) FROM webhook_events w WHERE w.tenant_id = t.id AND w.status = 'new') AS new_events " +
      "FROM tenants t LEFT JOIN ruleset_versions v ON v.id = t.current_version_id " +
      "ORDER BY t.name",
  ).all<Record<string, unknown>>();

  const staleCutoff = Date.now() - staleHours * 3600 * 1000;
  const tenants = results.map((row) => ({
    ...row,
    stale:
      row.last_fetch_at === null ||
      Date.parse(String(row.last_fetch_at)) < staleCutoff,
  }));
  return c.json({ tenants, stale_fetch_hours: staleHours });
});

// Create tenant: mints the first GUID, the preview token, and default
// settings rows in one shot.
tenantsRoutes.post("/", async (c) => {
  const body = await readJsonBody(c);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }
  const notes = typeof body?.notes === "string" ? body.notes : null;

  const tenantId = newId();
  const guid = newId();
  const previewToken = newToken();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO tenants (id, name, notes, preview_token, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(tenantId, name, notes, previewToken, now, now),
    c.env.DB.prepare(
      "INSERT INTO tenant_guids (guid, tenant_id, created_at) VALUES (?, ?, ?)",
    ).bind(guid, tenantId, now),
    c.env.DB.prepare(
      "INSERT INTO tenant_rule_deltas (tenant_id, draft_json, updated_at, updated_by) " +
        "VALUES (?, '{}', ?, ?)",
    ).bind(tenantId, now, c.get("operatorEmail")),
    c.env.DB.prepare("INSERT INTO tenant_branding (tenant_id) VALUES (?)").bind(
      tenantId,
    ),
    c.env.DB.prepare(
      "INSERT INTO tenant_policy_settings (tenant_id) VALUES (?)",
    ).bind(tenantId),
  ]);
  await writeAudit(c.env.DB, c.get("operatorEmail"), "tenant.create", tenantId, {
    name,
  });
  return c.json({ id: tenantId, name, guid, preview_token: previewToken }, 201);
});

// Duplicate a tenant's rules delta into a fresh tenant. Only the draft
// delta copies: branding and policy inherit the instance tenant defaults,
// so duplication would just freeze values that should keep inheriting.
tenantsRoutes.post("/:id/duplicate", async (c) => {
  const source = await requireTenant(c);
  if (source === null) return c.json({ error: "tenant not found" }, 404);
  const body = await readJsonBody(c);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    return c.json({ error: "name is required" }, 400);
  }

  const draft = await c.env.DB.prepare(
    "SELECT draft_json FROM tenant_rule_deltas WHERE tenant_id = ?",
  )
    .bind(source.id)
    .first<{ draft_json: string }>();

  const tenantId = newId();
  const guid = newId();
  const previewToken = newToken();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO tenants (id, name, notes, preview_token, created_at, updated_at) " +
        "VALUES (?, ?, NULL, ?, ?, ?)",
    ).bind(tenantId, name, previewToken, now, now),
    c.env.DB.prepare(
      "INSERT INTO tenant_guids (guid, tenant_id, created_at) VALUES (?, ?, ?)",
    ).bind(guid, tenantId, now),
    c.env.DB.prepare(
      "INSERT INTO tenant_rule_deltas (tenant_id, draft_json, updated_at, updated_by) " +
        "VALUES (?, ?, ?, ?)",
    ).bind(tenantId, draft?.draft_json ?? "{}", now, c.get("operatorEmail")),
    c.env.DB.prepare("INSERT INTO tenant_branding (tenant_id) VALUES (?)").bind(
      tenantId,
    ),
    c.env.DB.prepare(
      "INSERT INTO tenant_policy_settings (tenant_id) VALUES (?)",
    ).bind(tenantId),
  ]);
  await writeAudit(c.env.DB, c.get("operatorEmail"), "tenant.duplicate", tenantId, {
    name,
    sourceTenantId: source.id,
  });
  return c.json({ id: tenantId, name, guid, preview_token: previewToken }, 201);
});

tenantsRoutes.get("/:id", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);

  const [guids, version, draft, lastFetch] = await Promise.all([
    c.env.DB.prepare(
      "SELECT guid, status, label, created_at, revoked_at FROM tenant_guids " +
        "WHERE tenant_id = ? ORDER BY created_at",
    )
      .bind(tenant.id)
      .all(),
    tenant.current_version_id !== null
      ? c.env.DB.prepare("SELECT * FROM ruleset_versions WHERE id = ?")
          .bind(tenant.current_version_id)
          .first()
      : Promise.resolve(null),
    c.env.DB.prepare(
      "SELECT draft_json, updated_at, updated_by FROM tenant_rule_deltas WHERE tenant_id = ?",
    )
      .bind(tenant.id)
      .first(),
    // The tenant onboarding wizard's verify step watches for this.
    c.env.DB.prepare(
      "SELECT MAX(last_fetch_at) AS last_fetch_at FROM fetch_metrics WHERE tenant_id = ?",
    )
      .bind(tenant.id)
      .first<{ last_fetch_at: string | null }>(),
  ]);
  return c.json({
    tenant,
    guids: guids.results,
    current_version: version,
    draft,
    last_fetch_at: lastFetch?.last_fetch_at ?? null,
  });
});

tenantsRoutes.patch("/:id", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid JSON body" }, 400);

  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : tenant.name;
  const notes =
    body.notes === undefined
      ? tenant.notes
      : typeof body.notes === "string"
        ? body.notes
        : null;
  await c.env.DB.prepare(
    "UPDATE tenants SET name = ?, notes = ?, updated_at = ? WHERE id = ?",
  )
    .bind(name, notes, nowIso(), tenant.id)
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "tenant.update", tenant.id, {
    name,
  });
  return c.json({ ok: true });
});

// Decommission. Guarded: every GUID must be revoked first so nothing is
// still fetching when the tenant disappears.
tenantsRoutes.delete("/:id", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);

  const active = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM tenant_guids WHERE tenant_id = ? AND status = 'active'",
  )
    .bind(tenant.id)
    .first<{ count: number }>();
  if ((active?.count ?? 0) > 0) {
    return c.json(
      { error: "tenant still has active GUIDs; revoke them before deleting" },
      409,
    );
  }

  // Remove R2 artifacts (rule versions and logo) before the rows.
  const { results: versions } = await c.env.DB.prepare(
    "SELECT r2_key FROM ruleset_versions WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .all<{ r2_key: string }>();
  const branding = await c.env.DB.prepare(
    "SELECT logo_r2_key FROM tenant_branding WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first<{ logo_r2_key: string | null }>();
  const keys = versions.map((v) => v.r2_key);
  if (branding?.logo_r2_key) keys.push(branding.logo_r2_key);
  if (keys.length > 0) await c.env.STORAGE.delete(keys);

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tenants SET current_version_id = NULL WHERE id = ?").bind(
      tenant.id,
    ),
    c.env.DB.prepare("DELETE FROM webhook_events WHERE tenant_id = ?").bind(tenant.id),
    c.env.DB.prepare("DELETE FROM fetch_metrics WHERE tenant_id = ?").bind(tenant.id),
    c.env.DB.prepare(
      "DELETE FROM revoked_guid_hits WHERE guid IN (SELECT guid FROM tenant_guids WHERE tenant_id = ?)",
    ).bind(tenant.id),
    c.env.DB.prepare("DELETE FROM ruleset_versions WHERE tenant_id = ?").bind(tenant.id),
    c.env.DB.prepare("DELETE FROM tenant_rule_deltas WHERE tenant_id = ?").bind(
      tenant.id,
    ),
    c.env.DB.prepare("DELETE FROM tenant_branding WHERE tenant_id = ?").bind(tenant.id),
    c.env.DB.prepare("DELETE FROM tenant_policy_settings WHERE tenant_id = ?").bind(
      tenant.id,
    ),
    c.env.DB.prepare("DELETE FROM tenant_guids WHERE tenant_id = ?").bind(tenant.id),
    c.env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(tenant.id),
  ]);
  await writeAudit(c.env.DB, c.get("operatorEmail"), "tenant.delete", tenant.id, {
    name: tenant.name,
  });
  return c.json({ ok: true });
});
