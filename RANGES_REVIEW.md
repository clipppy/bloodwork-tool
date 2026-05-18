# Bloodwork Tool — Ranges Pending Confirmation

This is everything I need you to look at before the tool can start flagging
patient results. The 53 markers we audited against your chart are locked in
and **not** listed here — they're already trusted. This doc only covers
what needs your input.

The tool will **refuse to flag** any marker listed in section 1 below
until you give me ranges to use.

---

## 1. Markers with no ranges — please supply

For each of these I added an entry to the library so the parser can
recognize the marker, but I left the ranges intentionally empty. The
tool's flagging engine will treat these as "do not flag" until you fill
them in. I'd rather have the tool be silent than guess at clinical
ranges that aren't yours.

### ANA (Anti-nuclear Antibodies)
- **Currently:** no range, will not flag.
- **My note in the file:** ANA is usually reported as a titer (e.g. 1:40,
  1:80, 1:160) plus a pattern (homogeneous, speckled, nucleolar, etc.) —
  it's not really a numeric value. Quest's standard reference is negative
  below 1:80.
- **Please tell me:**
  1. Do you want this tracked as numeric (titer dilution) or categorical (negative/positive)?
  2. What titer threshold do you flag as abnormal?
  3. Should we track the pattern in a separate field?

### Uric Acid
- **Currently:** no range, will not flag.
- **Standard Quest reference:** 4.0-8.0 mg/dL (men), 2.5-7.1 mg/dL (women).
- **Functional medicine often uses tighter ranges** (commonly cited around
  3.5-5.5 mg/dL), but I'd rather use yours than guess.
- **Please tell me:** the lab range and optimal range you use, plus the
  source you pull them from (so I can document it in the tool).

### Cortisol
- **Currently:** no range, will not flag.
- **The hard part:** cortisol ranges depend on how the sample was collected:
  - Serum AM vs Serum PM
  - Salivary diurnal (typically a 4-point curve)
  - 24-hour urine free cortisol
  Each has its own reference interval and "optimal" depends on context.
- **Please tell me:**
  1. Which collection methods do you want this tool to accept?
  2. The ranges you use for each, plus the source.

### Estrogens
- **Currently:** no range, will not flag.
- **The hard part:** "Estrogens" in your chart is generic, but labs report
  Estradiol (E2), Estrone (E1), and Estriol (E3) separately. Ranges vary
  by sex, menstrual cycle phase, menopausal status, and HRT.
- **Please tell me:**
  1. One combined "Estrogens" marker or three separate markers (E1/E2/E3)?
  2. The ranges you use, with sex and cycle-phase or menopause status if applicable.

---

## 2. Food sensitivity panel — pending full list

The sample Quest report I built against shows 6 foods (Casein, Cacao,
Corn, Egg White, Wheat, Yeast) all using `<2` as the lab threshold. I've
flagged these 6 as `panelType: "food_sensitivity"` so the parser knows
they're part of a variable panel.

For the actual tool I need your full panel list — every food you typically
test for — plus confirmation that `<2` is the threshold you use across all
of them, or if it varies. Once you supply the list, the parser will handle
any food on it generically rather than needing each food pre-coded.

---

## 3. Cardiac panel — 3-zone flagging (please verify)

I read the 10 cardiac markers off your master chart and wired them up
with Optimal / Moderate / High bands. Please skim and confirm the bands
match what you have:

| Marker            | Optimal      | Moderate         | High         |
| ----------------- | ------------ | ---------------- | ------------ |
| LDL Particle      | <1138        | 1138-1409        | >1409        |
| LDL Small         | <142         | 142-219          | >219         |
| LDL Medium        | <215         | 215-301          | >301         |
| HDL Large         | >6729        | 5353-6729        | <5353 (worse) |
| LDL Pattern       | A            | —                | B (worse)    |
| LDL Peak Size     | >222.9       | 217.4-222.9      | <217.4 (worse) |
| Apolipoprotein B  | <90          | 90-119           | >=120        |
| Lipoprotein (a)   | <75          | 75-125           | >125         |
| Hs-CRP            | <1.0         | 1.0-3.0          | >3.0         |
| Lp-PLA2 Activity  | <=123        | —                | >123         |

Quick clinical question: your chart shows Apolipoprotein B Moderate
ending at 119 and High starting at 120. If a patient's value comes back
exactly at 119.5, should the tool flag it as Moderate or High? (Right
now I flag boundary values as the more serious category.)

Note: the chart canonical name `Apoliopoprotein B` has the original typo
preserved (your chart spelling); `Apolipoprotein B` and `ApoB` are both
aliases so it will match whatever the lab reports.

---

## 4. EBV antibody panel — verify Quest cutoffs

I used Quest's reference cutoffs (read directly off the Valles, Gina
sample report) for the 4 EBV antibodies. Please confirm these match your
expectations:

| Marker                | Negative | Equivocal     | Positive |
| --------------------- | -------- | ------------- | -------- |
| EBV Early Antigen IgG | <9.0     | 9.0-10.99     | >10.99   |
| EBV VCA IgM           | <36.0    | 36.0-43.99    | >43.99   |
| EBV VCA IgG           | <18.0    | 18.0-21.99    | >21.99   |
| EBV EBNA IgG          | <18.0    | 18.0-21.99    | >21.99   |

These are objective lab cutoffs, not interpretive ranges. One question
on flagging behavior:

- Should the tool flag any Equivocal or Positive result as abnormal, or
  only Positive? (Right now anything in the Equivocal band shows as
  "borderline" and only Positive shows as "abnormal.")

---

## 5. Markers omitted (intentionally)

### MTHFR Mutation
Your chart has a section on MTHFR but it's a genetic variant report, not a
numeric lab marker. I did not add it to the numeric ranges library.

**Tell me if** you want MTHFR tracked as a categorical marker (genotype +
status). Otherwise I'll leave it out and the tool will skip MTHFR rows on
the lab report.

---

## 6. Cause-array bleed audit (informational — no action needed)

While generating the library from your chart, my parser accidentally
swept up two stray section-heading strings into the Vitamin D entry's
"causes of decrease" list. I removed them in this cleanup pass:

- ~~`ANA (Anti-nuclear Antibodies)`~~  (section header, not a cause)
- ~~`Thyroid`~~  (section header, not a cause)

The legitimate last cause is still "Inflammation". I audited the other 4
markers that sit next to chart sections without their own Result line
(Homocysteine, Vitamin B6, Candida Albicans) and they all came out clean.

---

## 7. How the tool will use this

For your peace of mind:

- Every marker you confirmed (the 53 from your chart that I didn't list
  here) is already trusted by the tool.
- Every marker in section 1 above carries a `requiresConfirmation: true`
  flag. The flagging engine — which I'll build next — will literally
  refuse to flag those markers as abnormal until you supply ranges. They
  will appear in the parsed output, but with no clinical interpretation.
- There's a small validation script (`npm run validate:ranges`) that
  catches structural problems in the library (missing fields, overlapping
  bands, etc.) so we don't drift over time.

---

## Quick checklist for you

When you have 15 minutes:

- [ ] Section 1: tell me how to handle ANA, Uric Acid, Cortisol, Estrogens
- [ ] Section 2: send me your full food sensitivity panel list and confirm the `<2` threshold
- [ ] Section 3: glance at the cardiac band table, confirm or correct
- [ ] Section 4: glance at the EBV cutoffs, confirm or correct
- [ ] Section 5: yes/no on MTHFR
