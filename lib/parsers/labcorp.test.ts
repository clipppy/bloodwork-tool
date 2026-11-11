/**
 * Labcorp parser + lab-layout dispatcher regression test. Same house pattern
 * as quest.test.ts: a self-contained tsx script with a local ok(), non-zero
 * exit on failure.
 *
 * The fixture is the (fake-patient) Labcorp report in samples/labcorp/ (gitignored, like every sample). It is
 * parsed through pdf-parse exactly as the upload route does, so the
 * whitespace-collapsed form is what most assertions see. The wrapped-row form
 * (pdftotext -layout: name on one line, numbers on the next) is pinned with
 * verbatim lines from the same report.
 *
 * Run: npx tsx lib/parsers/labcorp.test.ts  (or: npm run test:labcorp-parser)
 */

import fs from "node:fs";
import path from "node:path";
import { parseLabcorpRow, parseLabcorpText, looksLikeLabcorpReport } from "./labcorp";
import { detectLabLayout, extractPdfText, parseLabReport, parseLabReportText } from "./dispatch";
import { parseQuestPdf, parseQuestText } from "./quest";
import { matchMarkers } from "../matcher";
import { flagMarkers } from "../flagging";
import { buildPanel, mergePanels } from "../analysis/merge-panels";
import { sourceTag } from "../analysis/panel-source";

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string) {
  if (cond) passed++;
  else failures.push(`  x ${msg}`);
}
function eq(actual: unknown, expected: unknown, label: string) {
  ok(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const FIXTURE = path.resolve("samples/labcorp/Diana Dean Lab Corp Nov 2026.pdf");
const QUEST_SAMPLES = ["samples/quest", "samples/function"]
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => path.resolve(d, f)))
  .sort();

