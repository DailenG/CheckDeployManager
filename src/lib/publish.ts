import type { Env } from "../types";
import {
  getActiveSnapshot,
  getInstanceSettings,
  newId,
  nowIso,
  sha256Hex,
  type UpstreamSnapshotRow,
} from "./db";
import { applyDelta, mergeRuleset, type TenantDelta } from "./merge";
import { validateDelta, validateRuleset } from "./validate";
import { writeAudit } from "./audit";

export type PublishResult =
  | {
      ok: true;
      versionId: string;
      versionNumber: number;
      etag: string;
    }
  | { ok: false; errors: string[] };

export function formatEtagHeader(etagHash: string): string {
  return `"sha256-${etagHash.slice(0, 12)}"`;
}

export async function loadSnapshotRuleset(
  env: Env,
  snapshot: UpstreamSnapshotRow,
): Promise<Record<string, unknown> | null> {
  const object = await env.STORAGE.get(snapshot.r2_key);
  if (object === null) return null;
  return JSON.parse(await object.text());
}

// Merges a delta against the active upstream snapshot and runs the gates.
// Shared by publish, dry-run validation, and the live preview endpoint.
export async function buildMergedRuleset(
  env: Env,
  deltaJson: string,
  versionNumber: number,
): Promise<
  | { ok: true; merged: Record<string, unknown>; snapshot: UpstreamSnapshotRow }
  | { ok: false; errors: string[] }
> {
  const deltaCheck = validateDelta(deltaJson);
  if (!deltaCheck.ok) return { ok: false, errors: deltaCheck.errors };
  const delta = deltaCheck.ruleset as TenantDelta;

  const snapshot = await getActiveSnapshot(env.DB);
  if (snapshot === null) {
    return {
      ok: false,
      errors: ["no active upstream snapshot; run an upstream sync first"],
    };
  }
  const upstream = await loadSnapshotRuleset(env, snapshot);
  if (upstream === null) {
    return {
      ok: false,
      errors: [`active upstream snapshot object missing from R2: ${snapshot.r2_key}`],
    };
  }

  const settings = await getInstanceSettings(env.DB);

  // Instance baseline delta (standard MSP exclusions) applies beneath every
  // tenant delta. The settings PUT validates it on write; a bad stored value
  // still fails loudly here rather than silently publishing without it.
  let base = upstream;
  const baselineJson = settings.baseline_rule_delta ?? "";
  if (baselineJson !== "" && baselineJson !== "{}") {
    const baselineCheck = validateDelta(baselineJson);
    if (!baselineCheck.ok) {
      return {
        ok: false,
        errors: baselineCheck.errors.map(
          (error) => `baseline_rule_delta: ${error}`,
        ),
      };
    }
    base = applyDelta(upstream, baselineCheck.ruleset as TenantDelta);
  }

  const merged = mergeRuleset(base, delta, {
    suffixLabel: settings.version_suffix_label,
    versionNumber,
    publishedAt: nowIso(),
  });

  const mergedCheck = validateRuleset(JSON.stringify(merged));
  if (!mergedCheck.ok) return { ok: false, errors: mergedCheck.errors };
  return { ok: true, merged, snapshot };
}

export async function publishTenant(
  env: Env,
  tenantId: string,
  deltaJson: string,
  operator: string,
  note?: string,
): Promise<PublishResult> {
  const lastVersion = await env.DB.prepare(
    "SELECT MAX(version_number) AS max_version FROM ruleset_versions WHERE tenant_id = ?",
  )
    .bind(tenantId)
    .first<{ max_version: number | null }>();
  const versionNumber = (lastVersion?.max_version ?? 0) + 1;

  const built = await buildMergedRuleset(env, deltaJson, versionNumber);
  if (!built.ok) return built;

  const body = JSON.stringify(built.merged, null, 2);
  const etag = await sha256Hex(body);
  const r2Key = `rules/${tenantId}/${versionNumber}.json`;
  await env.STORAGE.put(r2Key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  const versionId = newId();
  const createdAt = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ruleset_versions " +
        "(id, tenant_id, version_number, r2_key, etag, upstream_snapshot_id, delta_json, created_at, created_by, note) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      versionId,
      tenantId,
      versionNumber,
      r2Key,
      etag,
      built.snapshot.id,
      deltaJson,
      createdAt,
      operator,
      note ?? null,
    ),
    env.DB.prepare(
      "UPDATE tenants SET current_version_id = ?, updated_at = ? WHERE id = ?",
    ).bind(versionId, createdAt, tenantId),
  ]);

  await writeAudit(env.DB, operator, "rules.publish", tenantId, {
    versionId,
    versionNumber,
    etag,
    upstreamSnapshotId: built.snapshot.id,
    note: note ?? null,
  });

  return { ok: true, versionId, versionNumber, etag };
}

export interface RepublishOutcome {
  republished: number;
  failures: { tenantId: string; errors: string[] }[];
}

// Re-merges and republishes every tenant with a published version, using
// the delta frozen in that version (never the operator's draft). Shared by
// the upstream sync auto-publish and the baseline-delta republish action.
export async function republishAllTenants(
  env: Env,
  publishAs: string,
  note: string,
  auditOperator: string,
): Promise<RepublishOutcome> {
  const { results } = await env.DB.prepare(
    "SELECT t.id AS tenant_id, v.delta_json FROM tenants t " +
      "JOIN ruleset_versions v ON v.id = t.current_version_id",
  ).all<{ tenant_id: string; delta_json: string }>();

  let republished = 0;
  const failures: { tenantId: string; errors: string[] }[] = [];
  for (const row of results) {
    const result = await publishTenant(env, row.tenant_id, row.delta_json, publishAs, note);
    if (result.ok) {
      republished += 1;
    } else {
      failures.push({ tenantId: row.tenant_id, errors: result.errors });
      await writeAudit(env.DB, auditOperator, "rules.publish_failed", row.tenant_id, {
        note,
        errors: result.errors,
      });
    }
  }
  return { republished, failures };
}
