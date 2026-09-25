"""
ACS Data Pipeline for Hawaii Appleseed Dashboard
Uses direct Census API calls to fetch ACS data
"""
import os
import pandas as pd
try:
    import geopandas as gpd  # optional; only needed for geometry-enabled exports
except ImportError:
    gpd = None
import logging
import requests
import json
import time
from typing import List, Dict, Optional, Union
from .geoid_utils import GeoIDStandardizer
from pathlib import Path
import numpy as np
import warnings
import traceback
from urllib.parse import urlencode, quote

warnings.filterwarnings('ignore', category=UserWarning)

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class ACSDataFetcher:
    """Fetches ACS data from the Census API directly."""
    
    def __init__(self, api_key: str = None, year: int = 2023):
        """Initialize the ACS data fetcher.
        
        Args:
            api_key: Census API key
            year: ACS year (default: 2023)
        """
        # Set up API URL and year
        self.year = year
        self.base_url = f"https://api.census.gov/data/{self.year}/acs/acs5"
        
        # Set up directories
        self.base_dir = Path(__file__).parent.parent
        self.data_dir = self.base_dir.parent / 'data'
        self.processed_dir = self.data_dir / 'processed'
        self.processed_dir.mkdir(parents=True, exist_ok=True)
        
        # Create a debug log file
        self.logs_dir = Path("logs")
        self.logs_dir.mkdir(exist_ok=True, parents=True)
        self.debug_log_file = self.logs_dir / "census_api_debug.log"
        
        # Log initialization
        with open(self.debug_log_file, 'a', encoding='utf-8') as f:
            f.write(f"\n--- Initializing ACSDataFetcher for {self.year} ACS 5-year estimates ---\n")
            f.write(f"Base URL: {self.base_url}\n")
        
        # Set and validate the API key
        self.api_key = api_key or "2104852dd7bfd83fbc9e320d650eb57decc11817"  # Using provided key or default
        self.api_key = self._validate_api_key(self.api_key)
        
        # Test the connection
        self._test_connection()
        
        # Log initialization
        with open(self.debug_log_file, 'a', encoding='utf-8') as f:
            f.write(f"\n--- Initializing ACSDataFetcher for {self.year} ACS 5-year estimates ---\n")
            f.write(f"Base URL: {self.base_url}\n")
        
        # Test the connection
        self._test_connection()
    
    def _validate_api_key(self, api_key: str) -> str:
        """Validate and format the Census API key.
        
        Args:
            api_key: The API key to validate
            
        Returns:
            The validated and formatted API key
            
        Raises:
            ValueError: If the API key is invalid
        """
        # Remove any whitespace
        api_key = api_key.strip()
        
        # Check if the API key is empty
        if not api_key:
            raise ValueError("Census API key cannot be empty")
            
        # Log that we're using a valid API key (without showing the key)
        logger.info(f"Using Census API key: {api_key[:4]}...{api_key[-4:] if len(api_key) > 8 else ''}")
        
        return api_key
    
    def _test_connection(self) -> None:
        """Test the connection to the Census API.
        
        Raises:
            ConnectionError: If the connection cannot be established
        """
        try:
            # Make a simple request to test the API key
            params = {
                'get': 'NAME',
                'for': 'state:*',
                'key': self.api_key
            }
            response = requests.get(self.base_url, params=params)
            response.raise_for_status()
            
            # Parse the response to ensure it's valid
            data = response.json()
            
            # Log successful connection
            logger.info(f"Successfully connected to ACS {self.year} 5-year estimates API")
            logger.info(f"Found {len(data)-1} states in the response")  # -1 for header row
            
            # Log the response to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write("Test connection successful\n")
                f.write(f"Found {len(data)-1} states in the response\n")
                f.write(f"First state: {data[1] if len(data) > 1 else 'No data'}\n")
                
        except Exception as e:
            error_msg = f"Failed to connect to Census API: {str(e)}"
            logger.error(error_msg)
            
            # Log the error to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Connection error: {error_msg}\n")
                
            raise ConnectionError(error_msg) from e
    
    # The Census API caps each request at 50 variables (including NAME). Keep a
    # safety margin so NAME + geography predicates always fit.
    _MAX_VARS_PER_REQUEST = 45

    def get_acs_data(
        self,
        variables: List[str],
        level: str = 'tract',
        state: str = '15',
        county: str = None,
        geometry: bool = False,
        standardize_geoids: bool = True
    ) -> pd.DataFrame:
        """Fetch ACS data, transparently batching requests past the API's 50-var cap.

        Splits ``variables`` into chunks of at most ``_MAX_VARS_PER_REQUEST``,
        fetches each chunk, merges the raw results on the standardized ``geoid``,
        then computes derived metrics once over the combined frame.
        """
        if len(variables) <= self._MAX_VARS_PER_REQUEST:
            return self._get_acs_data_single(
                variables, level, state, county, geometry, standardize_geoids
            )

        chunks = [
            variables[i:i + self._MAX_VARS_PER_REQUEST]
            for i in range(0, len(variables), self._MAX_VARS_PER_REQUEST)
        ]
        merged = None
        for chunk in chunks:
            part = self._get_acs_data_single(
                chunk, level, state, county, geometry,
                standardize_geoids, derive=False,
            )
            if part is None or part.empty:
                continue
            if merged is None:
                merged = part
            elif 'geoid' in merged.columns and 'geoid' in part.columns:
                new_cols = ['geoid'] + [c for c in part.columns if c not in merged.columns]
                merged = merged.merge(part[new_cols], on='geoid', how='outer')
            else:
                # Fallback: positional concat of the new columns only.
                new_cols = [c for c in part.columns if c not in merged.columns]
                merged = pd.concat([merged, part[new_cols]], axis=1)

        if merged is None:
            return pd.DataFrame()
        return self.calculate_poverty_rate(merged)

    def _get_acs_data_single(
        self,
        variables: List[str],
        level: str = 'tract',
        state: str = '15',
        county: str = None,
        geometry: bool = False,
        standardize_geoids: bool = True,
        derive: bool = True,
    ) -> pd.DataFrame:
        """Fetch ACS data for specified variables using the Census API directly.

        Args:
            variables: List of ACS variable codes
            level: Geographic level ('tract', 'block group', 'county', 'state_lower', 'state_upper')
            state: State FIPS code (default: '15' for Hawaii)
            county: County FIPS code (required for tract and block group levels)
            geometry: Whether to include geometry in the output (not supported in direct API)
            standardize_geoids: Whether to standardize GEOIDs to match existing map files
            derive: Whether to compute derived metrics (set False when batching; the
                caller derives once over the merged frame)

        Returns:
            DataFrame with the requested ACS data

        Raises:
            ValueError: If required parameters are missing or invalid
            ConnectionError: If there's an error connecting to the Census API
        """
        try:
            # Ensure state is a 2-digit string
            state = str(state).zfill(2)
            
            # Map our level names to Census API geography names
            level_map = {
                'state': 'state',
                'tract': 'tract',
                'block group': 'block group',
                'county': 'county',
                'state_lower': 'state legislative district (lower chamber)',
                'state_upper': 'state legislative district (upper chamber)'
            }

            if level not in level_map:
                raise ValueError(f"Unsupported level: {level}. Must be one of {list(level_map.keys())}")
            
            # Start building the API request
            get_params = ['NAME'] + variables
            get_str = ','.join(get_params)
            
            # Build the URL parameters based on level
            params = {
                'get': get_str,
                'key': self.api_key
            }
            
            if level == 'state':
                # For state level — single-row query for the specified state
                params['for'] = f"state:{state}"

            elif level == 'county':
                # For county level
                if county:
                    # If specific county is requested
                    params['for'] = f"county:{county}"
                else:
                    params['for'] = "county:*"
                params['in'] = f"state:{state}"

            elif level == 'tract':
                # For tract level
                params['for'] = "tract:*"
                if county:
                    params['in'] = f"state:{state} county:{county}"
                else:
                    params['in'] = f"state:{state}"
            
            elif level == 'block group':
                # For block group level
                params['for'] = "block group:*"
                if county:
                    params['in'] = f"state:{state} county:{county} tract:*"
                else:
                    params['in'] = f"state:{state} tract:*"
            
            elif level == 'state_lower':
                # For state house districts
                # Census API requires the "state " prefix on the geography name
                # (see https://api.census.gov/data/{year}/acs/acs5/geography.html)
                params['for'] = "state legislative district (lower chamber):*"
                params['in'] = f"state:{state}"

            elif level == 'state_upper':
                # For state senate districts
                params['for'] = "state legislative district (upper chamber):*"
                params['in'] = f"state:{state}"
            
            # Make the API request with parameters
            # The requests library will handle URL encoding automatically
            response = requests.get(self.base_url, params=params)
            response.raise_for_status()
            
            # Log the request URL (with key redacted) for debugging
            safe_params = params.copy()
            if 'key' in safe_params:
                safe_params['key'] = 'REDACTED'
            logger.debug(f"API request: {self.base_url}?{urlencode(safe_params, safe=':,')}")
            
            # Parse the JSON response
            data = response.json()
            
            # Log the response to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"API request successful. Response has {len(data)} rows.\n")
                f.write(f"First row: {data[0] if data else 'No data'}\n")
            
            # Log the request (without API key for security)
            logger.info(f"Fetching ACS data for {len(variables)} variables at {level} level")
            
            # Construct the URL for the request
            url = f"{self.base_url}?{urlencode(params, safe=':,')}"
            safe_url = url.split('&key=')[0] + '&key=HIDDEN'
            logger.debug(f"API URL: {safe_url}")
            
            # Log to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"API request: {safe_url}\n")
            
            # Make the request
            response = requests.get(url)
            response.raise_for_status()
            
            # Log the raw response content for debugging
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Raw API response status code: {response.status_code}\n")
                f.write(f"Raw API response headers: {response.headers}\n")
                f.write(f"Raw API response content (first 500 chars): {response.text[:500]}\n")
                
                # Check if median_rent variable is in the response
                if 'b25064_001e' in response.text.lower():
                    f.write("Found b25064_001e (median_rent) in raw API response\n")
                else:
                    f.write("WARNING: b25064_001e (median_rent) NOT FOUND in raw API response\n")
            
            # Check if the response is valid JSON
            try:
                data = response.json()
            except Exception as e:
                logger.error(f"Error parsing JSON response: {str(e)}")
                with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                    f.write(f"Error parsing JSON: {str(e)}\n")
                    
                # The API key might be invalid or the request might be malformed
                # Let's check if there's an error message in the response
                if "Invalid API key" in response.text:
                    raise ValueError("Invalid Census API key provided")
                elif "error" in response.text.lower():
                    raise ValueError(f"Census API error: {response.text}")
                else:
                    raise ValueError(f"Failed to parse Census API response: {str(e)}. Check the debug log for details.")
            
            # Log response to debug file (first few rows)
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"API response (first 2 rows): {data[:2]}\n")
            
            # First row contains headers
            headers = [h.lower() for h in data[0]]
            rows = data[1:]
            
            # Convert to DataFrame
            df = pd.DataFrame(rows, columns=headers)

            # Normalize Census geography columns to the short FIPS-style names
            # the GeoIDStandardizer expects. The API returns these as verbose
            # header strings (e.g. "state legislative district (lower chamber)")
            # but the standardizer looks up `sldlst` / `sldust`.
            geo_col_renames = {
                'state legislative district (lower chamber)': 'sldlst',
                'state legislative district (upper chamber)': 'sldust',
            }
            df = df.rename(columns={k: v for k, v in geo_col_renames.items() if k in df.columns})

            # The data_loader looks up the `NAME` column (uppercase) for
            # county matching and display. The Census API returns `NAME`
            # but our lowercased-headers step above turned it into `name`.
            # Restore the uppercase alias to keep the CSV schema compatible
            # with prior-year files.
            if 'name' in df.columns and 'NAME' not in df.columns:
                df['NAME'] = df['name']

            # Log the columns before conversion
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Columns in raw DataFrame: {df.columns.tolist()}\n")
                f.write(f"Looking for b25064_001e in columns: {'b25064_001e' in [col.lower() for col in df.columns]}\n")
            
            # Convert numeric columns to appropriate types
            for var in variables:
                var_lower = var.lower()
                if var_lower in df.columns:
                    df[var_lower] = pd.to_numeric(df[var_lower], errors='coerce')
                    
                    # Log median_rent values for debugging
                    if var_lower == 'b25064_001e':
                        with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                            f.write(f"Found b25064_001e in DataFrame. First 5 values: {df[var_lower].head().tolist()}\n")
            
            # Add GEOID column based on geographic level
            if standardize_geoids:
                try:
                    # Convert DataFrame to list of dictionaries for standardization
                    records = df.to_dict('records')
                    
                    # Generate standardized GEOIDs
                    geoids = [GeoIDStandardizer.standardize_geoid(record, level) for record in records]
                    
                    # Add the GEOID column
                    df['geoid'] = geoids
                    
                    # Log any invalid GEOIDs
                    invalid_geoids = [geoid for geoid in geoids if not GeoIDStandardizer.validate_geoid(geoid, level)]
                    if invalid_geoids:
                        logger.warning(f"Found {len(invalid_geoids)} invalid GEOIDs for level {level}")
                    
                    # Reorder columns to put GEOID first
                    cols = ['geoid'] + [col for col in df.columns if col != 'geoid']
                    df = df[cols]
                except Exception as e:
                    logger.error(f"Error standardizing GEOIDs: {str(e)}", exc_info=True)
                    # Fall back to simple GEOID generation
                    self._add_simple_geoid(df, level)
            else:
                # Use simple GEOID generation if standardization is disabled
                self._add_simple_geoid(df, level)
            
            # Rename variables to be more readable (after GEOID standardization)
            rename_cols = {
                'b17001_002e': 'below_poverty',
                'b17001_001e': 'total_population',
                'b19013_001e': 'median_income',
                'b19013_001m': 'median_income_moe',
                'b15003_017e': 'edu_hs_diploma',
                'b15003_018e': 'edu_ged',
                'b15003_019e': 'edu_some_college_lt1',
                'b15003_020e': 'edu_some_college_1plus',
                'b15003_021e': 'edu_associates',
                'b15003_022e': 'edu_bachelors',  # bachelor's only; bachelors_plus adds _023E–_025E
                'b15003_023e': 'edu_masters',
                'b15003_024e': 'edu_professional',
                'b15003_025e': 'edu_doctorate',
                'b15003_001e': 'pop_25_plus',
                'b25003_003e': 'renter_occupied',
                'b25003_001e': 'total_housing_units',
                'b25064_001e': 'median_rent',  # Added median rent variable
                'b25046_001e': 'aggregate_vehicles',  # Aggregate vehicles available (B25046)
                'b01003_001e': 'total_resident_population',  # Total population (B01003)
                'b08013_001e': 'aggregate_travel_time',  # Aggregate travel time to work (B08013)
                'b08301_001e': 'total_workers',  # Total workers 16 years and over
                'b08301_010e': 'public_transit_workers',  # Workers using public transportation
                'b08301_018e': 'bicycle_workers',  # Workers commuting by bicycle
                'b08301_019e': 'walked_workers',  # Workers commuting by walking
                'b08301_021e': 'wfh_workers',  # Workers who worked from home
                'b08201_001e': 'veh_hh_total',  # Total households (B08201 universe)
                'b08201_002e': 'veh_hh_0',  # Households with no vehicle
                'b08201_003e': 'veh_hh_1',  # Households with 1 vehicle
                'b08201_004e': 'veh_hh_2',  # Households with 2 vehicles
                'b08201_005e': 'veh_hh_3',  # Households with 3 vehicles
                'b08201_006e': 'veh_hh_4plus',  # Households with 4+ vehicles
                'b02001_001e': 'race_total_pop',
                'b02008_001e': 'white_aoic',
                'b02009_001e': 'black_aoic',
                'b02011_001e': 'asian_aoic',
                'b02012_001e': 'nhpi_aoic',
                'b03002_001e': 'hispanic_universe',
                'b03002_012e': 'hispanic_total',
                'b25002_001e': 'occupancy_universe',
                'b25002_003e': 'vacant_units'
            }
            
            # Only rename columns that exist in the dataframe
            rename_cols = {k.lower(): v for k, v in rename_cols.items() if k.lower() in df.columns}
            df = df.rename(columns=rename_cols)
            
            # Log to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Final DataFrame columns: {df.columns.tolist()}\n")
                f.write(f"DataFrame shape: {df.shape}\n")
                if not df.empty:
                    f.write(f"First row: {df.iloc[0].to_dict()}\n")
            
            # Calculate poverty rate and other metrics (skipped when batching;
            # the caller derives once over the merged frame)
            if derive:
                df = self.calculate_poverty_rate(df)

            return df
            
        except Exception as e:
            logger.error(f"Error fetching ACS data: {str(e)}", exc_info=True)
            
            # Log detailed error to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Error in get_acs_data: {str(e)}\n")
                f.write(traceback.format_exc())
                
            raise
    
    def calculate_poverty_rate(self, df: pd.DataFrame) -> pd.DataFrame:
        """Calculate poverty rate and other metrics from ACS data.

        Args:
            df: DataFrame with ACS data

        Returns:
            DataFrame with calculated metrics
        """
        # Make a copy to avoid modifying the original
        df = df.copy()

        # ── Derived metrics using the column names produced by the rename
        # dict in get_acs_data(). These match the schema the dashboard's
        # data_loader expects (poverty_rate, renter_rate, rent_burden_rate,
        # etc.), so downstream maps render properly.
        def _safe_div(num, den):
            """Element-wise division that returns NaN when den is 0/NaN."""
            return (num / den.replace(0, np.nan)) * 100

        # Poverty rate: below_poverty / total_population (B17001 universe) × 100
        if 'below_poverty' in df.columns and 'total_population' in df.columns:
            df['poverty_rate'] = _safe_div(df['below_poverty'], df['total_population']).round(2)

        # Bachelor's-or-higher attainment: B15003_022E (bachelor's) through
        # _025E (master's, professional, doctorate) divided by B15003_001E.
        # _022E alone is bachelor's only, about 13 points short statewide.
        ba_plus_cols = ['edu_bachelors', 'edu_masters', 'edu_professional', 'edu_doctorate']
        if all(c in df.columns for c in ba_plus_cols) and 'pop_25_plus' in df.columns:
            df['bachelors_plus'] = df[ba_plus_cols].sum(axis=1)
            df['bachelors_rate'] = _safe_div(df['bachelors_plus'], df['pop_25_plus']).round(2)
            # Dashboard exposes this under the `college_educated_pct` key too
            df['college_educated_pct'] = df['bachelors_rate']

        # High-school-or-higher attainment: sum of B15003_017E … _025E (everyone
        # who has at least a regular HS diploma) divided by B15003_001E.
        hs_plus_cols = [
            'edu_hs_diploma', 'edu_ged', 'edu_some_college_lt1',
            'edu_some_college_1plus', 'edu_associates', 'edu_bachelors',
            'edu_masters', 'edu_professional', 'edu_doctorate',
        ]
        if all(c in df.columns for c in hs_plus_cols) and 'pop_25_plus' in df.columns:
            df['hs_or_higher'] = df[hs_plus_cols].sum(axis=1)
            df['high_school_or_higher_pct'] = _safe_div(df['hs_or_higher'], df['pop_25_plus']).round(2)

        # Race / ethnicity rates. Races use "alone or in combination" tables
        # (B02008–B02012), so the categories overlap and don't sum to 100% —
        # this is intentional for Hawaii where ~25% of residents are multi-racial.
        # Hispanic/Latino comes from B03002 and is reported as "any race".
        if 'race_total_pop' in df.columns:
            denom = df['race_total_pop']
            for src, out in (
                ('white_aoic', 'white_pct'),
                ('black_aoic', 'black_pct'),
                ('asian_aoic', 'asian_pct'),
                ('nhpi_aoic', 'nhpi_pct'),
            ):
                if src in df.columns:
                    df[out] = _safe_div(df[src], denom).round(2)
        if 'hispanic_total' in df.columns and 'hispanic_universe' in df.columns:
            df['hispanic_pct'] = _safe_div(df['hispanic_total'], df['hispanic_universe']).round(2)

        # Housing vacancy: B25002_003E / B25002_001E (vacant / total housing units)
        if 'vacant_units' in df.columns and 'occupancy_universe' in df.columns:
            df['vacancy_rate'] = _safe_div(df['vacant_units'], df['occupancy_universe']).round(2)

        # Renter-occupied share of housing units
        if 'renter_occupied' in df.columns and 'total_housing_units' in df.columns:
            df['renter_rate'] = _safe_div(df['renter_occupied'], df['total_housing_units']).round(2)

        # Rent burden (≥30% of income on rent) & severe rent burden (≥50%)
        rent_bucket_cols = ['b25070_007e', 'b25070_008e', 'b25070_009e', 'b25070_010e']
        rent_denom_col = 'b25070_001e'
        if all(c in df.columns for c in rent_bucket_cols) and rent_denom_col in df.columns:
            df['rent_burden_households'] = df[rent_bucket_cols].sum(axis=1)
            df['rent_burden_rate'] = _safe_div(df['rent_burden_households'], df[rent_denom_col]).round(2)
            df['severe_rent_burden_rate'] = _safe_div(df['b25070_010e'], df[rent_denom_col]).round(2)

        # Median home value (rename)
        if 'b25077_001e' in df.columns and 'median_home_value' not in df.columns:
            df['median_home_value'] = df['b25077_001e']

        # Unemployment rate: unemployed / civilian labor force × 100
        if 'b23025_005e' in df.columns and 'b23025_003e' in df.columns:
            df['unemployment_rate'] = _safe_div(df['b23025_005e'], df['b23025_003e']).round(2)

        # Public transportation commute share: B08301_010E / B08301_001E × 100.
        # Uses the B08301 means-of-transportation universe (all workers 16+,
        # including work-from-home) so transit/active/WFH shares are all scaled
        # against the same denominator and are directly comparable.
        if 'public_transit_workers' in df.columns and 'total_workers' in df.columns:
            df['public_transportation_pct'] = _safe_div(df['public_transit_workers'], df['total_workers']).round(2)

        # Mean travel time to work (minutes) — exact mean from the Census
        # aggregate (B08013) ÷ commuters (B08303_001E, workers who did not work
        # from home). The prior bucket-midpoint version averaged only the
        # ≥30-min buckets, overstating the mean badly (~47 vs ~26 min).
        if 'aggregate_travel_time' in df.columns and 'b08303_001e' in df.columns:
            commuters = pd.to_numeric(df['b08303_001e'], errors='coerce')
            df['travel_time_to_work_minutes'] = (
                df['aggregate_travel_time'] / commuters.replace(0, np.nan)
            ).round(2)

        # Average vehicles available per household — exact mean from the
        # Census-computed aggregate (B25046) ÷ households (B08201_001E). This
        # avoids the open-ended-bucket bias of summing B08201 marginals (the
        # "4 or more" category has no upper bound).
        if 'aggregate_vehicles' in df.columns and 'veh_hh_total' in df.columns:
            df['avg_vehicles_per_household'] = (
                df['aggregate_vehicles'] / df['veh_hh_total'].replace(0, np.nan)
            ).round(2)

        # Vehicles per capita — aggregate vehicles (B25046) ÷ total population
        # (B01003). Normalizes out household size, which the per-household
        # average conflates (large multigenerational households inflate it).
        if 'aggregate_vehicles' in df.columns and 'total_resident_population' in df.columns:
            df['vehicles_per_capita'] = (
                df['aggregate_vehicles'] / df['total_resident_population'].replace(0, np.nan)
            ).round(2)

        # Zero-vehicle households: B08201_002E / B08201_001E × 100. The share of
        # households with no vehicle — a direct transportation-access indicator.
        if 'veh_hh_0' in df.columns and 'veh_hh_total' in df.columns:
            df['zero_vehicle_household_pct'] = _safe_div(df['veh_hh_0'], df['veh_hh_total']).round(2)

        # Active-transportation commute share: (walked + bicycle) / total
        # workers (B08301_001E universe) × 100.
        if all(c in df.columns for c in ('walked_workers', 'bicycle_workers', 'total_workers')):
            df['active_transportation_pct'] = _safe_div(
                df['walked_workers'] + df['bicycle_workers'], df['total_workers']
            ).round(2)

        # Work-from-home share: B08301_021E / B08301_001E × 100. Same
        # means-of-transportation universe as the transit/active shares.
        if 'wfh_workers' in df.columns and 'total_workers' in df.columns:
            df['work_from_home_pct'] = _safe_div(df['wfh_workers'], df['total_workers']).round(2)

        # ── Margins of error (90% CI) for the ACS-derived metrics above ────────
        # Propagated from the published per-cell MOEs (the _M columns fetched
        # alongside each _E estimate) using the Census ACS handbook formulas.
        # Each <metric>_moe is in the same units as <metric> (percentage points
        # for rates, dollars for medians, vehicles for the average, minutes for
        # commute time). The info panel surfaces these on hover; values are
        # otherwise unchanged.
        def _moe(col, controlled_zero=True):
            """MOE column as a numeric Series, with Census jam values handled.
            For counts/totals, -555555555 marks a *controlled* estimate (no
            sampling error) → 0. For medians, the same code instead means the
            median falls in the lowest/highest interval so the MOE is not
            calculable → NaN; pass controlled_zero=False there. All other
            negative sentinels (-222222222 "too few cases", etc.) → NaN. Returns
            None if the column is absent."""
            if col not in df.columns:
                return None
            s = pd.to_numeric(df[col], errors='coerce')
            if controlled_zero:
                s = s.mask(s == -555555555, 0.0)
            return s.where(s >= 0, np.nan)

        def _moe_sum(*cols):
            """sqrt(Σ MOE_i²) for a derived count that sums cells."""
            ms = [_moe(c) for c in cols]
            if any(m is None for m in ms):
                return None
            return np.sqrt(sum(m ** 2 for m in ms))

        def _est(col):
            """Estimate column as numeric (handles renamed or raw names)."""
            return pd.to_numeric(df[col], errors='coerce') if col in df.columns else None

        def moe_pct(num_moe, den_col, rate_col, den_moe):
            """MOE (in percentage points) for rate = num/den×100 where num is a
            subset of den. Uses the subset-proportion formula, falling back to
            the ratio formula element-wise where the radicand goes negative."""
            den = _est(den_col)
            if num_moe is None or den is None or den_moe is None or rate_col not in df.columns:
                return None
            p = pd.to_numeric(df[rate_col], errors='coerce') / 100.0
            rad = num_moe ** 2 - (p ** 2) * (den_moe ** 2)
            rad = rad.where(rad >= 0, num_moe ** 2 + (p ** 2) * (den_moe ** 2))
            return (np.sqrt(rad) / den.replace(0, np.nan) * 100).round(2)

        def moe_ratio(num_moe, den_col, ratio_col, den_moe):
            """MOE for ratio = num/den (num NOT a subset of den), same units as
            the ratio. Used for vehicles-per-household."""
            den = _est(den_col)
            if num_moe is None or den is None or den_moe is None or ratio_col not in df.columns:
                return None
            r = pd.to_numeric(df[ratio_col], errors='coerce')
            return (np.sqrt(num_moe ** 2 + (r ** 2) * (den_moe ** 2)) / den.replace(0, np.nan)).round(2)

        def _set_moe(name, series):
            if series is not None:
                df[f'{name}_moe'] = series

        # Direct median estimates — MOE is the published _M as-is. Medians are
        # never controlled, so a -555555555 here means "not calculable" (median
        # in the top/bottom interval) → NaN, not zero error.
        if _moe('b19013_001m', controlled_zero=False) is not None: _set_moe('median_income', _moe('b19013_001m', controlled_zero=False))
        if _moe('b25064_001m', controlled_zero=False) is not None: _set_moe('median_rent', _moe('b25064_001m', controlled_zero=False))
        if _moe('b25077_001m', controlled_zero=False) is not None: _set_moe('median_home_value', _moe('b25077_001m', controlled_zero=False))

        # Subset-proportion rates (numerator ⊂ denominator).
        _set_moe('poverty_rate',          moe_pct(_moe('b17001_002m'), 'total_population',    'poverty_rate',          _moe('b17001_001m')))
        _set_moe('unemployment_rate',     moe_pct(_moe('b23025_005m'), 'b23025_003e',         'unemployment_rate',     _moe('b23025_003m')))
        _set_moe('renter_rate',           moe_pct(_moe('b25003_003m'), 'total_housing_units', 'renter_rate',           _moe('b25003_001m')))
        _set_moe('severe_rent_burden_rate', moe_pct(_moe('b25070_010m'), 'b25070_001e',       'severe_rent_burden_rate', _moe('b25070_001m')))
        _set_moe('rent_burden_rate',      moe_pct(_moe_sum('b25070_007m','b25070_008m','b25070_009m','b25070_010m'), 'b25070_001e', 'rent_burden_rate', _moe('b25070_001m')))
        _set_moe('vacancy_rate',          moe_pct(_moe('b25002_003m'), 'occupancy_universe',  'vacancy_rate',          _moe('b25002_001m')))
        _set_moe('public_transportation_pct', moe_pct(_moe('b08301_010m'), 'total_workers',   'public_transportation_pct', _moe('b08301_001m')))
        _set_moe('zero_vehicle_household_pct', moe_pct(_moe('b08201_002m'), 'veh_hh_total',   'zero_vehicle_household_pct', _moe('b08201_001m')))
        _set_moe('work_from_home_pct',    moe_pct(_moe('b08301_021m'), 'total_workers',       'work_from_home_pct',    _moe('b08301_001m')))
        _set_moe('active_transportation_pct', moe_pct(_moe_sum('b08301_018m','b08301_019m'), 'total_workers', 'active_transportation_pct', _moe('b08301_001m')))
        _set_moe('college_educated_pct',  moe_pct(_moe_sum('b15003_022m','b15003_023m','b15003_024m','b15003_025m'), 'pop_25_plus', 'college_educated_pct', _moe('b15003_001m')))
        _set_moe('high_school_or_higher_pct', moe_pct(_moe_sum('b15003_017m','b15003_018m','b15003_019m','b15003_020m','b15003_021m','b15003_022m','b15003_023m','b15003_024m','b15003_025m'), 'pop_25_plus', 'high_school_or_higher_pct', _moe('b15003_001m')))
        _set_moe('white_pct',             moe_pct(_moe('b02008_001m'), 'race_total_pop',      'white_pct',             _moe('b02001_001m')))
        _set_moe('black_pct',             moe_pct(_moe('b02009_001m'), 'race_total_pop',      'black_pct',             _moe('b02001_001m')))
        _set_moe('asian_pct',             moe_pct(_moe('b02011_001m'), 'race_total_pop',      'asian_pct',             _moe('b02001_001m')))
        _set_moe('nhpi_pct',              moe_pct(_moe('b02012_001m'), 'race_total_pop',      'nhpi_pct',              _moe('b02001_001m')))
        _set_moe('hispanic_pct',          moe_pct(_moe('b03002_012m'), 'hispanic_universe',   'hispanic_pct',          _moe('b03002_001m')))

        # Ratios (numerator NOT a subset of denominator), same units as the value.
        _set_moe('avg_vehicles_per_household', moe_ratio(_moe('b25046_001m'), 'veh_hh_total', 'avg_vehicles_per_household', _moe('b08201_001m')))
        _set_moe('vehicles_per_capita', moe_ratio(_moe('b25046_001m'), 'total_resident_population', 'vehicles_per_capita', _moe('b01003_001m')))
        _set_moe('travel_time_to_work_minutes', moe_ratio(_moe('b08013_001m'), 'b08303_001e', 'travel_time_to_work_minutes', _moe('b08303_001m')))

        # ── Legacy branches below (unchanged) — these reference older column
        # names that are not produced by the current rename dict and will
        # simply be no-ops for our data.

        # Calculate poverty rate if we have the data
        if 'income_below_poverty_level' in df.columns and 'poverty_status_determined' in df.columns:
            df['poverty_rate'] = (df['income_below_poverty_level'] / df['poverty_status_determined']) * 100
            
        # Calculate public transportation rate if we have the data
        if 'public_transportation_workers' in df.columns and 'total_workers' in df.columns:
            df['public_transportation_rate'] = (df['public_transportation_workers'] / df['total_workers']) * 100
            
        # Calculate transportation metrics from S0802 if available
        # Check for both standard names and ACS Subject Table variable names
        total_workers_col = None
        if 'total_workers_16_plus' in df.columns:
            total_workers_col = 'total_workers_16_plus'
        elif 's0802_c01_001e' in df.columns:
            total_workers_col = 's0802_c01_001e'
            
        if total_workers_col is not None:
            # Map ACS Subject Table variables to readable names
            transport_mapping = {
                's0802_c01_002e': 'drove_alone',
                's0802_c01_003e': 'carpooled', 
                's0802_c01_004e': 'public_transportation',
                's0802_c01_005e': 'walked',
                's0802_c01_006e': 'bicycle',
                's0802_c01_007e': 'taxi_motorcycle_other',
                's0802_c01_008e': 'worked_from_home'
            }
            
            # Calculate mode share percentages
            # Note: S0802 table already provides percentages, not raw counts
            for acs_var, mode_name in transport_mapping.items():
                if acs_var in df.columns:
                    # S0802 variables are already percentages, so use them directly
                    df[f'{mode_name}_pct'] = df[acs_var]
                elif mode_name in df.columns:
                    df[f'{mode_name}_pct'] = (df[mode_name] / df[total_workers_col]) * 100
            
            # Calculate summary metrics
            if 'drove_alone_pct' in df.columns and 'carpooled_pct' in df.columns:
                df['drove_alone_or_carpooled_pct'] = df['drove_alone_pct'] + df['carpooled_pct']
                
            if 'travel_time_to_work_minutes' in df.columns and 'walked_pct' in df.columns and 'bicycle_pct' in df.columns:
                df['active_transportation_pct'] = df['walked_pct'] + df['bicycle_pct']
        
        # Calculate homeownership rate if we have the data
        if 'owner_occupied_units' in df.columns and 'total_housing_units' in df.columns:
            df['homeownership_rate'] = (df['owner_occupied_units'] / df['total_housing_units']) * 100
            
        # Calculate unemployment rate if we have the data
        if 'unemployed' in df.columns and 'in_labor_force' in df.columns:
            df['unemployment_rate'] = (df['unemployed'] / df['in_labor_force']) * 100
            
        # Calculate educational attainment rates if we have the data
        if 'bachelors_degree' in df.columns and 'education_total' in df.columns:
            df['bachelors_degree_rate'] = (df['bachelors_degree'] / df['education_total']) * 100
            
        if 'masters_degree' in df.columns and 'education_total' in df.columns:
            df['masters_degree_rate'] = (df['masters_degree'] / df['education_total']) * 100
            
        if 'professional_degree' in df.columns and 'education_total' in df.columns:
            df['professional_degree_rate'] = (df['professional_degree'] / df['education_total']) * 100
            
        if 'doctorate_degree' in df.columns and 'education_total' in df.columns:
            df['doctorate_degree_rate'] = (df['doctorate_degree'] / df['education_total']) * 100
            
        # Calculate high school or higher
        if 'education_total' in df.columns and 'bachelors_degree' in df.columns:
            # This is a simplification - would need more detailed variables for accurate calculation
            df['high_school_plus_rate'] = 100 - ((df['education_total'] - df['bachelors_degree']) / df['education_total'] * 100)
            
        # Calculate race/ethnicity percentages
        if 'white_alone' in df.columns and 'total_race' in df.columns:
            df['white_pct'] = (df['white_alone'] / df['total_race']) * 100
            
        if 'black_african_american_alone' in df.columns and 'total_race' in df.columns:
            df['black_pct'] = (df['black_african_american_alone'] / df['total_race']) * 100
            
        if 'asian_alone' in df.columns and 'total_race' in df.columns:
            df['asian_pct'] = (df['asian_alone'] / df['total_race']) * 100
            
        if 'native_hawaiian_pacific_islander_alone' in df.columns and 'total_race' in df.columns:
            df['nhpi_pct'] = (df['native_hawaiian_pacific_islander_alone'] / df['total_race']) * 100
            
        if 'hispanic_latino' in df.columns and 'total_race' in df.columns:
            df['hispanic_latino_pct'] = (df['hispanic_latino'] / df['total_race']) * 100
            
        # Calculate housing metrics
        if 'vacant_units' in df.columns and 'total_housing_units_occupancy' in df.columns:
            df['vacancy_rate'] = (df['vacant_units'] / df['total_housing_units_occupancy']) * 100
            
        # Calculate vehicle availability metrics
        if 'owner_no_vehicle' in df.columns and 'owner_1_vehicle' in df.columns and 'renter_no_vehicle' in df.columns and 'renter_1_vehicle' in df.columns:
            df['no_vehicle_pct'] = ((df['owner_no_vehicle'] + df['renter_no_vehicle']) / 
                                  (df['owner_no_vehicle'] + df['owner_1_vehicle'] + 
                                   df['renter_no_vehicle'] + df['renter_1_vehicle'])) * 100
            
            df['one_vehicle_pct'] = ((df['owner_1_vehicle'] + df['renter_1_vehicle']) / 
                                   (df['owner_no_vehicle'] + df['owner_1_vehicle'] + 
                                    df['renter_no_vehicle'] + df['renter_1_vehicle'])) * 100
        
        return df
        
    def _add_simple_geoid(self, df: pd.DataFrame, level: str) -> None:
        """Add a simple GEOID column to the DataFrame based on the geographic level.
        
        Args:
            df: DataFrame to add GEOID to
            level: Geographic level ('tract', 'block group', 'county', 'state_lower', 'state_upper')
        """
        logger.info(f"Adding simple GEOID for level: {level}")
        
        try:
            if level == 'county':
                # For counties, GEOID is STATE + COUNTY
                if 'state' in df.columns and 'county' in df.columns:
                    df['geoid'] = df['state'] + df['county']
                    
            elif level == 'tract':
                # For tracts, GEOID is STATE + COUNTY + TRACT
                if 'state' in df.columns and 'county' in df.columns and 'tract' in df.columns:
                    df['geoid'] = df['state'] + df['county'] + df['tract']
                    
            elif level == 'block group':
                # For block groups, GEOID is STATE + COUNTY + TRACT + BLOCK GROUP
                if all(col in df.columns for col in ['state', 'county', 'tract', 'block group']):
                    df['geoid'] = df['state'] + df['county'] + df['tract'] + df['block group']
                    
            elif level == 'state_lower':
                # For state house districts, GEOID is STATE + SLDL (state legislative district lower)
                if 'state' in df.columns and 'legislative district (lower chamber)' in df.columns:
                    df['geoid'] = df['state'] + df['legislative district (lower chamber)'].str.zfill(3)
                    
            elif level == 'state_upper':
                # For state senate districts, GEOID is STATE + SLDU (state legislative district upper)
                if 'state' in df.columns and 'legislative district (upper chamber)' in df.columns:
                    df['geoid'] = df['state'] + df['legislative district (upper chamber)'].str.zfill(3)
                    
            # Reorder columns to put GEOID first if it was successfully added
            if 'geoid' in df.columns:
                cols = ['geoid'] + [col for col in df.columns if col != 'geoid']
                df = df[cols]
                logger.info("Successfully added simple GEOID column")
            else:
                logger.warning(f"Could not add simple GEOID for level {level} due to missing columns")
                
        except Exception as e:
            logger.error(f"Error adding simple GEOID: {str(e)}")
            
            # Log to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"Error adding simple GEOID: {str(e)}\n")
    
    @staticmethod
    def get_common_variables():
        """Get a dictionary of common ACS variables.
        
        Returns:
            Dictionary mapping variable codes to descriptions
        """
        return {
            # Population
            'B01003_001E': 'total_population',
            
            # Age and Sex
            'B01001_001E': 'total_population_sex',
            'B01001_002E': 'male_population',
            'B01001_026E': 'female_population',
            'B01002_001E': 'median_age',
            
            # Race and Ethnicity
            'B03002_001E': 'total_race',
            'B03002_003E': 'white_alone',
            'B03002_004E': 'black_african_american_alone',
            'B03002_005E': 'american_indian_alaska_native_alone',
            'B03002_006E': 'asian_alone',
            'B03002_007E': 'native_hawaiian_pacific_islander_alone',
            'B03002_008E': 'other_race_alone',
            'B03002_009E': 'two_or_more_races',
            'B03002_012E': 'hispanic_latino',
            
            # Income and Poverty
            'B19013_001E': 'median_household_income',
            'B17001_002E': 'income_below_poverty_level',
            'B17001_001E': 'poverty_status_determined',
            'B25064_001E': 'median_gross_rent',
            'B25077_001E': 'median_home_value',
            'B25070_001E': 'gross_rent_as_percentage_of_income',
            'B25071_001E': 'median_gross_rent_as_percentage_of_household_income',
            
            # Education
            'B15003_001E': 'education_total',
            'B15003_022E': 'bachelors_degree',
            'B15003_023E': 'masters_degree',
            'B15003_024E': 'professional_degree',
            'B15003_025E': 'doctorate_degree',
            
            # Employment
            'B23025_001E': 'employment_status_total',
            'B23025_002E': 'in_labor_force',
            'B23025_004E': 'employed',
            'B23025_005E': 'unemployed',
            'B23025_007E': 'not_in_labor_force',
            
            # Transportation to Work (B08301)
            'B08301_001E': 'total_workers',
            'B08301_010E': 'public_transportation_workers',
            
            # S0802 - Means of Transportation to Work by Selected Characteristics (Subject Table)
            'S0802_C01_001E': 'total_workers_16_plus',
            'S0802_C01_002E': 'drove_alone',
            'S0802_C01_003E': 'carpooled',
            'S0802_C01_010E': 'public_transportation',
            'S0802_C01_011E': 'walked',
            'S0802_C01_012E': 'bicycle',
            'S0802_C01_013E': 'taxi_motorcycle_other',
            'S0802_C01_014E': 'worked_from_home',
            
            # Housing
            'B25003_001E': 'total_housing_units',
            'B25003_002E': 'owner_occupied_units',
            'B25003_003E': 'renter_occupied_units',
            'B25002_001E': 'total_housing_units_occupancy',
            'B25002_002E': 'occupied_units',
            'B25002_003E': 'vacant_units',
            'B25035_001E': 'median_year_structure_built',
            'B25032_001E': 'total_units_in_structure',
            'B25032_002E': 'single_family_homes',
            'B25032_003E': 'mobile_homes',
            'B25032_004E': 'units_in_2_to_4_plex',
            'B25032_005E': 'units_in_5_to_9_plex',
            'B25032_006E': 'units_in_10_to_19_plex',
            'B25032_007E': 'units_in_20_to_49_plex',
            'B25032_008E': 'units_in_50_plus_plex',
            'B25032_009E': 'mobile_home_parks',
            'B25032_010E': 'boat_rv_van_etc',
            'B25032_011E': 'other_units',
            
            # Vehicles Available (B25044)
            'B25044_001E': 'total_vehicles',
            'B25044_003E': 'owner_no_vehicle',
            'B25044_004E': 'owner_1_vehicle',
            'B25044_010E': 'renter_no_vehicle',
            'B25044_011E': 'renter_1_vehicle',
            
            # Health Insurance
            'B27010_001E': 'health_insurance_coverage_total',
            'B27010_017E': 'no_health_insurance'
        }
        
    def get_acs_subject_data(
        self,
        variables: List[str],
        level: str = 'county',
        state: str = '15',
        year: int = None
    ) -> pd.DataFrame:
        """Fetch data from ACS Subject Tables API.
        
        Args:
            variables: List of ACS variable codes from Subject Tables (e.g., 'S0802_C01_001E')
            level: Geographic level ('state', 'county', 'state_lower', 'state_upper')
            state: State FIPS code (default: '15' for Hawaii)
            year: ACS year (default: None, uses instance year)
            
        Returns:
            DataFrame with the requested ACS Subject Tables data
            
        Raises:
            ValueError: If required parameters are missing or invalid
            ConnectionError: If there's an error connecting to the Census API
        """
        if year is None:
            year = self.year
            
        base_url = f"https://api.census.gov/data/{year}/acs/acs5/subject"
        
        # Map our level names to Census API geography names
        geo_mapping = {
            'state': ('state', '15'),  # 15 is Hawaii's FIPS code
            'county': ('county', '*'),
            'state_lower': ('state legislative district (lower chamber)', '*'),
            'state_upper': ('state legislative district (upper chamber)', '*')
        }
        
        if level not in geo_mapping:
            raise ValueError(f"Unsupported level: {level}. Must be one of {list(geo_mapping.keys())}")
        
        # Special handling for state level
        if level == 'state':
            params = {
                'get': 'NAME,' + ','.join(variables),
                'for': 'state:15',
                'key': self.api_key
            }
        else:
            geo_type, geo_value = geo_mapping[level]
            params = {
                'get': 'NAME,' + ','.join(variables),
                'for': f'{geo_type}:{geo_value}',
                'in': f'state:{state}',
                'key': self.api_key
            }
        
        try:
            # Log the request (with redacted API key)
            log_params = params.copy()
            if 'key' in log_params:
                log_params['key'] = 'REDACTED'
            logger.debug(f"ACS Subject Tables API request: {base_url}?{urlencode(log_params, safe=':,')}")
            
            # Make the request
            response = requests.get(base_url, params=params)
            response.raise_for_status()
            
            # Parse the JSON response
            data = response.json()
            
            # First row contains headers
            headers = [h.lower() for h in data[0]]
            rows = data[1:]
            
            # Convert to DataFrame
            df = pd.DataFrame(rows, columns=headers)
            
            # Standardize column names based on common variables
            var_mapping = {v.lower(): k for k, v in self.get_common_variables().items() 
                          if v.lower() in [h.lower() for h in headers]}
            
            df = df.rename(columns=var_mapping)
            
            # Add standardized GEOID if possible
            if 'state' in df.columns and 'county' in df.columns and 'tract' in df.columns:
                # For tract level
                df['GEOID'] = df['state'] + df['county'] + df['tract']
            elif 'state' in df.columns and 'county' in df.columns:
                # For county level
                df['GEOID'] = df['state'] + df['county']
            elif 'state' in df.columns:
                # For state level
                df['GEOID'] = df['state']
            
            # Convert numeric columns to appropriate types
            for col in df.columns:
                if col not in ['GEOID', 'NAME', 'state', 'county', 'tract', 
                              'state legislative district (lower chamber)', 
                              'state legislative district (upper chamber)']:
                    df[col] = pd.to_numeric(df[col], errors='coerce')
            
            return df
            
        except Exception as e:
            error_msg = f"Error fetching ACS Subject Tables data: {str(e)}"
            logger.error(error_msg)
            
            # Log the error to debug file
            with open(self.debug_log_file, 'a', encoding='utf-8') as f:
                f.write(f"{error_msg}\n")
                if hasattr(e, 'response') and e.response is not None:
                    f.write(f"Response status: {e.response.status_code}\n")
                    f.write(f"Response content: {e.response.text}\n")
            
            raise ConnectionError(error_msg) from e
    
    def save_to_csv(self, df: pd.DataFrame, filename: str) -> str:
        """Save DataFrame to a CSV file.
        
        Args:
            df: DataFrame to save
            filename: Output filename (without extension)
            
        Returns:
            Path to the saved file
        """
        try:
            # Ensure the filename has .csv extension
            if not filename.endswith('.csv'):
                filename = f"{filename}.csv"
                
            # Create the full path
            output_path = self.processed_dir / filename
            
            # Save to CSV
            df.to_csv(output_path, index=False)
            logger.info(f"Saved data to {output_path}")
            
            return str(output_path)
            
        except Exception as e:
            logger.error(f"Error saving to CSV: {str(e)}", exc_info=True)
            raise