// Every result row in the fixture: [name, value, flag, unit, printed range,
// previous value, previous date]. Read off the PDF by hand.
type Row = [string, number, "H" | "L" | null, string | null, string | null, number | null, string | null];
const EXPECTED: Row[] = [
  ["Iron Bind.Cap.(TIBC)", 286, null, "ug/dL", "250-450", 246, "08/05/2025"],
  ["UIBC", 74, "L", "ug/dL", "131-425", 136, "08/05/2025"],
  ["Iron", 212, "H", "ug/dL", "27-159", 110, "08/05/2025"],
  ["Iron Saturation", 74, "H", "%", "15-55", 45, "08/05/2025"],
  ["Ferritin", 266, null, "ng/mL", "30-280", 126, "08/05/2025"],
  ["TSH", 3.68, null, "uIU/mL", "0.450-4.500", 4.05, "08/05/2025"],
  ["Triiodothyronine (T3), Free", 4.0, null, "pg/mL", "2.0-4.4", 2.9, "08/05/2025"],
  ["T4,Free(Direct)", 1.01, null, "ng/dL", "0.82-1.77", 0.97, "08/05/2025"],
  ["WBC", 5.8, null, "x10E3/uL", "3.4-10.8", 5.4, "10/23/2025"],
  ["RBC", 4.04, null, "x10E6/uL", "3.77-5.28", 4.38, "10/23/2025"],
  ["Hemoglobin", 13.1, null, "g/dL", "11.1-15.9", 14.1, "10/23/2025"],
  ["Hematocrit", 37.4, null, "%", "34.0-46.6", 41.6, "10/23/2025"],
  ["MCV", 93, null, "fL", "79-97", 95, "10/23/2025"],
  ["MCH", 32.4, null, "pg", "26.6-33.0", 32.2, "10/23/2025"],
  ["MCHC", 35.0, null, "g/dL", "31.5-35.7", 33.9, "10/23/2025"],
  ["RDW", 11.4, "L", "%", "11.7-15.4", 11.7, "10/23/2025"],
  ["Platelets", 188, null, "x10E3/uL", "150-450", 191, "10/23/2025"],
  ["Neutrophils", 58, null, "%", null, 57, "10/23/2025"],
  ["Lymphs", 33, null, "%", null, 34, "10/23/2025"],
  ["Monocytes", 6, null, "%", null, 6, "10/23/2025"],
  ["Eos", 2, null, "%", null, 2, "10/23/2025"],
  ["Basos", 1, null, "%", null, 1, "10/23/2025"],
  ["Neutrophils (Absolute)", 3.4, null, "x10E3/uL", "1.4-7.0", 3.1, "10/23/2025"],
  ["Lymphs (Absolute)", 1.9, null, "x10E3/uL", "0.7-3.1", 1.8, "10/23/2025"],
  ["Monocytes(Absolute)", 0.3, null, "x10E3/uL", "0.1-0.9", 0.3, "10/23/2025"],
  ["Eos (Absolute)", 0.1, null, "x10E3/uL", "0.0-0.4", 0.1, "10/23/2025"],
  ["Baso (Absolute)", 0.0, null, "x10E3/uL", "0.0-0.2", 0.1, "10/23/2025"],
  ["Immature Granulocytes", 0, null, "%", null, 0, "10/23/2025"],
  ["Immature Grans (Abs)", 0.0, null, "x10E3/uL", "0.0-0.1", 0.0, "10/23/2025"],
  ["Glucose", 83, null, "mg/dL", "70-99", 74, "10/23/2025"],
  ["BUN", 17, null, "mg/dL", "6-24", 16, "10/23/2025"],
  ["Creatinine", 1.04, "H", "mg/dL", "0.57-1.00", 1.02, "10/23/2025"],
  ["eGFR", 63, null, "mL/min/1.73", ">59", 65, "10/23/2025"],
  ["BUN/Creatinine Ratio", 16, null, null, "9-23", 16, "10/23/2025"],
  ["Sodium", 138, null, "mmol/L", "134-144", 140, "10/23/2025"],
  ["Potassium", 4.2, null, "mmol/L", "3.5-5.2", 4.3, "10/23/2025"],
  ["Chloride", 99, null, "mmol/L", "96-106", 103, "10/23/2025"],
  ["Carbon Dioxide, Total", 22, null, "mmol/L", "20-29", 24, "10/23/2025"],
  ["Calcium", 9.7, null, "mg/dL", "8.7-10.2", 9.4, "10/23/2025"],
  ["Protein, Total", 7.5, null, "g/dL", "6.0-8.5", 7.3, "10/23/2025"],
  ["Albumin", 5.1, "H", "g/dL", "3.8-4.9", 4.9, "10/23/2025"],
  ["Globulin, Total", 2.4, null, "g/dL", "1.5-4.5", 2.4, "10/23/2025"],
  ["Bilirubin, Total", 2.2, "H", "mg/dL", "0.0-1.2", 2.6, "10/23/2025"],
  ["Alkaline Phosphatase", 113, null, "IU/L", "49-135", 93, "10/23/2025"],
  ["AST (SGOT)", 18, null, "IU/L", "0-40", 19, "10/23/2025"],
  ["ALT (SGPT)", 9, null, "IU/L", "0-32", 12, "10/23/2025"],
  ["Cholesterol, Total", 193, null, "mg/dL", "100-199", null, null],
  ["Triglycerides", 67, null, "mg/dL", "0-149", null, null],
  ["HDL Cholesterol", 74, null, "mg/dL", ">39", null, null],
  ["VLDL Cholesterol Cal", 11, null, "mg/dL", "5-40", null, null],
  ["LDL Chol Calc (NIH)", 108, "H", "mg/dL", "0-99", null, null],
  ["Hemoglobin A1c", 4.7, "L", "%", "4.8-5.6", 4.7, "10/23/2025"],
  ["C-Reactive Protein, Cardiac", 0.89, null, "mg/L", "0.00-3.00", null, null],
  ["Apolipoprotein B", 83, null, "mg/dL", "<90", null, null],
];

/** Markers the fixture prints that have no dictionary record (reported, not
 *  matched). VLDL is here deliberately: it must NOT fuzzy-match LDL. */
const KNOWN_UNMATCHED = new Set(["UIBC", "Immature Granulocytes", "Immature Grans (Abs)", "VLDL Cholesterol Cal"]);

/** The result tables of the same report as pdf-parse emits them (columns
 *  collapsed to single spaces, wrapped rows already joined), with the
 *  patient header lines left out. This is what the upload route parses, and
 *  it keeps the test runnable when the PDF is absent (samples/ is
 *  gitignored). */
