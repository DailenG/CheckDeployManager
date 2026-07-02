import { describe, expect, it } from "vitest";
import { validateDelta, validateRuleset } from "../src/lib/validate";
import upstreamFixture from "./fixtures/upstream-snapshot.json";
import driftFixture from "./fixtures/upstream-drift.json";

const fixtureBody = JSON.stringify(upstreamFixture);

function withMutation(mutate: (ruleset: Record<string, any>) => void): string {
  const copy = JSON.parse(fixtureBody);
  mutate(copy);
  return JSON.stringify(copy);
}

describe("validateRuleset", () => {
  it("passes the real upstream fixture", () => {
    const result = validateRuleset(fixtureBody);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("tolerates unknown top-level sections (upstream drift)", () => {
    const result = validateRuleset(JSON.stringify(driftFixture));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect((result.ruleset as any).experimental_ml_scoring).toBeDefined();
  });

  it("rejects invalid JSON", () => {
    const result = validateRuleset("{not json");
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not valid JSON");
  });

  it("rejects bodies of 1 MB or larger", () => {
    const huge = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
    const result = validateRuleset(huge);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("1 MB");
  });

  it("rejects a missing required section", () => {
    const body = withMutation((r) => delete r.blocking_rules);
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("missing required section: blocking_rules");
  });

  it("rejects an indicator with no id", () => {
    const body = withMutation((r) => delete r.phishing_indicators[0].id);
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("has no id"))).toBe(true);
  });

  it("rejects duplicate indicator ids", () => {
    const body = withMutation((r) =>
      r.phishing_indicators.push({ ...r.phishing_indicators[0] }),
    );
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("duplicate indicator id"))).toBe(
      true,
    );
  });

  it("rejects an indicator regex that does not compile", () => {
    const body = withMutation((r) => {
      r.phishing_indicators[0].pattern = "([unclosed";
    });
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("does not compile"))).toBe(true);
  });

  it("rejects illegal severity, action, and confidence", () => {
    const body = withMutation((r) => {
      r.phishing_indicators[0].severity = "catastrophic";
      r.phishing_indicators[1].action = "explode";
      r.phishing_indicators[2].confidence = 3;
    });
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("illegal severity"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("illegal action"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("confidence out of range"))).toBe(
      true,
    );
  });

  it("rejects a trusted login pattern that does not compile", () => {
    const body = withMutation((r) => r.trusted_login_patterns.push("([bad"));
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e: string) => e.includes("trusted_login_patterns")),
    ).toBe(true);
  });

  it("rejects an exclusion domain pattern that does not compile", () => {
    const body = withMutation((r) =>
      r.exclusion_system.domain_patterns.push("([bad"),
    );
    const result = validateRuleset(body);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e: string) => e.includes("exclusion_system.domain_patterns")),
    ).toBe(true);
  });
});

describe("validateDelta", () => {
  it("passes the design sample delta", () => {
    const result = validateDelta(
      JSON.stringify({
        add_exclusion_domain_patterns: ["^https://[^/]*\\.knowbe4\\.com(/.*)?$"],
        add_trusted_login_patterns: [],
        add_phishing_indicators: [],
        suppress_indicator_ids: ["phi_004"],
        raw_overrides: {},
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes an empty delta", () => {
    expect(validateDelta("{}").ok).toBe(true);
  });

  it("rejects unknown keys", () => {
    const result = validateDelta(JSON.stringify({ add_exclusions: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown delta key");
  });

  it("rejects patterns that do not compile", () => {
    const result = validateDelta(
      JSON.stringify({ add_exclusion_domain_patterns: ["([bad"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects wrong types", () => {
    const result = validateDelta(
      JSON.stringify({ suppress_indicator_ids: "phi_004", raw_overrides: [] }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});
