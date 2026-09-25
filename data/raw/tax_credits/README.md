# Tax credit sources

Inputs to `scripts/build_tax_credits.py`, which writes
`data/processed/tax_credits/hawaii_*_tax_credits_2023.csv`. Retrieved
2026-09-24, when SOI had published county data through 2023 but ZIP code
data only through 2022.

| File | What it is | Source |
|---|---|---|
| `23incyallnoagi_hi.csv` | The Hawaii rows (state total and four counties) of IRS SOI county data, tax year 2023, all columns | <https://www.irs.gov/pub/irs-soi/23incyallnoagi.csv> ([county data](https://www.irs.gov/statistics/soi-tax-stats-county-data)) |
| `22zp12hi.xlsx` | IRS SOI ZIP code data, Hawaii, tax year 2022, as published | <https://www.irs.gov/pub/irs-soi/22zp12hi.xlsx> ([ZIP code data](https://www.irs.gov/statistics/soi-tax-stats-individual-income-tax-statistics-zip-code-data-soi)) |
| `22incyallnoagi_hi.csv` | The Hawaii rows of IRS SOI county data, tax year 2022, all columns; checks the ZIP code allocation | <https://www.irs.gov/pub/irs-soi/22incyallnoagi.csv> |
| `act107_earnedincome_txcredit_2023_tables.xlsx` | Hawaii Department of Taxation, Earned Income Tax Credit Report, tax year 2023: state EITC claims and amounts; checks the state EITC estimate | <https://files.hawaii.gov/tax/stats/stats/act107_2017/archive/act107_earnedincome_txcredit_2023_tables.xlsx> ([EITC reports](https://tax.hawaii.gov/stats/a5_1annual/a5_3ei_credit/)) |

The `_hi.csv` files are the header plus the lines whose STATEFIPS is 15, byte
for byte. The script also uses the ZIP-to-district and ZIP-to-county
crosswalks in `data/raw/crosswalks/`.

In SOI's ZIP data, ZIP codes with few returns and nonresidential ones (such as
PO boxes) are combined as ZIP 99999, "other". The build script spreads that
row over the ZIP code areas that have no row of their own.

The Department of Taxation's report counts state EITC claims by tax district
(county) too, but those counts include earlier years' nonrefundable credits
carried forward, and it assigns returns with out-of-state addresses to Oʻahu,
so the script checks only the statewide average of new claims.