const COLLAPSED_FORM = `Date Collected: 11/02/2026 Date Received: 11/02/2026 Date Reported: 11/03/2026 Fasting: Yes
Fe+TIBC+Fer
Test Current Result and Flag Previous Result and Date Units Reference Interval
Iron Bind.Cap.(TIBC) 286 246 08/05/2025 ug/dL 250-450
UIBC 01 74 Low 136 08/05/2025 ug/dL 131-425
Iron 01 212 High 110 08/05/2025 ug/dL 27-159
Iron Saturation 74 High 45 08/05/2025 % 15-55
Ferritin 01 266 126* 08/05/2025 ng/mL 30-280
* Previous Reference Interval: (Ferritin: 15-150 ng/mL)
TSH+T4F+T3Free
Test Current Result and Flag Previous Result and Date Units Reference Interval
TSH 01 3.680 4.050 08/05/2025 uIU/mL 0.450-4.500
Triiodothyronine (T3), Free 01 4.0 2.9 08/05/2025 pg/mL 2.0-4.4
T4,Free(Direct) 01 1.01 0.97 08/05/2025 ng/dL 0.82-1.77
CBC With Differential/Platelet
Test Current Result and Flag Previous Result and Date Units Reference Interval
WBC 01 5.8 5.4 10/23/2025 x10E3/uL 3.4-10.8
RBC 01 4.04 4.38 10/23/2025 x10E6/uL 3.77-5.28
Hemoglobin 01 13.1 14.1 10/23/2025 g/dL 11.1-15.9
Hematocrit 01 37.4 41.6 10/23/2025 % 34.0-46.6
MCV 01 93 95 10/23/2025 fL 79-97
MCH 01 32.4 32.2 10/23/2025 pg 26.6-33.0
MCHC 01 35.0 33.9 10/23/2025 g/dL 31.5-35.7
RDW 01 11.4 Low 11.7 10/23/2025 % 11.7-15.4
Platelets 01 188 191 10/23/2025 x10E3/uL 150-450
Neutrophils 01 58 57 10/23/2025 % Not Estab.
Lymphs 01 33 34 10/23/2025 % Not Estab.
Monocytes 01 6 6 10/23/2025 % Not Estab.
Eos 01 2 2 10/23/2025 % Not Estab.
Basos 01 1 1 10/23/2025 % Not Estab.
Neutrophils (Absolute) 01 3.4 3.1 10/23/2025 x10E3/uL 1.4-7.0
Lymphs (Absolute) 01 1.9 1.8 10/23/2025 x10E3/uL 0.7-3.1
Monocytes(Absolute) 01 0.3 0.3 10/23/2025 x10E3/uL 0.1-0.9
Eos (Absolute) 01 0.1 0.1 10/23/2025 x10E3/uL 0.0-0.4
Baso (Absolute) 01 0.0 0.1 10/23/2025 x10E3/uL 0.0-0.2
Immature Granulocytes 01 0 0 10/23/2025 % Not Estab.
Immature Grans (Abs) 01 0.0 0.0 10/23/2025 x10E3/uL 0.0-0.1
Date Created and Stored 11/03/26 1807 ET Final Report Page 1 of 5
©2026 Laboratory Corporation of America® Holdings
All Rights Reserved - Enterprise Report Version 2.00
This document contains private and confidential health information protected by state and federal law.
If you have received this document in error please call 800-631-5250

-- 1 of 5 --

Date Collected: 11/02/2026
Comp. Metabolic Panel (14)
Test Current Result and Flag Previous Result and Date Units Reference Interval
Glucose 01 83 74 10/23/2025 mg/dL 70-99
BUN 01 17 16 10/23/2025 mg/dL 6-24
Creatinine 01 1.04 High 1.02 10/23/2025 mg/dL 0.57-1.00
eGFR 63 65 10/23/2025 mL/min/1.73 >59
BUN/Creatinine Ratio 16 16 10/23/2025 9-23
Sodium 01 138 140 10/23/2025 mmol/L 134-144
Potassium 01 4.2 4.3 10/23/2025 mmol/L 3.5-5.2
Chloride 01 99 103 10/23/2025 mmol/L 96-106
Carbon Dioxide, Total 01 22 24 10/23/2025 mmol/L 20-29
Calcium 01 9.7 9.4 10/23/2025 mg/dL 8.7-10.2
Protein, Total 01 7.5 7.3 10/23/2025 g/dL 6.0-8.5
Albumin 01 5.1 High 4.9 10/23/2025 g/dL 3.8-4.9
Globulin, Total 2.4 2.4 10/23/2025 g/dL 1.5-4.5
Bilirubin, Total 01 2.2 High 2.6 10/23/2025 mg/dL 0.0-1.2
Alkaline Phosphatase 01 113 93 10/23/2025 IU/L 49-135
AST (SGOT) 01 18 19 10/23/2025 IU/L 0-40
ALT (SGPT) 01 9 12 10/23/2025 IU/L 0-32
Lipid Panel
Test Current Result and Flag Previous Result and Date Units Reference Interval
Cholesterol, Total 01 193 mg/dL 100-199
Triglycerides 01 67 mg/dL 0-149
HDL Cholesterol 01 74 mg/dL >39
VLDL Cholesterol Cal 11 mg/dL 5-40
LDL Chol Calc (NIH) 108 High mg/dL 0-99
______________________________________________________________________
: Risk Assessment and Treatment Goals-Adults 30-79 years[1] :
:____________________________________________________________________:
: : : :
: 10 Yr "Prevent" ASCVD : LDL-C Goals :non-HDL Goals:
: Risk Categories[2] : (mg/dL) : (mg/dL) :
:__________________________________:___________________:_____________:
: : : If LDL-C 160-189 : :
: Low Risk : 0-3% : treat to <100 : <130 :
:_____________________:____________:___________________:_____________:
: Borderline : 3%-<5% : <100 : <130 :
:_____________________:____________:___________________:_____________:
: Intermediate : 5%-<10% : <100 : <130 :
:_____________________:____________:___________________:_____________:
: High : >=10% : <70 : <100 :
:_____________________:____________:___________________:_____________:
: : : Without ASCVD : :
: : : <100 : <130 :
: Severe :LDL-C:>=190 :___________________:_____________:
:Hypercholesterolemia : mg/dL : with ASCVD : :
: : : <55 : <85 :
:__________________________________:___________________:_____________:
: [1]2026 Lipid Guidelines [2]ASCVD Risk Calculator URL: :
Date Created and Stored 11/03/26 1807 ET Final Report Page 2 of 5
©2026 Laboratory Corporation of America® Holdings
All Rights Reserved - Enterprise Report Version 2.00
This document contains private and confidential health information protected by state and federal law.
If you have received this document in error please call 800-631-5250

-- 2 of 5 --

Date Collected: 11/02/2026
Lipid Panel (Cont.)
:https://professional.heart.org/en/guidelines-and-statements/prevent-:
:calculator :
:____________________________________________________________________:
Hemoglobin A1c
Test Current Result and Flag Previous Result and Date Units Reference Interval
Hemoglobin A1c 01 4.7 Low 4.7 10/23/2025 % 4.8-5.6
Please Note: 01
Prediabetes: 5.7 - 6.4
Diabetes: >6.4
Glycemic control for adults with diabetes: <7.0
C-Reactive Protein, Cardiac
Test Current Result and Flag Previous Result and Date Units Reference Interval
C-Reactive Protein, Cardiac 01 0.89 mg/L 0.00-3.00
Relative Risk for Future Cardiovascular Event
Low <1.00
Average 1.00 - 3.00
High >3.00
Apolipoprotein B
Test Current Result and Flag Previous Result and Date Units Reference Interval
Apolipoprotein B 01 83 mg/dL <90
Desirable < 90
Borderline High 90 - 99
High 100 - 130
Very High >130
--------------------------------------------------
ASCVD RISK THERAPEUTIC TARGET
CATEGORY APO B (mg/dL)
Very High Risk <80 (if extreme risk <70)
High Risk <90
Moderate Risk <90
`;

