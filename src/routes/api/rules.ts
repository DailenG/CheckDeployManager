import { Hono } from "hono";
import type { AppEnv } from "../../middleware";
import { getDraftDelta, nowIso } from "../../lib/db";
import { buildMergedRuleset, publishTenant } from "../../lib/publish";
import { validateDelta } from "../../lib/validate";
import { writeAudit } from "../../lib/audit";
import { readJsonBody, requireTenant } from "./util";

export const rulesApiRoutes = new Hono<AppEnv>();

rulesApiRoutes.get("/:id/rules", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const draft = await c.env.DB.prepare(
    "SELECT draft_json, updated_at, updated_by FROM tenant_rule_deltas WHERE tenant_id = ?",
  )
    .bind(tenant.id)
    .first();
  return c.json({ draft });
});

// Saves the draft delta and reports dry-run findings against the active
// upstream snapshot. An invalid draft still saves; publish stays gated.
rulesApiRoutes.put("/:id/rules", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const body = await readJsonBody(c);
  if (body === null || body.delta === undefined) {
    return c.json({ error: "body must be JSON with a delta property" }, 400);
  }
  const deltaJson = JSON.stringify(body.delta);

  const findings: string[] = [];
  const deltaCheck = validateDelta(deltaJson);
  findings.push(...deltaCheck.errors);
  if (deltaCheck.ok) {
    const lastVersion = await c.env.DB.prepare(
      "SELECT MAX(version_number) AS max_version FROM ruleset_versions WHERE tenant_id = ?",
    )
      .bind(tenant.id)
      .first<{ max_version: number | null }>();
    const dryRun = await buildMergedRuleset(
      c.env,
      deltaJson,
      (lastVersion?.max_version ?? 0) + 1,
    );
    if (!dryRun.ok) findings.push(...dryRun.errors);
  }

  await c.env.DB.prepare(
    "INSERT INTO tenant_rule_deltas (tenant_id, draft_json, updated_at, updated_by) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(tenant_id) DO UPDATE SET draft_json = excluded.draft_json, " +
      "updated_at = excluded.updated_at, updated_by = excluded.updated_by",
  )
    .bind(tenant.id, deltaJson, nowIso(), c.get("operatorEmail"))
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "rules.draft_save", tenant.id, {
    valid: findings.length === 0,
    findings: findings.slice(0, 10),
  });
  return c.json({ saved: true, valid: findings.length === 0, findings });
});

rulesApiRoutes.post("/:id/publish", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const draft = await getDraftDelta(c.env.DB, tenant.id);
  const result = await publishTenant(
    c.env,
    tenant.id,
    draft,
    c.get("operatorEmail"),
  );
  if (!result.ok) return c.json({ errors: result.errors }, 422);
  return c.json(result);
});

rulesApiRoutes.post("/:id/rollback/:versionId", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const version = await c.env.DB.prepare(
    "SELECT * FROM ruleset_versions WHERE id = ? AND tenant_id = ?",
  )
    .bind(c.req.param("versionId"), tenant.id)
    .first<{ id: string; version_number: number; etag: string }>();
  if (version === null) {
    return c.json({ error: "version not found for this tenant" }, 404);
  }
  await c.env.DB.prepare(
    "UPDATE tenants SET current_version_id = ?, updated_at = ? WHERE id = ?",
  )
    .bind(version.id, nowIso(), tenant.id)
    .run();
  await writeAudit(c.env.DB, c.get("operatorEmail"), "rules.rollback", tenant.id, {
    versionId: version.id,
    versionNumber: version.version_number,
  });
  return c.json({
    ok: true,
    versionId: version.id,
    versionNumber: version.version_number,
    etag: version.etag,
  });
});

rulesApiRoutes.get("/:id/versions", async (c) => {
  const tenant = await requireTenant(c);
  if (tenant === null) return c.json({ error: "tenant not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT v.id, v.version_number, v.etag, v.upstream_snapshot_id, v.delta_json, " +
      "v.created_at, v.created_by, v.note, s.upstream_version, s.diff_summary AS upstream_diff " +
      "FROM ruleset_versions v LEFT JOIN upstream_snapshots s ON s.id = v.upstream_snapshot_id " +
      "WHERE v.tenant_id = ? ORDER BY v.version_number DESC",
  )
    .bind(tenant.id)
    .all();
  return c.json({
    versions: results,
    current_version_id: tenant.current_version_id,
  });
});
