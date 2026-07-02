// Validation gates from design section 2.4. Check publishes no formal JSON
// Schema, so these are structural checks that stay tolerant of unknown keys.

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  ruleset?: Record<string, unknown>;
}

export const MAX_RULESET_BYTES = 1024 * 1024;

const REQUIRED_SECTIONS = [
  "trusted_login_patterns",
  "exclusion_system",
  "phishing_indicators",
  "m365_detection_requirements",
  "blocking_rules",
  "detection_settings",
];

const LEGAL_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const LEGAL_ACTIONS = new Set(["block", "warn", "monitor"]);

function compileRegex(pattern: unknown, flags: unknown): string | null {
  if (typeof pattern !== "string") return "pattern is not a string";
  try {
    new RegExp(pattern, typeof flags === "string" ? flags : undefined);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Runs gates 1 through 5 against a serialized ruleset body.
export function validateRuleset(body: string): ValidationResult {
  const errors: string[] = [];

  // Gate 1: parses and stays under the size cap.
  if (new TextEncoder().encode(body).length >= MAX_RULESET_BYTES) {
    return { ok: false, errors: ["body is 1 MB or larger"] };
  }
  let ruleset: Record<string, unknown>;
  try {
    ruleset = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      errors: [
        "body is not valid JSON: " +
          (err instanceof Error ? err.message : String(err)),
      ],
    };
  }
  if (ruleset === null || typeof ruleset !== "object" || Array.isArray(ruleset)) {
    return { ok: false, errors: ["body is not a JSON object"] };
  }

  // Gate 2: required sections present; unknown extras are tolerated.
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in ruleset)) {
      errors.push(`missing required section: ${section}`);
    }
  }

  // Gate 3: per indicator checks.
  const indicators = ruleset.phishing_indicators;
  if (Array.isArray(indicators)) {
    const seenIds = new Set<string>();
    indicators.forEach((indicator, index) => {
      if (indicator === null || typeof indicator !== "object") {
        errors.push(`phishing_indicators[${index}] is not an object`);
        return;
      }
      const record = indicator as Record<string, unknown>;
      const id = record.id;
      if (typeof id !== "string" || id.length === 0) {
        errors.push(`phishing_indicators[${index}] has no id`);
      } else if (seenIds.has(id)) {
        errors.push(`duplicate indicator id: ${id}`);
      } else {
        seenIds.add(id);
      }
      const label = typeof id === "string" ? id : `index ${index}`;
      if ("pattern" in record) {
        const regexError = compileRegex(record.pattern, record.flags);
        if (regexError !== null) {
          errors.push(`indicator ${label}: pattern does not compile: ${regexError}`);
        }
      }
      if ("severity" in record && !LEGAL_SEVERITIES.has(record.severity as string)) {
        errors.push(`indicator ${label}: illegal severity: ${String(record.severity)}`);
      }
      if ("action" in record && !LEGAL_ACTIONS.has(record.action as string)) {
        errors.push(`indicator ${label}: illegal action: ${String(record.action)}`);
      }
      if ("confidence" in record) {
        const confidence = record.confidence;
        if (
          typeof confidence !== "number" ||
          Number.isNaN(confidence) ||
          confidence < 0 ||
          confidence > 1
        ) {
          errors.push(`indicator ${label}: confidence out of range 0..1`);
        }
      }
    });
  } else if ("phishing_indicators" in ruleset) {
    errors.push("phishing_indicators is not an array");
  }

  // Gate 4: exclusion and trusted patterns compile.
  const trusted = ruleset.trusted_login_patterns;
  if (Array.isArray(trusted)) {
    trusted.forEach((pattern, index) => {
      const regexError = compileRegex(pattern, undefined);
      if (regexError !== null) {
        errors.push(`trusted_login_patterns[${index}] does not compile: ${regexError}`);
      }
    });
  } else if ("trusted_login_patterns" in ruleset) {
    errors.push("trusted_login_patterns is not an array");
  }
  const exclusion = ruleset.exclusion_system;
  if (exclusion !== null && typeof exclusion === "object" && !Array.isArray(exclusion)) {
    const domainPatterns = (exclusion as Record<string, unknown>).domain_patterns;
    if (Array.isArray(domainPatterns)) {
      domainPatterns.forEach((pattern, index) => {
        const regexError = compileRegex(pattern, undefined);
        if (regexError !== null) {
          errors.push(
            `exclusion_system.domain_patterns[${index}] does not compile: ${regexError}`,
          );
        }
      });
    }
  } else if ("exclusion_system" in ruleset) {
    errors.push("exclusion_system is not an object");
  }

  // Gate 5: output re-parses and round-trips.
  try {
    const roundTripped = JSON.parse(JSON.stringify(ruleset));
    if (JSON.stringify(roundTripped) !== JSON.stringify(ruleset)) {
      errors.push("ruleset does not survive a JSON round trip");
    }
  } catch {
    errors.push("ruleset does not survive a JSON round trip");
  }

  return errors.length === 0
    ? { ok: true, errors: [], ruleset }
    : { ok: false, errors, ruleset };
}

// Structural check for the per tenant delta document (design 2.3).
// Strict about keys so operator typos surface instead of silently no-oping.
export const DELTA_KEYS = [
  "add_exclusion_domain_patterns",
  "add_trusted_login_patterns",
  "add_phishing_indicators",
  "suppress_indicator_ids",
  "raw_overrides",
];

export function validateDelta(body: string): ValidationResult {
  const errors: string[] = [];
  let delta: Record<string, unknown>;
  try {
    delta = JSON.parse(body);
  } catch (err) {
    return {
      ok: false,
      errors: [
        "delta is not valid JSON: " +
          (err instanceof Error ? err.message : String(err)),
      ],
    };
  }
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) {
    return { ok: false, errors: ["delta is not a JSON object"] };
  }
  for (const key of Object.keys(delta)) {
    if (!DELTA_KEYS.includes(key)) {
      errors.push(`unknown delta key: ${key}`);
    }
  }
  for (const key of [
    "add_exclusion_domain_patterns",
    "add_trusted_login_patterns",
  ]) {
    const value = delta[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      errors.push(`${key} is not an array`);
      continue;
    }
    value.forEach((pattern, index) => {
      const regexError = compileRegex(pattern, undefined);
      if (regexError !== null) {
        errors.push(`${key}[${index}] does not compile: ${regexError}`);
      }
    });
  }
  const added = delta.add_phishing_indicators;
  if (added !== undefined && !Array.isArray(added)) {
    errors.push("add_phishing_indicators is not an array");
  }
  const suppressed = delta.suppress_indicator_ids;
  if (suppressed !== undefined) {
    if (!Array.isArray(suppressed)) {
      errors.push("suppress_indicator_ids is not an array");
    } else {
      suppressed.forEach((id, index) => {
        if (typeof id !== "string") {
          errors.push(`suppress_indicator_ids[${index}] is not a string`);
        }
      });
    }
  }
  const overrides = delta.raw_overrides;
  if (
    overrides !== undefined &&
    (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))
  ) {
    errors.push("raw_overrides is not an object");
  }
  return errors.length === 0
    ? { ok: true, errors: [], ruleset: delta }
    : { ok: false, errors, ruleset: delta };
}