/** Verbatim pdftotext -layout lines from the same report: the TSH panel and
 *  the first half of the CBC, with the wrapped rows TSH, T4 Free, RBC,
 *  Hematocrit, MCH and Platelets. Includes the A1c "Please Note" block and
 *  the lipid risk table, which must not become markers. */
const LAYOUT_FORM = `Patient Report
Date Collected: 11/02/2026                       Date Received: 11/02/2026           Date Reported: 11/03/2026                                            Fasting: Yes

TSH+T4F+T3Free
      Test                                              Current Result and Flag              Previous Result and Date                       Units               Reference Interval
      TSH    01
                                                        3.680                                 4.050               08/05/2025              uIU/mL                   0.450-4.500
      Triiodothyronine (T3), Free 01                      4.0                                   2.9               08/05/2025               pg/mL                      2.0-4.4
      T4,Free(Direct)         01
                                                         1.01                                  0.97               08/05/2025               ng/dL                    0.82-1.77

CBC With Differential/Platelet
      Test                                              Current Result and Flag              Previous Result and Date                       Units               Reference Interval
      WBC 01                                              5.8                                   5.4               10/23/2025             x10E3/uL                    3.4-10.8
      RBC    01
                                                         4.04                                  4.38               10/23/2025             x10E6/uL                   3.77-5.28
      Hemoglobin 01                                      13.1                                  14.1               10/23/2025                g/dL                    11.1-15.9
      Hematocrit         01
                                                         37.4                                  41.6               10/23/2025                  %                     34.0-46.6
      MCV 01                                              93                                    95                10/23/2025                  fL                       79-97
      MCH     01
                                                         32.4                                  32.2               10/23/2025                  pg                    26.6-33.0
      MCHC 01                                            35.0                                  33.9               10/23/2025                g/dL                    31.5-35.7
      RDW 01                                             11.4               Low                11.7               10/23/2025                  %                     11.7-15.4
      Platelets     01
                                                         188                                   191                10/23/2025             x10E3/uL                    150-450
      Neutrophils 01                                      58                                    57                10/23/2025                  %                     Not Estab.

Lipid Panel
      Test                                              Current Result and Flag              Previous Result and Date                       Units               Reference Interval
      Cholesterol, Total 01                              193                                                                               mg/dL                     100-199
      LDL Chol Calc (NIH)                                108                High                                                           mg/dL                       0-99
                                                 ______________________________________________________________________
                                                 :     Risk Assessment and Treatment Goals-Adults 30-79 years[1]       :
                                                 :     Low Risk        :    0-3%     :   treat to <100   :     <130    :
                                                 :        High         :    >=10%    :       <70         :    <100     :

Hemoglobin A1c
      Test                                                Current Result and Flag                Previous Result and Date                       Units               Reference Interval
      Hemoglobin A1c 01                                    4.7                Low                   4.7               10/23/2025                  %                       4.8-5.6
      Please Note:    01

                                                              Prediabetes: 5.7 - 6.4
                                                              Diabetes: >6.4
                                                              Glycemic control for adults with diabetes: <7.0

Apolipoprotein B
      Test                                                Current Result and Flag                Previous Result and Date                       Units               Reference Interval
      Apolipoprotein B      01
                                                           83                                                                                  mg/dL                        <90
                                                                                                 Desirable                < 90
                                                                                                 Borderline High      90 - 99
                                                                                                 Very High                >130
                                                                                High Risk             <90
                                                                                                        Date Created and Stored 11/03/26 1807 ET Final Report Page 3 of 5
`;

