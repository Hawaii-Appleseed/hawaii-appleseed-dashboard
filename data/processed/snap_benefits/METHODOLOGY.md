# SNAP data methodology

How the SNAP CSVs in this folder are built, and how to roll them forward each
year.

## The problem

The American Community Survey (ACS) systematically **underreports** SNAP
participation. Hawaii Appleseed staff confirmed this in
`ACS_SNAP households by legislative district (2023).xlsx` — comparing ACS
SNAP households against USDA administrative counts, ACS misses roughly half of
participants. Using ACS directly understates need at every geographic level.

USDA publishes authoritative SNAP household counts and total issuance dollars
**by county** in a bi-annual report ("State Project Area / County Level
Participation and Issuance Data"). USDA does NOT publish data below the county
level, so we still need ACS to allocate the corrected county totals to
legislative districts.

## The fix: Ratio Leg:Island

For every legislative district we compute a **Ratio Leg:Island** (the column-K
formula in the 2023 Excel):

```
K = district_ACS_snap_HH / sum(ACS_snap_HH for all districts in same county)
```

K is the district's proportional share of its county's ACS-reported SNAP
households. We then scale the authoritative USDA county count by K:

```
snap_households_adjusted = USDA_county_snap_HH × K          # Excel column L
```

This preserves the USDA county totals (authoritative) while distributing them
across districts using ACS's district-level signal (the only signal we have at
sub-county resolution). Within each county, the per-district `snap_households_adjusted`
values sum exactly back to the USDA county total — see the run-time diagnostic
that the backfill script prints at the end.

## Per-HH benefit: HH-size weighting