def main():
    """Example usage."""
    try:
        # Initialize the ACS data fetcher
        fetcher = ACSDataFetcher()
        
        # Get common variables
        variables = list(fetcher.get_common_variables().keys())
        
        print("Fetching ACS data for Hawaii counties...")
        
        # Fetch data for Hawaii counties
        county_data = fetcher.get_acs_data(
            variables=variables,
            level='county',
            state='15',  # Hawaii
            geometry=False
        )
        
        if county_data is not None:
            print(f"Successfully fetched data with {len(county_data)} rows")
            print(f"Columns: {county_data.columns.tolist()}")
            
            # Calculate metrics
            county_data = fetcher.calculate_poverty_rate(county_data)
            
            # Save to CSV
            output_file = fetcher.save_to_csv(county_data, 'hawaii_counties_acs')
            print(f"Data saved to: {output_file}")
            
            # Verify median_rent is in the saved file
            if os.path.exists(output_file):
                df = pd.read_csv(output_file)
                if 'median_rent' in df.columns:
                    print("✓ median_rent column found in output file")
                    print(f"Sample median rent values:\n{df[['name', 'median_rent']].head()}")
                else:
                    print("✗ median_rent column NOT found in output file")
                    print(f"Available columns: {df.columns.tolist()}")
            
            print("Done!")
        else:
            print("Failed to fetch county data")
            
    except Exception as e:
        print(f"Error in main: {str(e)}")
        logger.error(f"Error in main: {str(e)}", exc_info=True)
        logger.error(f"Error in main: {str(e)}", exc_info=True)

if __name__ == "__main__":
    main()