/** Sections 1-5 and 7: every row, previous column, Not Estab., meta,
 *  interpretation tables, matching and flagging — against one parse result. */
function checkFixture(parsed: ReturnType<typeof parseLabcorpText>, label: string) {
  // ----- 1. Every row of the fixture -----
  eq(parsed.markers.length, EXPECTED.length, `${label}: row count`);
  const byName = new Map(parsed.markers.map((m) => [m.rawName, m]));
  for (const [name, value, flag, unit, range, prevValue, prevDate] of EXPECTED) {
    const m = byName.get(name);
    ok(!!m, `${label}: "${name}" parsed`);
    if (!m) continue;
    eq(m.value, value, `${label} ${name}: current value`);
    eq(m.labFlagFromPdf, flag, `${label} ${name}: lab flag`);
    eq(m.unit, unit, `${label} ${name}: unit`);
    eq(m.referenceRangeRaw, range, `${label} ${name}: printed range`);
    eq(m.previousValue ?? null, prevValue, `${label} ${name}: previous value`);
    eq(m.previousDate ?? null, prevDate, `${label} ${name}: previous date`);
  }
  eq(parsed.markers[0]?.rawName, "Iron Bind.Cap.(TIBC)", `${label}: first row`);
  eq(parsed.markers[parsed.markers.length - 1]?.rawName, "Apolipoprotein B", `${label}: last row`);
  ok(!parsed.markers.some((m) => /^\d{2}$/.test(m.rawName.split(" ").pop() ?? "")), `${label}: no trailing lab code left on any name`);
  ok(parsed.markers.every((m) => typeof m.value === "number"), `${label}: every current value numeric`);

  // ----- 2. Previous column is captured but never the current value -----
  for (const [name, value, , , , prevValue] of EXPECTED) {
    if (prevValue === null || prevValue === value) continue;
    const m = byName.get(name);
    ok(m !== undefined && m.value !== prevValue, `${label} ${name}: current ${m?.value} is not the previous ${prevValue}`);
  }
  eq(byName.get("Ferritin")?.previousValue, 126, `${label} Ferritin: footnote asterisk stripped from previous value`);
  eq(byName.get("Cholesterol, Total")?.previousValue ?? null, null, `${label} Cholesterol: no previous column -> null`);

  // ----- 3. "Not Estab." -> no range; the lab's words become H/L -----
  const noRange = EXPECTED.filter((r) => r[4] === null).map((r) => r[0]);
  eq(noRange.length, 6, `${label}: six Not Estab. rows`);
  for (const name of noRange) eq(byName.get(name)?.referenceRangeRaw, null, `${label} ${name}: Not Estab. -> null range`);
  eq(parsed.markers.filter((m) => m.labFlagFromPdf === "H").length, 6, `${label}: six High flags`);
  eq(parsed.markers.filter((m) => m.labFlagFromPdf === "L").length, 3, `${label}: three Low flags`);

  // ----- 4. Patient meta: collection date, lab, nothing else -----
  eq(parsed.patientMeta.collectedDate, "11/02/2026", `${label} meta: Date Collected`);
  eq(parsed.patientMeta.reportedDate, "11/03/2026", `${label} meta: Date Reported`);
  eq(parsed.patientMeta.labSource, "Labcorp", `${label} meta: labSource`);
  eq(Object.keys(parsed.patientMeta).sort().join(","), "collectedDate,labSource,reportedDate", `${label} meta: no extra identifier fields`);

  // ----- 5. Nothing from the interpretation tables leaks in -----
  ok(!parsed.markers.some((m) => /Risk|Desirable|Prediabetes|Diabetes|Please Note|Glycemic/i.test(m.rawName)), `${label}: no interpretation-table rows`);
  ok(!parsed.markers.some((m) => m.rawName === "Creatinine" && m.value !== 1.04), `${label}: the Historical Results page adds no Creatinine row`);

  // ----- 7. Matching through the existing dictionary -----
  const matched = matchMarkers(parsed.markers);
  const unmatched = matched.filter((m) => m.matchStatus !== "matched").map((m) => m.rawName);
  eq(unmatched.sort().join(" | "), [...KNOWN_UNMATCHED].sort().join(" | "), `${label} matcher: only the known no-record markers are unmatched`);
  const canon = (name: string) => matched.find((m) => m.rawName === name)?.canonicalName;
  const expectCanon: Array<[string, string]> = [
    ["Iron Bind.Cap.(TIBC)", "TIBC (Total Iron Binding Capacity)"],
    ["Iron Saturation", "% Iron Saturation"],
    ["Triiodothyronine (T3), Free", "T3 Free"],
    ["T4,Free(Direct)", "T4 Free"],
    ["TSH", "sTSH (Serum Thyroid Stimulating Hormone)"],
    ["Lymphs", "Lymphocytes"],
    ["Eos", "Eosinophils"],
    ["Basos", "Basophils"],
    ["Neutrophils (Absolute)", "Absolute Neutrophils"],
    ["Lymphs (Absolute)", "Absolute Lymphocytes"],
    ["Monocytes(Absolute)", "Absolute Monocytes"],
    ["Eos (Absolute)", "Absolute Eosinophils"],
    ["Baso (Absolute)", "Absolute Basophils"],
    ["Carbon Dioxide, Total", "CO2 (Carbon Dioxide)"],
    ["LDL Chol Calc (NIH)", "LDL (Low Density Lipoprotein Cholesterol)"],
    ["C-Reactive Protein, Cardiac", "Hs-CRP"],
    ["Hemoglobin A1c", "Hemoglobin A1C"],
    ["Apolipoprotein B", "Apoliopoprotein B"],
    ["AST (SGOT)", "AST (Aspartate Aminotransferase)"],
    ["ALT (SGPT)", "ALT (Alanine Aminotransferase)"],
  ];
  for (const [raw, c] of expectCanon) eq(canon(raw), c, `${label} matcher: ${raw}`);
  eq(matched.filter((m) => m.canonicalName === "LDL (Low Density Lipoprotein Cholesterol)").length, 1, `${label} matcher: exactly one LDL row (VLDL does not fuzzy-match LDL)`);
  ok(matched.filter((m) => m.matchStatus === "matched").every((m) => m.matchConfidence !== "fuzzy"), `${label} matcher: no fixture marker relies on a fuzzy match`);

  // Printed ranges drive flagging.
  const flagged = flagMarkers(matched);
  const f = (name: string) => flagged.find((m) => m.rawName === name);
  eq(f("Iron")?.labRangeSource, "printed", `${label} flagging: Iron uses the printed 27-159`);
  eq(f("Iron")?.effectiveLabRange?.max, 159, `${label} flagging: Iron effective lab max is the printed 159`);
  ok(f("Iron")?.flagStatus !== "optimal" && f("Iron")?.flagStatus !== "not_flaggable", `${label} flagging: Iron 212 is flagged (got ${f("Iron")?.flagStatus})`);
  eq(f("Apolipoprotein B")?.effectiveLabRange?.max, 90, `${label} flagging: ApoB printed upper bound <90`);
  eq(f("Hemoglobin")?.effectiveLabRange?.min, 11.1, `${label} flagging: Hemoglobin uses the printed 11.1-15.9`);

  // ----- 9. Multi-PDF source tag -----
  const built = buildPanel(parsed, "diana.pdf", 0, "female");
  ok(!!built.panel, `${label} panel: builds a panel (no unreadable notice)`);
  if (built.panel) {
    eq(built.panel.source.lab, "Labcorp", `${label} panel: lab name`);
    eq(built.panel.source.collectedDate, "11/02/2026", `${label} panel: collection date`);
    eq(sourceTag(built.panel.source), "Labcorp · 11/02", `${label} panel: compact source tag`);
    const composite = mergePanels([built.panel]);
    eq(composite.sources[0]?.lab, "Labcorp", `${label} composite: source carries Labcorp`);
    ok(composite.markers.some((m) => m.rawName === "Iron" && m.value === 212), `${label} composite: Iron 212 survives the merge`);
  }
  return byName;
}

