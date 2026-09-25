# Tax credit sources

Inputs to `scripts/build_tax_credits.py`, which writes
`data/processed/tax_credits/hawaii_*_tax_credits_2022.csv`. Retrieved
2026-09-24.

| File | What it is | Source |
|---|---|---|
| `22zp12hi.xlsx` | IRS SOI ZIP code data, Hawaii, tax year 2022, as published | <https://www.irs.gov/pub/irs-soi/22zp12hi.xlsx> ([ZIP code data](https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-statistics-zip-code-data-soi)) |
| `22incyallnoagi_hi.csv` | The Hawaii rows (state total and four counties) of IRS SOI county data, tax year 2022, all columns | <https://www.irs.gov/pub/irs-soi/22incyallnoagi.csv> ([county data](https://www.irs.gov/statistics/soi-tax-stats-county-data)) |

The script also uses the ZIP-to-district and ZIP-to-county crosswalks in
`data/raw/crosswalks/`.

In SOI's ZIP data, ZIP codes with few returns and nonresidential ones (such as
PO boxes) are combined as ZIP 99999, "other". The build script spreads that
row over the ZIP code areas that have no row of their own.
