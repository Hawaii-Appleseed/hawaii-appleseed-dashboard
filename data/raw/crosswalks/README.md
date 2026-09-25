# ZIP code crosswalks

Used by `scripts/build_tax_credits.py` and `scripts/build_alice.py` to turn
ZIP-code data into House and Senate district figures. Retrieved 2026-09-24
from [Geocorr 2022](https://mcdc.missouri.edu/applications/geocorr2022.html)
(Missouri Census Data Center).

| File | What it is |
|---|---|
| `geocorr2022_zcta_to_sldl22.csv` | Share of each ZIP code tabulation area's 2020 population in each 2022 State House district |
| `geocorr2022_zcta_to_sldu22.csv` | The same for 2022 State Senate districts |
| `geocorr2022_zcta_to_county.csv` | The same for counties |

Made with: state Hawaii; source geography ZIP/ZCTA; target geography "State
legislative district — lower" or "— upper" (2022), or County; weighting
variable Total population (2020 Census); CSV output. The `afact` column is the
share of the ZIP area's population in the target area. Rows with an empty
ZCTA are census blocks outside any ZIP code area.

Hawaii's 2022 district lines are in force through the 2030 elections;
re-download these if they change.