async function main() {
  // ----- The collapsed (pdf-parse) form, always -----
  const collapsed = parseLabcorpText(COLLAPSED_FORM);
  const byName = checkFixture(collapsed, "collapsed");
  eq(detectLabLayout(COLLAPSED_FORM), "labcorp", "dispatch: collapsed form is labcorp");
  eq(JSON.stringify(parseLabReportText(COLLAPSED_FORM).markers), JSON.stringify(collapsed.markers), "dispatch: parseLabReportText routes the collapsed form to the Labcorp parser");

  // ----- Row grammar negatives -----
  for (const line of [
    "Desirable < 90",
    "Borderline High 90 - 99",
    "Very High >130",
    "High Risk <90",
    "Moderate Risk <90",
    "Low <1.00",
    "Average 1.00 - 3.00",
    "High >3.00",
    "Prediabetes: 5.7 - 6.4",
    "Diabetes: >6.4",
    "Glycemic control for adults with diabetes: <7.0",
    "Ref. Interval 100-199 0-149 >39",
    "11/02/2026† 193 67 74",
    "Reference Interval: 0.57-1.00 mg/dL",
    "* Previous Reference Interval: (Ferritin: 15-150 ng/mL)",
    "Please Note: 01",
    ": High : >=10% : <70 : <100 :",
  ]) {
    eq(parseLabcorpRow(line), null, `not a row: "${line}"`);
  }

  // ----- 6. Wrapped rows (pdftotext -layout form) -----
  const layout = parseLabcorpText(LAYOUT_FORM);
  const lb = new Map(layout.markers.map((m) => [m.rawName, m]));
  const wrapped: Array<[string, number, string, string, number]> = [
    ["TSH", 3.68, "uIU/mL", "0.450-4.500", 4.05],
    ["T4,Free(Direct)", 1.01, "ng/dL", "0.82-1.77", 0.97],
    ["RBC", 4.04, "x10E6/uL", "3.77-5.28", 4.38],
    ["Hematocrit", 37.4, "%", "34.0-46.6", 41.6],
    ["MCH", 32.4, "pg", "26.6-33.0", 32.2],
    ["Platelets", 188, "x10E3/uL", "150-450", 191],
    ["Apolipoprotein B", 83, "mg/dL", "<90", NaN],
  ];
  for (const [name, value, unit, range, prev] of wrapped) {
    const m = lb.get(name);
    ok(!!m, `layout: wrapped "${name}" joined with its value line`);
    if (!m) continue;
    eq(m.value, value, `layout ${name}: value`);
    eq(m.unit, unit, `layout ${name}: unit`);
    eq(m.referenceRangeRaw, range, `layout ${name}: range`);
    if (!Number.isNaN(prev)) eq(m.previousValue, prev, `layout ${name}: previous`);
  }
  eq(layout.markers.length, 17, `layout: 17 rows (got ${layout.markers.map((m) => m.rawName).join(" | ")})`);
  eq(lb.get("RDW")?.labFlagFromPdf, "L", "layout: unwrapped row flag still read");
  eq(lb.get("LDL Chol Calc (NIH)")?.labFlagFromPdf, "H", "layout: flag with no previous column");
  eq(lb.get("Neutrophils")?.referenceRangeRaw, null, "layout: Not Estab. with aligned columns");
  ok(!layout.markers.some((m) => /Please Note|Prediabetes/i.test(m.rawName)), "layout: 'Please Note: 01' is not joined with the note below it");
  eq(layout.patientMeta.collectedDate, "11/02/2026", "layout: Date Collected");
  ok(looksLikeLabcorpReport(LAYOUT_FORM) && detectLabLayout(LAYOUT_FORM) === "labcorp", "dispatch: layout form is labcorp");
  for (const m of layout.markers) {
    const other = byName.get(m.rawName);
    ok(!!other && other.value === m.value && other.referenceRangeRaw === m.referenceRangeRaw && other.unit === m.unit, `both forms agree on ${m.rawName}`);
  }

  // ----- 8. Dispatcher -----
  eq(detectLabLayout("Hello world\nSome receipt\n"), "unknown", "dispatch: plain text is unknown");
  eq(detectLabLayout("Patient Report\nTest Current Result and Flag Previous Result and Date Units Reference Interval\nQuest Diagnostics"), "labcorp", "dispatch: the Labcorp column header outranks a stray Quest mention");
  eq(detectLabLayout("Quest Diagnostics\nGLUCOSE 95 mg/dL 65-99\n"), "quest", "dispatch: Quest fingerprint");
  eq(detectLabLayout("Health Gorilla\nSource: Quest\n"), "quest", "dispatch: Function / Health Gorilla distribution is quest");
  const unknownText = "Nothing to see here\nGLUCOSE 95 mg/dL 65-99\n";
  eq(JSON.stringify(parseLabReportText(unknownText)), JSON.stringify(parseQuestText(unknownText)), "dispatch: unknown layout = Quest parser output");

  // ----- The real PDFs, when present (samples/ is gitignored) -----
  if (fs.existsSync(FIXTURE)) {
    const buf = fs.readFileSync(FIXTURE);
    const text = await extractPdfText(buf);
    checkFixture(parseLabcorpText(text), "pdf");
    eq(detectLabLayout(text), "labcorp", "dispatch: fixture PDF is labcorp");
    const viaDispatch = await parseLabReport(buf);
    eq(viaDispatch.patientMeta.labSource, "Labcorp", "dispatch: parseLabReport routes the fixture to the Labcorp parser");
    eq(viaDispatch.markers.length, EXPECTED.length, "dispatch: same row count as the direct parser");
  } else {
    console.log("labcorp-parser: SKIPPED the PDF fixture (samples/labcorp/ not present on this machine)");
  }
  if (QUEST_SAMPLES.length) {
    eq(QUEST_SAMPLES.length, 6, "dispatch: six Quest samples present");
    for (const p of QUEST_SAMPLES) {
      const qb = fs.readFileSync(p);
      const qt = await extractPdfText(qb);
      eq(detectLabLayout(qt), "quest", `dispatch: ${path.basename(p)} is quest`);
      const direct = JSON.stringify(await parseQuestPdf(qb));
      const routed = JSON.stringify(await parseLabReport(qb));
      ok(direct === routed, `dispatch: ${path.basename(p)} byte-identical to parseQuestPdf`);
    }
  } else {
    console.log("labcorp-parser: SKIPPED the six Quest samples (samples/ not present on this machine)");
  }

  if (failures.length) {
    console.error(`labcorp-parser: ${failures.length} assertion(s) failed`);
    for (const x of failures) console.error(x);
    process.exit(1);
  }
  console.log(`labcorp-parser: all ${passed} assertions passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
