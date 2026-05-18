/**
 * Validate lib/ranges/optimal-ranges.ts for common structural errors.
 *
 * Run: npm run validate:ranges
 *
 * Exit code 1 if any hard error found, 0 if only warnings.
 */
import {
  OPTIMAL_RANGES,
  type MarkerRange,
  type InterpretationBand,
} from "../lib/ranges/optimal-ranges";

type Severity = "error" | "warn";

interface Finding {
  key: string;
  marker: string;
  severity: Severity;
  rule: string;
  detail: string;
}

const findings: Finding[] = [];

function record(
  key: string,
  marker: string,
  severity: Severity,
  rule: string,
  detail: string,
): void {
  findings.push({ key, marker, severity, rule, detail });
}

function rangePopulated(r: { min: number | null; max: number | null }): boolean {
  return r.min !== null || r.max !== null;
}

function bandsHaveIssues(bands: InterpretationBand[]): string | null {
  // Sort by min ascending (null treated as -Infinity).
  const sorted = [...bands].sort((a, b) => {
    const am = a.min ?? Number.NEGATIVE_INFINITY;
    const bm = b.min ?? Number.NEGATIVE_INFINITY;
    return am - bm;
  });

  // Mutation check: were the original bands already sorted?
  for (let i = 0; i < bands.length; i++) {
    if (bands[i] !== sorted[i]) {
      return `bands are not sorted by min ascending (saw "${bands[i].label}" before "${sorted[i].label}")`;
    }
  }

  // Check for gaps / overlaps between consecutive bands.
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev.max === null) {
      return `band "${prev.label}" has max=null but isn't the last band`;
    }
    if (curr.min === null) {
      return `band "${curr.label}" has min=null but isn't the first band`;
    }
    if (prev.max > curr.min) {
      return `bands "${prev.label}" and "${curr.label}" overlap (${prev.max} > ${curr.min})`;
    }
    if (prev.max < curr.min) {
      return `gap between "${prev.label}" (max ${prev.max}) and "${curr.label}" (min ${curr.min})`;
    }
  }
  return null;
}

function rangeTighter(
  optimal: { min: number | null; max: number | null },
  lab: { min: number | null; max: number | null },
): boolean {
  // optimal is tighter than lab if optimal.min >= lab.min AND optimal.max <= lab.max
  // (treating null as the appropriate infinity for whichever endpoint).
  const optMin = optimal.min ?? Number.NEGATIVE_INFINITY;
  const labMin = lab.min ?? Number.NEGATIVE_INFINITY;
  const optMax = optimal.max ?? Number.POSITIVE_INFINITY;
  const labMax = lab.max ?? Number.POSITIVE_INFINITY;
  return optMin >= labMin && optMax <= labMax;
}

function validateOne(key: string, m: MarkerRange): void {
  const name = m.canonicalName || `(key: ${key})`;

  if (!m.canonicalName) {
    record(key, name, "error", "canonicalName", "empty canonicalName");
  }

  if (!m.aliases || m.aliases.length < 2) {
    record(key, name, "error", "aliases", `expected >=2 aliases, found ${m.aliases?.length ?? 0}`);
  }

  // Unit can be empty for categorical markers (LDL Pattern, Candida Albicans, ANA).
  // Warn rather than error for empty units so the user can decide case-by-case.
  if (!m.unit) {
    record(key, name, "warn", "unit", "empty unit string — confirm this is intentional (categorical marker?)");
  }

  if (m.requiresConfirmation === true && !m.confirmationSource) {
    record(key, name, "error", "confirmationSource", "requiresConfirmation: true but no confirmationSource");
  }

  if (m.interpretationBands) {
    const bandIssue = bandsHaveIssues(m.interpretationBands);
    if (bandIssue) {
      record(key, name, "error", "interpretationBands", bandIssue);
    }
    if (rangePopulated(m.optimalRange) && !m.optimalRangeBySex) {
      record(
        key,
        name,
        "warn",
        "bands+optimalRange",
        "marker has both interpretationBands and a populated optimalRange (no optimalRangeBySex) — flagging mode is ambiguous",
      );
    }
  }

  if (
    rangePopulated(m.labRange) &&
    rangePopulated(m.optimalRange) &&
    !m.optimalRangeBySex
  ) {
    if (!rangeTighter(m.optimalRange, m.labRange)) {
      record(
        key,
        name,
        "warn",
        "optimal-vs-lab",
        `optimalRange [${m.optimalRange.min}..${m.optimalRange.max}] is not strictly within labRange [${m.labRange.min}..${m.labRange.max}] — confirm this is intentional`,
      );
    }
  }
}

for (const [key, m] of Object.entries(OPTIMAL_RANGES)) {
  validateOne(key, m);
}

// ---- Report -----------------------------------------------------------------

const errors = findings.filter((f) => f.severity === "error");
const warnings = findings.filter((f) => f.severity === "warn");
const total = Object.keys(OPTIMAL_RANGES).length;

const grouped = new Map<string, { errors: number; warnings: number }>();
for (const f of findings) {
  const g = grouped.get(f.rule) ?? { errors: 0, warnings: 0 };
  if (f.severity === "error") g.errors += 1;
  else g.warnings += 1;
  grouped.set(f.rule, g);
}

console.log(`Validated ${total} markers in OPTIMAL_RANGES`);
console.log(`Errors:   ${errors.length}`);
console.log(`Warnings: ${warnings.length}`);
console.log();

if (grouped.size) {
  console.log("By rule:");
  const rules = Array.from(grouped.entries()).sort();
  for (const [rule, counts] of rules) {
    const e = counts.errors ? `${counts.errors} error` + (counts.errors === 1 ? "" : "s") : "";
    const w = counts.warnings ? `${counts.warnings} warn` + (counts.warnings === 1 ? "" : "s") : "";
    const tags = [e, w].filter(Boolean).join(", ");
    console.log(`  ${rule.padEnd(22)}  ${tags}`);
  }
  console.log();
}

if (errors.length) {
  console.log("ERRORS:");
  for (const f of errors) {
    console.log(`  ✗ [${f.rule}] ${f.marker}: ${f.detail}`);
  }
  console.log();
}

if (warnings.length) {
  console.log("WARNINGS:");
  for (const f of warnings) {
    console.log(`  ! [${f.rule}] ${f.marker}: ${f.detail}`);
  }
  console.log();
}

if (errors.length === 0) {
  console.log("PASS");
  process.exit(0);
} else {
  console.log("FAIL");
  process.exit(1);
}
