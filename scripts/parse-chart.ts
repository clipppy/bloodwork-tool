/**
 * Parse the master blood-marker chart into structured JSON.
 *
 * Approach (two-pass):
 *  1. Find every "marker start" pair (nameLine, resultLine) where the name
 *     is a short line followed within 2 lines by `\tResult: ... Lab Range ...`.
 *  2. For each marker, everything between its name line and the next
 *     marker's name line is its body. Parse Increase/Decrease causes
 *     from that body.
 *
 * Outputs scripts/output/markers.json + scripts/output/markers-warnings.txt
 * so we can hand-review before writing the TS module.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve("scripts/output/master-chart-raw.txt");
const OUT = path.resolve("scripts/output/markers.json");
const WARN = path.resolve("scripts/output/markers-warnings.txt");

const CATEGORIES = [
  "Overall Blood Health",
  "Immune Status",
  "Kidney",
  "Liver & Gall Bladder",
  "Cholesterol, Heart & Vascular Health",
  "Blood Sugar Metabolism",
  "Systemic Inflammatory Markers",
  "Vitamins, Minerals, & Electrolytes",
  "Iron Status",
  "Gut & Digestive Health",
  "Estrogens",
  "Cardio IQ Tests",
];

// Skip these as standalone markers — they're sub-headings, ratios, or info-only blocks
const SKIP_NAMES = new Set([
  "Cholesterol Ratio HDL/Total",
  "Cholesterol Ratio Triglyceride/HDL",
  "LDL Particle Size",
  "MTHFR Mutation",
  "Recommended Treatment for MTHFR Mutation",
  "Food Sensitivities",
]);

// Lines that terminate the PREVIOUS marker's cause block. These are info-only
// sections in the chart (no Result line) whose narrative would otherwise bleed
// into the prior marker's increase/decrease lists.
const CAUSE_BOUNDARIES = new Set([
  ...SKIP_NAMES,
  ...CATEGORIES,
  "Uric Acid",
  "Cortisol",
  "Estrogens",
]);

type Range = { min: number | null; max: number | null };

interface RawMarker {
  canonicalName: string;
  category: string;
  rangeLine: string;
  labRange: Range;
  optimalRange: Range;
  optimalRangeBySex?: { male: Range; female: Range };
  increaseCauses: string[];
  decreaseCauses: string[];
  note?: string;
}

const warnings: string[] = [];

function parseRange(s: string): Range {
  const cleaned = s.replace(/[()]/g, "").trim();
  if (!cleaned) return { min: null, max: null };

  const geq = cleaned.match(/^>\s*\/?=?\s*([\d.]+)/);
  if (geq) return { min: Number(geq[1]), max: null };

  const leq = cleaned.match(/^<\s*\/?=?\s*([\d.]+)/);
  if (leq) return { min: null, max: Number(leq[1]) };

  const m = cleaned.match(/^([\d.]+)\s*-\s*([\d.]+)/);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };

  return { min: null, max: null };
}

function parseRangeLine(line: string): {
  labRange: Range;
  optimalRange: Range;
  optimalRangeBySex?: { male: Range; female: Range };
  note?: string;
} {
  // Cardio IQ "(Optimal X) (Moderate Y) (High Z)" format
  if (/Optimal[^)]*\)\s*\(Moderate/i.test(line)) {
    const opt = line.match(/\(Optimal\s+([^)]+)\)/i);
    const high = line.match(/\(High\s+([^)]+)\)/i);
    const optimalRange = opt ? parseRange(opt[1]) : { min: null, max: null };
    return {
      labRange: optimalRange,
      optimalRange,
      note: high ? `High band: ${high[1].trim()}` : undefined,
    };
  }

  const labMatch = line.match(/Lab Range\s*([^)]*\))/i);
  const labRangeStr = labMatch ? labMatch[1] : "";
  const labRange = parseRange(labRangeStr);

  // Sex-specific optimal range: "Optimal Range M (...) F(...)"
  const sex = line.match(
    /Optimal Range\s*M\s*\(([^)]+)\)\s*F\s*\(([^)]+)\)/i,
  );
  if (sex) {
    const male = parseRange(sex[1]);
    const female = parseRange(sex[2]);
    const optimalRange: Range = {
      min:
        male.min !== null && female.min !== null
          ? Math.min(male.min, female.min)
          : (male.min ?? female.min),
      max:
        male.max !== null && female.max !== null
          ? Math.max(male.max, female.max)
          : (male.max ?? female.max),
    };
    return { labRange, optimalRange, optimalRangeBySex: { male, female } };
  }

  const opt = line.match(/Optimal Range\s*\(([^)]+)\)/i);
  const optimalRange = opt ? parseRange(opt[1]) : { min: null, max: null };
  return { labRange, optimalRange };
}

function cleanName(raw: string): string {
  return raw
    .replace(/^\(\s*[A-Za-z\/]+\s*\)\s*/, "") // strip (H)/(L)/(Optimal)/etc.
    .replace(/\s+/g, " ")
    .trim();
}

