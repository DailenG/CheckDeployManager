import { describe, expect, it } from "vitest";
import { mergeRuleset, type TenantDelta } from "../src/lib/merge";
import { validateRuleset } from "../src/lib/validate";
import upstreamFixture from "./fixtures/upstream-snapshot.json";

const upstream = upstreamFixture as unknown as Record<string, unknown>;
const options = {
  suffixLabel: "wdc",
  versionNumber: 7,
  publishedAt: "2026-07-01T00:00:00.000Z",
};

describe("mergeRuleset", () => {
  it("appends exclusion domain patterns", () => {
    const delta: TenantDelta = {
      add_exclusion_domain_patterns: ["^https://[^/]*\\.harborviewpt\\.com(/.*)?$"],
    };
    const merged = mergeRuleset(upstream, delta, options);
    const patterns = (merged.exclusion_system as any).domain_patterns as string[];
    const upstreamCount = (upstream.exclusion_system as any).domain_patterns.length;
    expect(patterns.length).toBe(upstreamCount + 1);
    expect(patterns[patterns.length - 1]).toBe(
      "^https://[^/]*\\.harborviewpt\\.com(/.*)?$",
    );
  });

  it("appends trusted login patterns", () => {
    const merged = mergeRuleset(
      upstream,
      { add_trusted_login_patterns: ["^https://login\\.harborviewpt\\.com$"] },
      options,
    );
    const patterns = merged.trusted_login_patterns as string[];
    expect(patterns[patterns.length - 1]).toBe("^https://login\\.harborviewpt\\.com$");
  });

  it("suppresses upstream indicators by id", () => {
    const merged = mergeRuleset(upstream, { suppress_indicator_ids: ["phi_004"] }, options);
    const ids = (merged.phishing_indicators as any[]).map((i) => i.id);
    expect(ids).not.toContain("phi_004");
    expect(ids.length).toBe((upstream.phishing_indicators as any[]).length - 1);
  });

  it("appends added indicators", () => {
    const added = {
      id: "hvpt_001",
      pattern: "harborviewpt-payroll-login",
      flags: "i",
      severity: "high",
      action: "block",
      confidence: 0.9,
      description: "Tenant specific indicator",
    };
    const merged = mergeRuleset(upstream, { add_phishing_indicators: [added] }, options);
    const ids = (merged.phishing_indicators as any[]).map((i) => i.id);
    expect(ids).toContain("hvpt_001");
  });

  it("deep-merges raw_overrides last", () => {
    const merged = mergeRuleset(
      upstream,
      { raw_overrides: { detection_settings: { block_threshold: 0.95 } } },
      options,
    );
    const settings = merged.detection_settings as Record<string, unknown>;
    expect(settings.block_threshold).toBe(0.95);
    // Sibling keys survive the deep merge.
    expect(settings.enable_real_time_scanning).toBe(
      (upstream.detection_settings as any).enable_real_time_scanning,
    );
  });

  it("suffixes the upstream version and stamps lastUpdated", () => {
    const merged = mergeRuleset(upstream, {}, options);
    expect(merged.version).toBe(`${upstream.version}+wdc.7`);
    expect(merged.lastUpdated).toBe("2026-07-01T00:00:00.000Z");
  });

  it("does not stack suffixes when re-merging suffixed input", () => {
    const once = mergeRuleset(upstream, {}, options);
    const twice = mergeRuleset(once, {}, { ...options, versionNumber: 8 });
    expect(twice.version).toBe(`${upstream.version}+wdc.8`);
  });

  it("is idempotent for identical inputs", () => {
    const delta: TenantDelta = {
      add_exclusion_domain_patterns: ["^https://[^/]*\\.knowbe4\\.com(/.*)?$"],
      suppress_indicator_ids: ["phi_004"],
      raw_overrides: { detection_settings: { warn_threshold: 0.5 } },
    };
    const first = mergeRuleset(upstream, delta, options);
    const second = mergeRuleset(upstream, delta, options);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("does not mutate the upstream object", () => {
    const before = JSON.stringify(upstream);
    mergeRuleset(
      upstream,
      {
        add_exclusion_domain_patterns: ["^https://x$"],
        suppress_indicator_ids: ["phi_004"],
        raw_overrides: { detection_settings: { block_threshold: 0.1 } },
      },
      options,
    );
    expect(JSON.stringify(upstream)).toBe(before);
  });

  it("produces output that passes the validation gates", () => {
    const merged = mergeRuleset(
      upstream,
      {
        add_exclusion_domain_patterns: ["^https://[^/]*\\.harborviewpt\\.com(/.*)?$"],
        suppress_indicator_ids: ["phi_004"],
      },
      options,
    );
    const result = validateRuleset(JSON.stringify(merged));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
