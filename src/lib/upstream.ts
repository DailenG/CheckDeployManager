import type { Env } from "../types";
import {
  getActiveSnapshot,
  getInstanceSettings,
  newId,
  nowIso,
  sha256Hex,
  type UpstreamSnapshotRow,
} from "./db";
import { loadSnapshotRuleset, republishAllTenants } from "./publish";
import { validateRuleset } from "./validate";
import { writeAudit } from "./audit";

export interface SyncOutcome {
  status: "unchanged" | "updated" | "failed_validation" | "fetch_error";
  snapshotId?: string;
  diffSummary?: string;
  errors?: string[];
  republished?: number;
  republishFailures?: { tenantId: string; errors: string[] }[];
}

function summarizeStringArray(
  label: string,
  previous: unknown,
  next: unknown,
): string | null {
  const before = new Set(Array.isArray(previous) ? previous.map(String) : []);
  const after = new Set(Array.isArray(next) ? next.map(String) : []);
  let added = 0;
  let removed = 0;
  for (const item of after) if (!before.has(item)) added += 1;
  for (const item of before) if (!after.has(item)) removed += 1;
  if (added === 0 && removed === 0) return null;
  return `${label} +${added} -${removed}`;
}

// Human readable one-liner describing what changed between two snapshots.
export function computeDiffSummary(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string {
  if (previous === null) {
    return `initial snapshot, version ${String(next.version ?? "unknown")}`;
  }
  const parts: string[] = [];
  if (previous.version !== next.version) {
    parts.push(`version ${String(previous.version)} -> ${String(next.version)}`);
  }

  const indexById = (value: unknown): Map<string, string> => {
    const map = new Map<string, string>();
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          const id = (item as Record<string, unknown>).id;
          if (typeof id === "string") map.set(id, JSON.stringify(item));
        }
      }
    }
    return map;
  };
  const before = indexById(previous.phishing_indicators);
  const after = indexById(next.phishing_indicators);
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, serialized] of after) {
    if (!before.has(id)) added += 1;
    else if (before.get(id) !== serialized) changed += 1;
  }
  for (const id of before.keys()) if (!after.has(id)) removed += 1;
  if (added + removed + changed > 0) {
    parts.push(`indicators +${added} -${removed} ~${changed}`);
  }

  const trusted = summarizeStringArray(
    "trusted_login_patterns",
    previous.trusted_login_patterns,
    next.trusted_login_patterns,
  );
  if (trusted !== null) parts.push(trusted);

  const previousExclusion =
    previous.exclusion_system !== null && typeof previous.exclusion_system === "object"
      ? (previous.exclusion_system as Record<string, unknown>).domain_patterns
      : undefined;
  const nextExclusion =
    next.exclusion_system !== null && typeof next.exclusion_system === "object"
      ? (next.exclusion_system as Record<string, unknown>).domain_patterns
      : undefined;
  const exclusion = summarizeStringArray(
    "exclusion domain_patterns",
    previousExclusion,
    nextExclusion,
  );
  if (exclusion !== null) parts.push(exclusion);

  const beforeSections = new Set(Object.keys(previous));
  const afterSections = new Set(Object.keys(next));
  const newSections = [...afterSections].filter((key) => !beforeSections.has(key));
  const goneSections = [...beforeSections].filter((key) => !afterSections.has(key));
  if (newSections.length > 0) parts.push(`new sections: ${newSections.join(", ")}`);
  if (goneSections.length > 0) parts.push(`removed sections: ${goneSections.join(", ")}`);

  return parts.length > 0 ? parts.join("; ") : "no structural changes";
}