function isResultLine(s: string): boolean {
  return /Result\s*:/i.test(s) && /Lab Range/i.test(s);
}

function findCategoryAbove(lines: string[], from: number): string {
  for (let j = from; j >= 0; j--) {
    const t = lines[j].trim();
    if (CATEGORIES.includes(t)) return t;
  }
  return "uncategorized";
}

interface MarkerStart {
  nameIdx: number;
  resultIdx: number;
  canonicalName: string;
  category: string;
}

function findMarkerStarts(lines: string[]): MarkerStart[] {
  const starts: MarkerStart[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!isResultLine(lines[i])) continue;

    // Skip the embedded duplicate example "(L) LDH (lactate-dehydrogenase):" sample
    // line at ~1228 — it's the SAME marker as the preceding LDH entry. Detect:
    // result lines that DON'T contain "Result:" with optional indentation but rather
    // are bare numeric samples like "115  Lab Range ...". The previous line ends
    // with ":" (e.g. "(L) LDH (lactate-dehydrogenase):").
    if (!/Result\s*:/i.test(lines[i]) || /^\s*\d/.test(lines[i])) {
      continue;
    }

    // Two patterns:
    //  A) Inline marker (e.g. allergens): "(H)  Casein\t\tResult: 13.2\tLab Range (<2)"
    //  B) Header above: a name line within ~2 lines above with the Result: line indented.

    // Check inline first: is there a marker-name-like token BEFORE "Result:" on this line?
    const beforeResult = lines[i]
      .split(/Result\s*:/i)[0]
      .replace(/^\s*\(\s*[A-Za-z\/]+\s*\)\s*/, "")
      .trim();

    // Special: EBV antibody sub-tests have the antibody name BETWEEN the result
    // value and "Lab Range":  "(H)  Result: 64.20   Early Antigen IgG    Lab Range (9-10.99)"
    // The "Epstein-Barr" parent appears as a separate name line above the 4 sub-rows.
    // Only activate this pattern when the parent IS Epstein-Barr (otherwise it
    // wrongly catches Cardio IQ "Result: 1209  Lab Range ..." rows etc.).
    if (
      (!beforeResult || beforeResult === "") &&
      /Result\s*:\s*\S+\s+\S.*Lab Range/i.test(lines[i])
    ) {
      // Find parent line first
      let parent: string | null = null;
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        const t = lines[j].trim();
        if (!t) continue;
        if (CATEGORIES.includes(t)) break;
        if (/^Result\s*:/i.test(t)) break;
        if (t.length > 70 || /[.!?]$/.test(t)) break;
        parent = t;
        break;
      }
      // Walk further back to find Epstein-Barr if parent is just another sub-row
      if (!parent || !/Epstein-Barr/i.test(parent)) {
        for (let j = i - 1; j >= Math.max(0, i - 25); j--) {
          const t = lines[j].trim();
          if (/^Epstein-Barr$/i.test(t)) {
            parent = "Epstein-Barr";
            break;
          }
          if (CATEGORIES.includes(t) && t !== "Immune Status") break;
        }
      }
      if (parent === "Epstein-Barr") {
        const mid = lines[i].match(/Result\s*:\s*\S+\s+(.+?)\s+Lab Range/i);
        if (mid) {
          const subName = cleanName(mid[1]);
          const canonicalName = `EBV ${subName}`;
          if (!SKIP_NAMES.has(canonicalName)) {
            starts.push({
              nameIdx: i,
              resultIdx: i,
              canonicalName,
              category: findCategoryAbove(lines, i),
            });
          }
          continue;
        }
      }
    }

    // Special: T3/T4 Free/Total sub-rows. The line starts with "Free:" or
    // "Total:" and the PARENT marker name is on a line above (e.g. "Serum
    // Thyroxine (T4) Free and Total"). Combine into "T4 Free" / "T4 Total".
    const fracMatch = beforeResult.match(/^(Free|Total)\s*:?\s*$/i);
    if (fracMatch) {
      const which = fracMatch[1][0].toUpperCase() + fracMatch[1].slice(1).toLowerCase();
      let parent: string | null = null;
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        const t = lines[j].trim();
        if (!t) continue;
        if (CATEGORIES.includes(t)) break;
        if (/^Result\s*:/i.test(t)) break;
        if (/^(Free|Total)\s*:/i.test(t)) continue;
        if (t.length > 90 || /[.!?]$/.test(t)) continue;
        parent = t;
        break;
      }
      // Extract T3/T4 from parent like "Serum Thyroxine (T4) Free and Total"
      // or "Triiodothryonine (T3) Free and Total"
      let prefix = "";
      if (parent) {
        const m3 = parent.match(/\(\s*(T[34])\s*\)/i);
        if (m3) prefix = m3[1].toUpperCase();
      }
      const canonicalName = prefix ? `${prefix} ${which}` : `${parent ?? "?"} ${which}`;
      starts.push({
        nameIdx: i,
        resultIdx: i,
        canonicalName,
        category: findCategoryAbove(lines, i),
      });
      continue;
    }

    if (beforeResult && /[A-Za-z]{2,}/.test(beforeResult) && beforeResult.length < 40) {
      // Inline marker — name is on the same line as Result:
      const canonicalName = cleanName(beforeResult);
      if (SKIP_NAMES.has(canonicalName)) continue;
      starts.push({
        nameIdx: i,
        resultIdx: i,
        canonicalName,
        category: findCategoryAbove(lines, i),
      });
      continue;
    }

    // Header pattern: walk backwards up to ~5 lines to find the name line.
    let nameIdx = -1;
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      const t = lines[j].trim();
      if (!t) continue;
      if (CATEGORIES.includes(t)) break; // gone past a section header — give up
      if (/^Increased?:?$|^Decreased?:?$/i.test(t)) break;
      if (/^Result\s*:/i.test(t)) break;
      // Description sentences are long and end in punctuation
      if (t.length > 70 || /[.!?]$/.test(t)) break;
      nameIdx = j;
      break;
    }

    if (nameIdx === -1) {
      warnings.push(`Line ${i + 1}: result line w/o name above: ${lines[i].trim()}`);
      continue;
    }

    const canonicalName = cleanName(lines[nameIdx].trim());
    if (SKIP_NAMES.has(canonicalName)) continue;
    if (!canonicalName) continue;

    starts.push({
      nameIdx,
      resultIdx: i,
      canonicalName,
      category: findCategoryAbove(lines, nameIdx),
    });
  }

  return starts;
}

