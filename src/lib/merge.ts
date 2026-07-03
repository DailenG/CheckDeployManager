// Delta merge engine (design 2.3). The tenant delta is small and additive:
// arrays append onto the matching upstream section, suppress_indicator_ids
// removes upstream indicators by id, raw_overrides deep-merges last as the
// escape hatch. The merge is a pure function of its inputs, so re-merging
// the same snapshot and delta is idempotent.

export interface TenantDelta {
  add_exclusion_domain_patterns?: string[];
  add_trusted_login_patterns?: string[];
  add_phishing_indicators?: Record<string, unknown>[];
  suppress_indicator_ids?: string[];
  raw_overrides?: Record<string, unknown>;
}

export interface MergeOptions {
  suffixLabel: string;
  versionNumber: number;
  publishedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Objects merge recursively; arrays and scalars from the override replace.
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = deepMerge(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// Applies one delta without version stamping. Deltas layer by repeated
// application: the instance baseline delta applies first, then the tenant
// delta on its output, so tenant suppressions can remove baseline-added
// indicators and the duplicate-id gate catches collisions between the two.
export function applyDelta(
  base: Record<string, unknown>,
  delta: TenantDelta,
): Record<string, unknown> {
  // Deep copy so callers can reuse the base object across tenants.
  let merged: Record<string, unknown> = JSON.parse(JSON.stringify(base));

  if (delta.add_trusted_login_patterns?.length) {
    const existing = Array.isArray(merged.trusted_login_patterns)
      ? (merged.trusted_login_patterns as unknown[])
      : [];
    merged.trusted_login_patterns = [
      ...existing,
      ...delta.add_trusted_login_patterns,
    ];
  }

  if (delta.add_exclusion_domain_patterns?.length) {
    const exclusion = isPlainObject(merged.exclusion_system)
      ? (merged.exclusion_system as Record<string, unknown>)
      : {};
    const existing = Array.isArray(exclusion.domain_patterns)
      ? (exclusion.domain_patterns as unknown[])
      : [];
    merged.exclusion_system = {
      ...exclusion,
      domain_patterns: [...existing, ...delta.add_exclusion_domain_patterns],
    };
  }

  if (delta.suppress_indicator_ids?.length || delta.add_phishing_indicators?.length) {
    const suppressed = new Set(delta.suppress_indicator_ids ?? []);
    const existing = Array.isArray(merged.phishing_indicators)
      ? (merged.phishing_indicators as Record<string, unknown>[])
      : [];
    merged.phishing_indicators = [
      ...existing.filter((indicator) => !suppressed.has(indicator.id as string)),
      ...(delta.add_phishing_indicators ?? []),
    ];
  }

  if (delta.raw_overrides && Object.keys(delta.raw_overrides).length > 0) {
    merged = deepMerge(merged, delta.raw_overrides);
  }

  return merged;
}

export function mergeRuleset(
  upstream: Record<string, unknown>,
  delta: TenantDelta,
  options: MergeOptions,
): Record<string, unknown> {
  const merged = applyDelta(upstream, delta);

  // Keep the upstream version with a tenant suffix and stamp publish time.
  const upstreamVersion =
    typeof merged.version === "string" && merged.version.length > 0
      ? merged.version
      : "0.0.0";
  const baseVersion = upstreamVersion.split("+")[0];
  merged.version = `${baseVersion}+${options.suffixLabel}.${options.versionNumber}`;
  merged.lastUpdated = options.publishedAt;

  return merged;
}