// Fetches the upstream rules file, validates it, snapshots it to R2, and
// auto-publishes every tenant that has a published version. A validation
// failure stores the bad snapshot for forensics but never replaces the
// active one (design 1.4 and 9.3).
export async function syncUpstream(
  env: Env,
  operator: string,
  fetcher: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const settings = await getInstanceSettings(env.DB);
  const url = settings.upstream_source_url;

  let body: string;
  try {
    const response = await fetcher(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      const outcome: SyncOutcome = {
        status: "fetch_error",
        errors: [`upstream fetch returned HTTP ${response.status}`],
      };
      await writeAudit(env.DB, operator, "upstream.sync", null, outcome);
      return outcome;
    }
    body = await response.text();
  } catch (err) {
    const outcome: SyncOutcome = {
      status: "fetch_error",
      errors: [
        "upstream fetch failed: " + (err instanceof Error ? err.message : String(err)),
      ],
    };
    await writeAudit(env.DB, operator, "upstream.sync", null, outcome);
    return outcome;
  }

  const hash = await sha256Hex(body);
  const active = await getActiveSnapshot(env.DB);
  if (active !== null && active.hash === hash) {
    const outcome: SyncOutcome = { status: "unchanged", snapshotId: active.id };
    await writeAudit(env.DB, operator, "upstream.sync", null, outcome);
    return outcome;
  }

  const fetchedAt = nowIso();
  const snapshotId = newId();
  const r2Key = `upstream/${fetchedAt.replace(/[:.]/g, "-")}-${hash.slice(0, 12)}.json`;

  const validation = validateRuleset(body);
  if (!validation.ok) {
    await env.STORAGE.put(r2Key, body, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    await env.DB.prepare(
      "INSERT INTO upstream_snapshots (id, fetched_at, upstream_version, r2_key, hash, status, diff_summary) " +
        "VALUES (?, ?, ?, ?, ?, 'failed_validation', ?)",
    )
      .bind(
        snapshotId,
        fetchedAt,
        null,
        r2Key,
        hash,
        `validation failed: ${validation.errors.slice(0, 5).join("; ")}`,
      )
      .run();
    const outcome: SyncOutcome = {
      status: "failed_validation",
      snapshotId,
      errors: validation.errors,
    };
    await writeAudit(env.DB, operator, "upstream.sync", null, {
      status: outcome.status,
      snapshotId,
      errors: validation.errors.slice(0, 10),
    });
    return outcome;
  }

  const ruleset = validation.ruleset as Record<string, unknown>;
  const previousRuleset = active !== null ? await loadSnapshotRuleset(env, active) : null;
  const diffSummary = computeDiffSummary(previousRuleset, ruleset);

  await env.STORAGE.put(r2Key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  const statements = [
    env.DB.prepare(
      "INSERT INTO upstream_snapshots (id, fetched_at, upstream_version, r2_key, hash, status, diff_summary) " +
        "VALUES (?, ?, ?, ?, ?, 'active', ?)",
    ).bind(
      snapshotId,
      fetchedAt,
      typeof ruleset.version === "string" ? ruleset.version : null,
      r2Key,
      hash,
      diffSummary,
    ),
  ];
  if (active !== null) {
    statements.push(
      env.DB.prepare(
        "UPDATE upstream_snapshots SET status = 'superseded' WHERE id = ?",
      ).bind(active.id),
    );
  }
  await env.DB.batch(statements);

  // Re-merge and auto-publish every tenant with a published version, using
  // the delta frozen in that version (never the operator's draft).
  const { republished, failures: republishFailures } = await republishAllTenants(
    env,
    "cron",
    `upstream auto-publish of snapshot ${snapshotId}`,
    operator,
  );

  const outcome: SyncOutcome = {
    status: "updated",
    snapshotId,
    diffSummary,
    republished,
    republishFailures,
  };
  await writeAudit(env.DB, operator, "upstream.sync", null, {
    status: outcome.status,
    snapshotId,
    diffSummary,
    republished,
    republishFailures: republishFailures.length,
  });
  return outcome;
}

// Keeps the newest N snapshots (any status) plus the active one; deletes
// older rows and their R2 objects. Returns how many were removed.
export async function pruneSnapshots(env: Env, keep: number): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key, status FROM upstream_snapshots ORDER BY fetched_at DESC",
  ).all<Pick<UpstreamSnapshotRow, "id" | "r2_key" | "status">>();
  const excess = results.slice(keep).filter((row) => row.status !== "active");
  for (const row of excess) {
    await env.STORAGE.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM upstream_snapshots WHERE id = ?")
      .bind(row.id)
      .run();
  }
  return excess.length;
}