function parseCauses(
  lines: string[],
  fromExclusive: number,
  toExclusive: number,
): { increase: string[]; decrease: string[] } {
  const causes = { increase: [] as string[], decrease: [] as string[] };
  let mode: "increase" | "decrease" | null = null;

  for (let i = fromExclusive + 1; i < toExclusive; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // Hard stop: hit an info-only section header that would otherwise bleed.
    if (CAUSE_BOUNDARIES.has(t)) break;
    if (/^Increased?:?$/i.test(t)) {
      mode = "increase";
      continue;
    }
    if (/^Decreased?:?$/i.test(t)) {
      mode = "decrease";
      continue;
    }
    if (mode === null) continue;
    // Skip leftover headers from the embedded LDH sample ("An elevated level of LD may be seen with:" etc.)
    if (/:$/.test(t) && t.length < 60) continue;
    causes[mode].push(t);
  }

  return causes;
}

function parse(): RawMarker[] {
  const lines = fs.readFileSync(SRC, "utf8").split("\n").map((l) => l.replace(/\s+$/, ""));

  const starts = findMarkerStarts(lines);

  const markers: RawMarker[] = [];

  for (let k = 0; k < starts.length; k++) {
    const cur = starts[k];
    const next = starts[k + 1];
    const blockEnd = next ? next.nameIdx : lines.length;

    const rangeLine = lines[cur.resultIdx];
    const { labRange, optimalRange, optimalRangeBySex, note } = parseRangeLine(rangeLine);

    const { increase, decrease } = parseCauses(lines, cur.resultIdx, blockEnd);

    markers.push({
      canonicalName: cur.canonicalName,
      category: cur.category,
      rangeLine: rangeLine.trim(),
      labRange,
      optimalRange,
      optimalRangeBySex,
      increaseCauses: increase,
      decreaseCauses: decrease,
      note,
    });
  }

  // Dedupe: keep richest entry per canonical name.
  const byName = new Map<string, RawMarker>();
  for (const m of markers) {
    const existing = byName.get(m.canonicalName);
    if (!existing) {
      byName.set(m.canonicalName, m);
      continue;
    }
    const score = (x: RawMarker) =>
      (x.optimalRange.min !== null || x.optimalRange.max !== null ? 5 : 0) +
      x.increaseCauses.length +
      x.decreaseCauses.length;
    if (score(m) > score(existing)) byName.set(m.canonicalName, m);
  }

  return Array.from(byName.values());
}

const markers = parse();
fs.writeFileSync(OUT, JSON.stringify(markers, null, 2));
fs.writeFileSync(WARN, warnings.length ? warnings.join("\n") : "No warnings.\n");

console.log(`Wrote ${markers.length} markers → ${path.relative(process.cwd(), OUT)}`);
console.log(`Warnings: ${warnings.length} → ${path.relative(process.cwd(), WARN)}`);

const byCat = new Map<string, number>();
for (const m of markers) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
console.log("\nBy category:");
for (const [cat, n] of byCat) console.log(`  ${n.toString().padStart(3)}  ${cat}`);