USDA only reports SNAP issuance dollars at the county level. If we redistributed
them with the same Leg:Island ratio K, the per-HH amount would collapse to a
single county constant — every district within a county would show the same
average benefit. To restore plausible district-level variation we weight each
district's per-HH benefit by **average household size** (ACS `B25010_001E`),
since the federal SNAP allotment scales roughly linearly with HH size (the
2024 max for a 1-person HH is $291/mo, for 4-person it's $973/mo).

For each district within a county:

```
S          = Σ_d (size_d × K_d)                       # K-weighted county avg size
size_factor = size_d / S                              # district's deviation from county
monthly    = (USDA_county_issuance / USDA_county_HH) × size_factor
```

Calibrated so the K-weighted sum of district per-HH benefits equals the county
per-HH benefit. By construction, `Σ_d (adj_HH_d × monthly_d × 12)` exactly
equals the USDA county annual issuance — see the run-time diagnostic.

Caveats:
* B25010 reports avg HH size for *all* households, not specifically SNAP
  recipients. SNAP HHs differ in size from the population average, but the
  *relative* differences between districts within a county track reasonably.
* This is a model output, not a measurement. For tight per-district benefit
  comparisons, prefer `snap_household_rate` (rate-of-receipt, which uses ACS
  district HH directly) or `snap_benefits_annual_total` (county totals
  redistributed by HH share).

## Worked example (2024)

Senate District 1 is in Hawaii County.

| Quantity | Value | Source |
|---|---:|---|
| District ACS SNAP HH | 3,992 | Census API, B22001_002E |
| Sum of ACS SNAP HH for all 4 Hawaii-County senate districts (D1–D4) | 13,197 | Census API |
| Ratio Leg:Island K | 0.30249 | 3,992 / 13,197 |
| USDA Hawaii County SNAP HH | 21,612 | JUL 2024 bi-annual file |
| **snap_households_adjusted** | **6,537** | 21,612 × 0.30249 |
| District total HH | 19,872 | Census API, B22001_001E |
| **snap_household_rate** | **0.329** | 6,537 / 19,872 |
| District avg HH size | 2.81 | Census API, B25010_001E |
| K-weighted county avg HH size S | ~2.71 | Σ_d (size_d × K_d) within Hawaii County |
| size_factor | 1.035 | 2.81 / 2.71 |
| USDA Hawaii County monthly issuance | $15,789,331 | JUL 2024 |
| County avg monthly per HH | $730.58 | $15,789,331 / 21,612 |
| District monthly per HH | $755.92 | $730.58 × 1.035 |
| **snap_benefit_annual_per_household** | **$9,071.07** | $755.92 × 12 |
| **snap_benefits_annual_total** | **$59,289,489** | 6,537 × $755.92 × 12 |

## Per-level formulas

### State

```
snap_households_adjusted     = sum(USDA_county_snap_HH)                   # 83,772 in 2024
snap_household_rate          = snap_households_adjusted / state_ACS_total_HH
snap_benefit_monthly_per_HH  = sum(USDA_county_issuance) / sum(USDA_county_snap_HH)
snap_benefit_annual_per_HH   = snap_benefit_monthly_per_HH × 12
snap_benefits_annual_total   = sum(USDA_county_issuance) × 12
```

### County

```
snap_households_adjusted     = USDA_county_snap_HH                         # direct
snap_household_rate          = USDA_county_snap_HH / ACS_county_total_HH
snap_benefit_monthly_per_HH  = USDA_county_issuance / USDA_county_snap_HH
snap_benefits_annual_total   = USDA_county_issuance × 12
```

### House / Senate district

```
K                            = district_ACS_snap_HH / county_ACS_snap_HH_sum
snap_households_adjusted     = USDA_county_snap_HH × K
snap_household_rate          = snap_households_adjusted / district_total_HH
S                            = Σ_d (size_d × K_d)                          # county K-weighted avg HH size
size_factor                  = district_avg_HH_size / S
snap_benefit_monthly_per_HH  = (USDA_county_issuance / USDA_county_snap_HH) × size_factor
snap_benefit_annual_per_HH   = monthly × 12
snap_benefits_annual_total   = snap_households_adjusted × annual
```

## Inputs

1. **ACS 5-year via Census API**:
   * Table B22001 ("Receipt of food stamps/SNAP in past 12 months")
     * `B22001_001E` = total households (universe)
     * `B22001_002E` = households that received SNAP
   * Table B25010 ("Average household size of occupied housing units")
     * `B25010_001E` = avg HH size — used to vary district per-HH benefit

   Pulled for state / county / state legislative district lower chamber /
   state legislative district upper chamber, all `state:15`. No API key
   needed for these small queries.

2. **USDA bi-annual State Project Area / County Level Participation and
   Issuance Data**, July 2024 vintage.
   File on disk: `~/Downloads/snap-zip-fns388a-2/JUL 2024.xlsx` (single sheet
   named "Page"). Hawaii rows live around row 360, identified by the
   substring `HI EBT` in column 1.
   * Column 12: `Calc: SNAP Total PA and Non-PA Households`
   * Column 14: `SNAP All Total Actual PA & Non-PA Issuance` (one month, $)

   Bulk download:
   <https://www.fns.usda.gov/research/snap/state-project-area-county-level-participation-data>

3. **District → county crosswalk** — read at runtime from
   `web/public/data/{senate,house}.geojson`. Each feature already has a
   `county` property. The GeoJSON labels Honolulu County as `OAHU`, so the
   script translates `OAHU → HONOLULU` to match the USDA file.

   2024 county breakdown:

   | Chamber | HAWAII | HONOLULU | KAUAI | MAUI |
   |---|---:|---:|---:|---:|
   | Senate (25) | 4 (D1–4) | 17 (D9–25) | 1 (D8) | 3 (D5–7) |
   | House (51)  | 8 (D1–8) | 34 (D18–51) | 3 (D15–17) | 6 (D9–14) |

## County FIPS / "HI EBT …" crosswalk

| GeoJSON `county` | USDA Excel label | County name | FIPS |
|---|---|---|---:|
| HAWAII | `HI EBT HAWAII` | Hawaii | 15001 |
| OAHU | `HI EBT HONOLULU` | Honolulu | 15003 |
| (none) | (none) | Kalawao | 15005 |
| KAUAI | `HI EBT KAUAI` | Kauai | 15007 |
| MAUI | `HI EBT MAUI` | Maui | 15009 |

Kalawao County (1 settlement on Molokai, ~80 residents) has no separate USDA
row and is rolled into Maui in the GeoJSON.

## Outputs

Four CSVs in this folder (`data/processed/snap_benefits/`):

* `hawaii_state_snap_2024.csv` — 1 row
* `hawaii_county_snap_2024.csv` — 4 rows
* `hawaii_house_district_snap_2024.csv` — 51 rows
* `hawaii_senate_district_snap_2024.csv` — 25 rows

`total_households` and `snap_households` (raw ACS counts) live in the four
companion files in `data/processed/hawaii_*_acs_2024.csv`. They are NOT
duplicated in the SNAP CSVs — `pandas.merge` would suffix them with `_x`/`_y`
and break downstream lookups in `data_loader.py`.

## How to update next year (2025 → 2026 → …)

1. Drop the new bi-annual file in `~/Downloads/snap-zip-fns388a-2/`. Either
   `JUL <year>.xlsx` or `JAN <year>.xlsx` works — pick whichever vintage
   matches your reporting window. Update the `USDA_FILE` constant in
   `scripts/backfill_snap_2024.py` (or copy the script and bump the year).
2. Update `YEAR = 2024` in the script.
3. Confirm the existing `data/processed/hawaii_*_acs_<year>.csv` files exist
   for the new year (the ACS pipeline must have run first; see commit
   `80f1538`'s diff for what the ACS bump looks like).
4. Run `python scripts/backfill_snap_2024.py`. Verify the diagnostic at the
   end shows `delta=±0.0` for every county.
5. Bump `sources.snap.year` in `src/config/data_sources.json`.
6. Bump the three `"USDA SNAP Data <year>"` source labels in
   `src/config/variables.json` (the web app's copy is built from it), then run
   `npm run check` in `web/`.
7. Run `python scripts/build_static/02_build_layer_geojsons.py` to refresh
   `web/public/data/{state,county,house,senate}.geojson`.
8. Smoke test: `streamlit run run_leaflet.py`, switch the dropdown to each of
   the three SNAP variables at each of the four geographies, confirm tooltips
   show the new year and reasonable values.

## Why the 2023 CSVs in the repo don't quite match this methodology

If you compute `snap_households_adjusted / snap_households` for every senate
district in `hawaii_senate_district_snap_2023.csv`, you get the same number
(~1.7273) for all 25 districts — meaning the 2023 file applied a single
**state-wide** scale factor instead of per-county Leg:Island ratios. That's a
discrepancy from the Excel methodology; the 2024 build (this script) applies
the ratio per county as the Excel intends.
