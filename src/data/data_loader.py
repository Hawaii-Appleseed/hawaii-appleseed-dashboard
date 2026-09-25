"""Refactored data loading utilities for the Hawaii Appleseed Dashboard."""

import pandas as pd
from pathlib import Path
import logging
from typing import Dict, Optional, Union, List, Any
import datetime
import json
from dataclasses import dataclass
from enum import Enum
from abc import ABC, abstractmethod

from config.variable_registry import get_available_variables
from data.data_source_registry import get_file_path, get_alice_excel_path

logger = logging.getLogger(__name__)


class GeoLevel(Enum):
    """Geographic levels supported by the data loader."""
    STATE = "state"
    COUNTY = "county"
    HOUSE = "house"
    SENATE = "senate"


class DataType(Enum):
    """Types of data available in the dashboard."""
    ACS = "acs"
    ALICE = "alice"
    SNAP = "snap"
    CEP = "cep"  # Community Eligibility Provision data
    MEDICAID = "medicaid"  # MedQuest enrollment, ACS-calibrated


@dataclass
class DataConfig:
    """Configuration for data files and columns."""
    file_patterns: Dict[str, str]
    sheet_patterns: Optional[Dict[str, str]] = None
    join_columns: Optional[Dict[str, str]] = None
    id_converters: Optional[Dict[str, callable]] = None


class DataMerger:
    """Handles merging of different data sources."""
    
    def __init__(self, geo_name_mapping: Dict[str, Dict[str, str]]):
        self.geo_name_mapping = geo_name_mapping
    
    def merge_datasets(self, base_data: pd.DataFrame, merge_data: pd.DataFrame, 
                      geo_level: GeoLevel, data_type: DataType) -> pd.DataFrame:
        """Merge datasets based on geographic level and data type."""
        merge_strategies = {
            GeoLevel.STATE: self._merge_state_data,
            GeoLevel.COUNTY: self._merge_county_data,
            GeoLevel.HOUSE: self._merge_district_data,
            GeoLevel.SENATE: self._merge_district_data
        }
        
        strategy = merge_strategies.get(geo_level)
        if not strategy:
            logger.error(f"No merge strategy for {geo_level}")
            return base_data
        
        return strategy(base_data, merge_data, data_type)
    
    def _merge_state_data(self, base_data: pd.DataFrame, merge_data: pd.DataFrame,
                         data_type: DataType) -> pd.DataFrame:
        """Merge state-level data."""
        merged = base_data.copy()
        # Always initialize columns so they exist even when merge_data is empty
        self._initialize_columns_by_type(merged, data_type)
        if len(merge_data) > 0:
            merge_row = merge_data.iloc[0]
            self._add_columns_by_type(merged, merge_row, data_type)
        return merged
    
    def _merge_county_data(self, base_data: pd.DataFrame, merge_data: pd.DataFrame,
                          data_type: DataType) -> pd.DataFrame:
        """Merge county-level data with name mapping."""
        merged = base_data.copy()
        self._initialize_columns_by_type(merged, data_type)
        
        county_mapping = self._get_county_mapping(data_type)
        
        for base_idx, base_row in base_data.iterrows():
            base_county_name = base_row.get('NAME', '')
            
            for merge_idx, merge_row in merge_data.iterrows():
                if data_type == DataType.ALICE:
                    merge_county = merge_row.get('name', '')
                elif data_type == DataType.CEP:
                    merge_county = merge_row.get('county', '')
                else:
                    merge_county = merge_row.get('NAME', '')
                
                if self._counties_match(base_county_name, merge_county, county_mapping):
                    self._add_columns_by_type(merged, merge_row, data_type, base_idx)
                    logger.debug(f"Matched {base_county_name} with {data_type.value} {merge_county}")
                    break
        
        return merged
    
    def _merge_district_data(self, base_data: pd.DataFrame, merge_data: pd.DataFrame,
                           data_type: DataType) -> pd.DataFrame:
        """Merge district-level data."""
        # Use geoid-based merge for SNAP, CEP and Medicaid data if geoid column exists
        if data_type in [DataType.SNAP, DataType.CEP, DataType.MEDICAID] and 'geoid' in merge_data.columns:
            return self._merge_by_geoid(base_data, merge_data, data_type)
        
        return self._merge_by_district(base_data, merge_data, data_type)
    
    def _merge_by_geoid(self, base_data: pd.DataFrame, merge_data: pd.DataFrame,
                       data_type: DataType) -> pd.DataFrame:
        """Merge data using geoid field."""
        if 'geoid' not in base_data.columns:
            base_data = self._create_geoid_column(base_data)
        
        merge_cols = self._get_merge_columns(merge_data, data_type)
        return pd.merge(base_data, merge_data[merge_cols], on='geoid', how='left')
    
    def _merge_by_district(self, base_data: pd.DataFrame, merge_data: pd.DataFrame,
                          data_type: DataType) -> pd.DataFrame:
        """Merge data using district numbers."""
        base_key = self._find_district_column(base_data)
        if not base_key or 'district' not in merge_data.columns:
            logger.warning("Could not find matching district columns")
            merged = base_data.copy()
            self._initialize_columns_by_type(merged, data_type)
            return merged
        
        merge_cols = self._get_merge_columns(merge_data, data_type)
        return pd.merge(base_data, merge_data[merge_cols], 
                       left_on=base_key, right_on='district', how='left')
    
    def _get_county_mapping(self, data_type: DataType) -> Dict[str, List[str]]:
        """Get county name mapping for data type."""
        if data_type == DataType.ALICE:
            return {
                'Honolulu County, Hawaii': ['Honolulu', 'Oahu'],
                'Hawaii County, Hawaii': ['Hawaii'],
                'Maui County, Hawaii': ['Maui'],
                'Kauai County, Hawaii': ['Kauai']
            }
        elif data_type == DataType.CEP:
            return {
                'Honolulu County, Hawaii': ['Honolulu'],
                'Hawaii County, Hawaii': ['Hawaii'],
                'Maui County, Hawaii': ['Maui'],
                'Kauai County, Hawaii': ['Kauai']
            }
        else:
            return {
                'Honolulu County, Hawaii': ['HONOLULU'],
                'Hawaii County, Hawaii': ['HAWAII'],
                'Maui County, Hawaii': ['MAUI'],
                'Kauai County, Hawaii': ['KAUAI']
            }
    
    def _counties_match(self, base_name: str, merge_name: str, 
                       mapping: Dict[str, List[str]]) -> bool:
        """Check if county names match using mapping."""
        if base_name in mapping:
            return merge_name in mapping[base_name]
        return False
    
    def _get_merge_columns(self, merge_data: pd.DataFrame, data_type: DataType) -> List[str]:
        """Get columns to merge based on data type."""
        base_cols = ['geoid'] if 'geoid' in merge_data.columns else ['district']
        
        if data_type == DataType.ALICE:
            return base_cols + ['alice_rate']
        elif data_type == DataType.SNAP:
            snap_cols = ['snap_households', 'snap_household_rate', 'snap_benefit_annual_per_household', 'snap_benefits_annual_total']
            return base_cols + [col for col in snap_cols if col in merge_data.columns]
        elif data_type == DataType.CEP:
            cep_cols = ['total_schools', 'cep_schools', 'cep_percentage', 'cep_display']
            return base_cols + [col for col in cep_cols if col in merge_data.columns]
        elif data_type == DataType.MEDICAID:
            med_cols = ['medicaid_enrollment', 'medicaid_rate']
            return base_cols + [col for col in med_cols if col in merge_data.columns]

        return base_cols
    
    def _find_district_column(self, df: pd.DataFrame) -> Optional[str]:
        """Find the district column in a DataFrame."""
        possible_cols = [
            'state legislative district (lower chamber)',
            'state legislative district (upper chamber)',
            'sldlst', 'sldust',
            'district', 'DISTRICT'
        ]
        
        for col in possible_cols:
            if col in df.columns:
                return col
        return None
    
    def _create_geoid_column(self, df: pd.DataFrame) -> pd.DataFrame:
        """Create geoid column from district information."""
        df = df.copy()
        district_col = self._find_district_column(df)
        if district_col:
            df['geoid'] = '15' + df[district_col].astype(str).str.zfill(3)
        return df
    
    def _add_columns_by_type(self, df: pd.DataFrame, source_row: pd.Series, 
                           data_type: DataType, target_idx: Optional[int] = None):
        """Add columns to DataFrame based on data type."""
        if data_type == DataType.ALICE:
            self._set_value(df, 'alice_rate', source_row.get('alice_rate'), target_idx)
        elif data_type == DataType.SNAP:
            snap_cols = ['snap_households', 'snap_household_rate', 'snap_benefit_annual_per_household', 'snap_benefits_annual_total']
            for col in snap_cols:
                self._set_value(df, col, source_row.get(col), target_idx)
        elif data_type == DataType.CEP:
            cep_cols = ['total_schools', 'cep_schools', 'cep_percentage', 'cep_display']
            for col in cep_cols:
                self._set_value(df, col, source_row.get(col), target_idx)
        elif data_type == DataType.MEDICAID:
            for col in ('medicaid_enrollment', 'medicaid_rate'):
                self._set_value(df, col, source_row.get(col), target_idx)

    def _initialize_columns_by_type(self, df: pd.DataFrame, data_type: DataType):
        """Initialize columns in DataFrame based on data type."""
        if data_type == DataType.ALICE:
            df['alice_rate'] = None
        elif data_type == DataType.SNAP:
            snap_cols = ['snap_households', 'snap_household_rate', 'snap_benefit_annual_per_household', 'snap_benefits_annual_total']
            for col in snap_cols:
                df[col] = None
        elif data_type == DataType.CEP:
            cep_cols = ['total_schools', 'cep_schools', 'cep_percentage', 'cep_display']
            for col in cep_cols:
                df[col] = None
        elif data_type == DataType.MEDICAID:
            for col in ('medicaid_enrollment', 'medicaid_rate'):
                df[col] = None

    def _set_value(self, df: pd.DataFrame, column: str, value: Any,
                  target_idx: Optional[int] = None):
        """Set value in DataFrame column."""
        if target_idx is not None:
            df.loc[target_idx, column] = value
        else:
            df[column] = value


class BaseDataLoader(ABC):
    """Abstract base class for data loaders."""
    
    def __init__(self, data_dir: Path, config: DataConfig):
        self.data_dir = data_dir
        self.config = config
    
    @abstractmethod
    def load_data(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Load data for a specific geographic level."""
        pass
    
    def _validate_geo_level(self, geo_level: Union[GeoLevel, str]) -> bool:
        """Validate that the geographic level is supported."""
        if isinstance(geo_level, str):
            geo_level = geo_level.lower()
            return geo_level in ['state', 'county', 'house', 'senate']
        return geo_level in [GeoLevel.STATE, GeoLevel.COUNTY, 
                           GeoLevel.HOUSE, GeoLevel.SENATE]


class ACSDataLoader(BaseDataLoader):
    """Loader for American Community Survey data."""
    
    def __init__(self, data_dir: Path, config: DataConfig):
        super().__init__(data_dir, config)
        # Don't initialize ACSDataFetcher unless needed - it's slow
        self.fetcher = None
    
    def load_data(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Load ACS data for a geographic level."""
        if not self._validate_geo_level(geo_level):
            logger.error(f"Invalid geographic level: {geo_level}")
            return None
        
        # First try to load from CSV file (for backwards compatibility)
        file_path = self.data_dir / self.config.file_patterns[geo_level.value]
        if file_path.exists():
            try:
                df = pd.read_csv(file_path, dtype={'geoid': str})
                
                # Add transportation data if not already included
                if 'travel_time_to_work_minutes' not in df.columns:
                    df = self._add_transportation_variables(df, geo_level)
                
                # Add tax credit data if not already included
                tax_credit_vars = ['ctc_avg_amount', 'ctc_participation_rate', 'federal_eitc_avg_amount', 
                                 'eitc_participation_rate', 'state_eitc_avg_amount']
                if not any(var in df.columns for var in tax_credit_vars):
                    df = self._add_tax_credit_variables(df, geo_level)
                
                logger.debug(f"Loaded ACS {geo_level.value} data: {df.shape}")
                return df
            except Exception as e:
                logger.error(f"Error loading ACS {geo_level.value} data from CSV: {e}")
        
        # If CSV doesn't exist or failed, fetch from API
        logger.info(f"Fetching ACS {geo_level.value} data from API")
        return self._fetch_from_api(geo_level)
    
    def _add_transportation_variables(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Transportation variables are now included in main ACS CSV files."""
        # Transportation data is now consolidated into main ACS files
        # No separate merging needed
        if 'travel_time_to_work_minutes' in df.columns:
            logger.info(f"Transportation variable already present in {geo_level.value} data")
        else:
            logger.warning(f"Transportation variable not found in {geo_level.value} data")
        
        return df
    
    def _add_tax_credit_variables(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Add tax credit variables to existing ACS data."""
        try:
            # Resolve path from data_sources.json so the year is not hardcoded here
            from src.data.data_source_registry import get_file_path as _fp
            level_map = {
                GeoLevel.STATE: 'state',
                GeoLevel.COUNTY: 'county',
                GeoLevel.HOUSE: 'house',
                GeoLevel.SENATE: 'senate',
            }
            level_key = level_map.get(geo_level)
            if level_key is None:
                logger.warning(f"Tax credit data not available for {geo_level.value}")
                return df
            tax_credit_file = _fp('tax_credits', level_key)
            
            if tax_credit_file.exists():
                logger.info(f"Loading tax credit data for {geo_level.value}")
                tax_credit_data = pd.read_csv(tax_credit_file, dtype={'geoid': str})
                
                if tax_credit_data is not None and not tax_credit_data.empty:
                    # Find geoid columns for merging
                    df_geoid_col = None
                    tax_credit_geoid_col = None
                    
                    for col in ['geoid', 'GEOID', 'geo_id']:
                        if col in df.columns:
                            df_geoid_col = col
                            break
                            
                    for col in ['geoid', 'GEOID', 'geo_id']:
                        if col in tax_credit_data.columns:
                            tax_credit_geoid_col = col
                            break
                    
                    # Fix geoid format for districts - convert 4-digit to 5-digit (e.g., 1501 -> 15001)
                    if tax_credit_geoid_col and geo_level in [GeoLevel.HOUSE, GeoLevel.SENATE]:
                        def fix_district_geoid(geoid_str):
                            geoid_str = str(geoid_str).strip()
                            if len(geoid_str) == 4:
                                # Insert '0' after first 2 digits: 1501 -> 15001
                                return geoid_str[:2] + '0' + geoid_str[2:]
                            return geoid_str
                        
                        tax_credit_data[tax_credit_geoid_col] = tax_credit_data[tax_credit_geoid_col].apply(fix_district_geoid)
                        logger.info(f"Fixed tax credit geoid format for {geo_level.value}: sample geoids {tax_credit_data[tax_credit_geoid_col].head(3).tolist()}")
                    
                    if df_geoid_col and tax_credit_geoid_col:
                        # Merge tax credit data with main DataFrame
                        df = pd.merge(df, tax_credit_data, on=df_geoid_col, how='left', suffixes=('', '_tax'))
                        
                        # Convert participation rates from decimal to percentage format
                        # (the CSVs carry 6 decimals, so 4 keep them all without float noise)
                        participation_rate_cols = ['ctc_participation_rate', 'eitc_participation_rate']
                        for col in participation_rate_cols:
                            if col in df.columns:
                                df[col] = (df[col] * 100).round(4)
                        
                        # Add tax credit variables to the DataFrame
                        tax_credit_vars = ['ctc_avg_amount', 'ctc_participation_rate', 'federal_eitc_avg_amount', 
                                         'eitc_participation_rate', 'state_eitc_avg_amount']
                        added_vars = []
                        for var in tax_credit_vars:
                            if var in tax_credit_data.columns:
                                added_vars.append(var)
                        
                        if added_vars:
                            logger.info(f"Successfully added tax credit variables: {added_vars}")
                            logger.info(f"Added {len(added_vars)} tax credit variables to {len(df)} {geo_level.value} records")
                        else:
                            logger.warning(f"No tax credit variables found in {tax_credit_file}")
                    else:
                        logger.warning(f"Cannot merge tax credit data - df_geoid: {df_geoid_col}, tax_credit_geoid: {tax_credit_geoid_col}")
                else:
                    logger.warning(f"Invalid tax credit data for {geo_level.value}")
            else:
                logger.warning(f"Tax credit data file not found: {tax_credit_file}")
                
        except Exception as e:
            logger.error(f"Error adding tax credit variables: {e}")
        
        return df
    
    def _fetch_from_api(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Fetch ACS data directly from API."""
        try:
            # This would implement full API fetching if needed
            logger.warning(f"API fetching not fully implemented for {geo_level.value}")
            return None
        except Exception as e:
            logger.error(f"Error fetching ACS data from API: {e}")
            return None


class ALICEDataLoader(BaseDataLoader):
    """Loader for ALICE (Asset Limited, Income Constrained, Employed) data."""
    
    def load_data(self, geo_level: Union[GeoLevel, str]) -> Optional[pd.DataFrame]:
        """Load ALICE data for a geographic level."""
        try:
            # Convert string geo_level to GeoLevel enum if needed
            if isinstance(geo_level, str):
                try:
                    geo_level = GeoLevel(geo_level.lower())
                except ValueError:
                    logger.error(f"Invalid geographic level for ALICE: {geo_level}")
                    return None
                    
            if not self._validate_geo_level(geo_level):
                logger.error(f"Unsupported geographic level for ALICE: {geo_level}")
                return None
            
            # data/ALICE By Geography (<year>).xlsx, the year set in
            # src/config/data_sources.json (built by scripts/build_alice.py)
            alice_file = get_alice_excel_path()
            if not alice_file.exists():
                logger.error(f"ALICE data file not found: {alice_file}")
                return None
            
            try:
                # First, check what sheets are available
                import openpyxl
                wb = openpyxl.load_workbook(alice_file, read_only=True)
                available_sheets = wb.sheetnames
                logger.info(f"Available sheets in ALICE file: {available_sheets}")
                wb.close()
                
                sheet_name = self.config.sheet_patterns[geo_level.value]
                logger.info(f"Looking for sheet: {sheet_name}")
                
                if sheet_name not in available_sheets:
                    logger.error(f"Sheet '{sheet_name}' not found. Available sheets: {available_sheets}")
                    # Try to find a similar sheet name
                    for sheet in available_sheets:
                        if sheet.lower() == sheet_name.lower():
                            logger.info(f"Found case-insensitive match: {sheet}")
                            sheet_name = sheet
                            break
                    else:
                        return None
                
                df = pd.read_excel(alice_file, sheet_name=sheet_name)
                logger.info(f"Successfully read Excel sheet. Shape: {df.shape}")
                logger.info(f"Columns: {df.columns.tolist()}")
                
                df = self._standardize_alice_data(df, geo_level)
                logger.info(f"Loaded ALICE {geo_level.value} data: {df.shape}")
                return df
                
            except Exception as e:
                logger.error(f"Error reading Excel file {alice_file}: {e}", exc_info=True)
                return None
        
        except Exception as e:
            logger.error(f"Error in load_data for ALICE: {str(e)}", exc_info=True)
            # Create fallback dummy data to prevent app from breaking
            logger.warning("Creating fallback ALICE data with default values")
            return self._create_fallback_alice_data(geo_level)
    
    def _standardize_alice_data(self, df: pd.DataFrame, geo_level: Union[GeoLevel, str]) -> pd.DataFrame:
        """Standardize ALICE data columns and identifiers."""
        if df is None or df.empty:
            logger.warning("Empty or None DataFrame passed to _standardize_alice_data")
            return pd.DataFrame()
            
        df = df.copy()
        logger.info(f"Standardizing ALICE data. Initial columns: {df.columns.tolist()}")
        logger.info(f"First few rows of data:\n{df.head()}")
        
        # Standardize ALICE rate column - handle both percentage and decimal formats
        alice_cols = [
            'Percentage of Households Under ALICE Threshold',
            'ALICE Rate',
            'alice_rate',
            'pct_alice_households',
            'alice_household_percentage',  # Additional possible column name
            'alice_households'             # Additional possible column name
        ]
        
        alice_rate_found = False
        for col in alice_cols:
            if col in df.columns:
                logger.info(f"Found ALICE rate column: {col}")
                logger.info(f"Values in {col}: {df[col].head().to_list()}")
                
                # Handle potential string percentages (e.g., '35%')
                if df[col].dtype == 'object':
                    try:
                        # Try to convert string percentages to float
                        df[col] = df[col].astype(str).str.rstrip('%').astype('float') / 100.0
                        logger.info(f"Converted string percentage to float: {df[col].head().to_list()}")
                    except (ValueError, TypeError) as e:
                        logger.warning(f"Could not convert column {col} to float: {e}")
                        continue
                
                # Convert to percentage if it's a decimal (0-1)
                if df[col].max() <= 1.0:
                    df['alice_rate'] = df[col] * 100
                    logger.info(f"Converted decimal to percentage (x100): {df['alice_rate'].head().to_list()}")
                else:
                    # If it's already a percentage, ensure it's not > 100 (might be 0-100 scale)
                    if df[col].max() > 100:
                        df['alice_rate'] = df[col]  # Already in percentage format
                        logger.info(f"Using values as-is (already percentage): {df['alice_rate'].head().to_list()}")
                    else:
                        df['alice_rate'] = df[col]  # Already in 0-100 format
                        logger.info(f"Using values as 0-100 percentage: {df['alice_rate'].head().to_list()}")
                
                alice_rate_found = True
                logger.info(f"Final alice_rate values: {df['alice_rate'].head().to_list()}")
                break
                
        if not alice_rate_found:
            logger.warning(f"No recognized ALICE rate column found in: {df.columns.tolist()}")
            logger.warning("Available columns: " + ", ".join(df.columns.tolist()))
            df['alice_rate'] = 0  # Default to 0 if no ALICE data found
        
        # Add geographic identifiers based on level
        if isinstance(geo_level, str):
            geo_level = geo_level.lower()
            
            if geo_level == 'state':
                df = self._standardize_state_alice(df)
            elif geo_level == 'county':
                df = self._standardize_county_alice(df)
            elif geo_level == 'house':
                df = self._standardize_house_alice(df)
            elif geo_level == 'senate':
                df = self._standardize_senate_alice(df)
        else:
            standardizers = {
                GeoLevel.STATE: self._standardize_state_alice,
                GeoLevel.COUNTY: self._standardize_county_alice,
                GeoLevel.HOUSE: self._standardize_house_alice,
                GeoLevel.SENATE: self._standardize_senate_alice
            }
            
            standardizer = standardizers.get(geo_level)
            if standardizer:
                df = standardizer(df)
        
        # Ensure we have a geoid column for merging
        if 'geoid' not in df.columns and 'GEOID' in df.columns:
            df['geoid'] = df['GEOID']
            
        return df
    
    def _standardize_state_alice(self, df: pd.DataFrame) -> pd.DataFrame:
        """Standardize state-level ALICE data."""
        df['name'] = 'Hawaii'
        df['display_name'] = 'Hawaii'
        return df
    
    def _standardize_county_alice(self, df: pd.DataFrame) -> pd.DataFrame:
        """Standardize county-level ALICE data."""
        if 'County' in df.columns:
            df['name'] = df['County']
            df['display_name'] = df['County']
        return df
    
    def _standardize_house_alice(self, df: pd.DataFrame) -> pd.DataFrame:
        """Standardize house district ALICE data."""
        if 'District' in df.columns:
            df['district'] = df['District'].astype(int)
            df['display_name'] = df['District'].apply(lambda x: f"House District {x}")
        return df
    
    def _standardize_senate_alice(self, df: pd.DataFrame) -> pd.DataFrame:
        """Standardize senate district ALICE data."""
        if 'Senate District' in df.columns:
            df['district'] = df['Senate District'].astype(int)
            df['display_name'] = df['Senate District'].apply(lambda x: f"Senate District {x}")
        return df
    
    def _create_fallback_alice_data(self, geo_level: GeoLevel) -> pd.DataFrame:
        """Create fallback ALICE data when the Excel file can't be loaded."""
        logger.warning(f"Creating fallback ALICE data for {geo_level.value}")
        
        # Create basic structure based on geo level
        if geo_level == GeoLevel.STATE:
            data = [{
                'name': 'Hawaii',
                'geoid': '15',
                'alice_rate': 35.0  # Default ALICE rate for Hawaii
            }]
        elif geo_level == GeoLevel.COUNTY:
            data = [
                {'name': 'Honolulu County, Hawaii', 'geoid': '15003', 'alice_rate': 33.0},
                {'name': 'Hawaii County, Hawaii', 'geoid': '15001', 'alice_rate': 38.0},
                {'name': 'Maui County, Hawaii', 'geoid': '15009', 'alice_rate': 36.0},
                {'name': 'Kauai County, Hawaii', 'geoid': '15007', 'alice_rate': 34.0}
            ]
        else:
            # For districts, create minimal data structure
            data = [{
                'name': f'District {i}',
                'geoid': f'15{str(i).zfill(3)}',
                'alice_rate': 35.0
            } for i in range(1, 52)]  # Hawaii has 51 house districts, 25 senate districts
        
        df = pd.DataFrame(data)
        logger.info(f"Created fallback ALICE data with {len(df)} rows")
        return df


class SNAPDataLoader(BaseDataLoader):
    """Loader for SNAP (Supplemental Nutrition Assistance Program) data."""
    
    def load_data(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Load SNAP data for a geographic level."""
        if not self._validate_geo_level(geo_level):
            logger.error(f"Invalid geographic level for SNAP: {geo_level}")
            return None
        
        # data_dir already points to snap_benefits directory, don't add it again
        file_path = self.data_dir / self.config.file_patterns[geo_level.value]
        if not file_path.exists():
            logger.error(f"SNAP data file not found: {file_path}")
            return None
        
        try:
            df = pd.read_csv(file_path, dtype={'geoid': str})
            df = self._standardize_snap_data(df, geo_level)
            logger.debug(f"Loaded SNAP {geo_level.value} data: {df.shape}")
            return df
        except Exception as e:
            logger.error(f"Error loading SNAP {geo_level.value} data: {e}")
            return None
    
    def _standardize_snap_data(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Standardize SNAP data format."""
        df = df.copy()
        
        # Add geoid for counties if missing
        if geo_level == GeoLevel.COUNTY and ('geoid' not in df.columns or df['geoid'].isna().all()):
            county_mapping = {
                'HAWAII': '15001',
                'HONOLULU': '15003',
                'KAUAI': '15007',
                'MAUI': '15009'
            }
            if 'NAME' in df.columns:
                df['geoid'] = df['NAME'].str.strip().str.upper().map(county_mapping)
                logger.info(f"Added geoid column to county SNAP data based on NAME column")
        
        # Fix geoid format for districts
        if geo_level in [GeoLevel.HOUSE, GeoLevel.SENATE] and 'geoid' in df.columns:
            df['geoid'] = df['geoid'].apply(self._fix_geoid)
        
        # Convert percentages from decimal to percentage format
        percentage_cols = ['snap_household_rate', 'snap_participation_rate']
        for col in percentage_cols:
            if col in df.columns:
                df[col] = df[col] * 100
        
        return df
    
    def _fix_geoid(self, geoid_str: str) -> str:
        """Fix geoid format for districts."""
        geoid_str = str(geoid_str).strip()
        
        # Handle house district format (e.g., 'H1' -> '15001')
        if geoid_str.startswith('H'):
            try:
                district_num = int(geoid_str[1:])
                return f'15{district_num:03d}'
            except (ValueError, IndexError):
                pass
        
        # Handle senate district format (e.g., 'S1' -> '150001')
        elif geoid_str.startswith('S'):
            try:
                district_num = int(geoid_str[1:])
                return f'15{district_num:03d}'
            except (ValueError, IndexError):
                pass
        
        # Handle numeric district IDs 
        elif geoid_str.isdigit():
            if len(geoid_str) == 4:  # State + 2-digit district (e.g., '1501' -> '15001')
                return f'15{geoid_str[2:].zfill(3)}'
            elif len(geoid_str) == 5:  # Already correct format (e.g., '15001')
                return geoid_str
            elif len(geoid_str) == 6:  # Extra prefix format (e.g., '151501' -> '15001')
                if geoid_str.startswith('1515'):
                    return f'15{geoid_str[4:].zfill(3)}'
                elif geoid_str.startswith('15'):
                    return geoid_str[2:]  # Remove extra '15' prefix
        
        # Handle existing FIPS patterns
        if len(geoid_str) == 4 and geoid_str.startswith('15'):
            return geoid_str[:2] + '0' + geoid_str[2:]
        elif len(geoid_str) == 5 and geoid_str.startswith('0'):
            return '15' + geoid_str[3:]
            
        return geoid_str


class MedicaidDataLoader(BaseDataLoader):
    """Loader for Medicaid enrollment data (MedQuest, ACS-calibrated).

    Reads the per-level CSVs written by scripts/build_medicaid_2024.py into
    data/processed/medicaid/. Kept independent of the ACS loader so an ACS
    refresh can never silently drop the medicaid columns.
    """

    def load_data(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Load Medicaid data for a geographic level."""
        if not self._validate_geo_level(geo_level):
            logger.error(f"Invalid geographic level for Medicaid: {geo_level}")
            return None

        # data_dir already points to the medicaid/ directory.
        file_path = self.data_dir / self.config.file_patterns[geo_level.value]
        if not file_path.exists():
            logger.error(f"Medicaid data file not found: {file_path}")
            return None

        try:
            df = pd.read_csv(file_path, dtype={'geoid': str})
            df = self._standardize_medicaid_data(df, geo_level)
            logger.debug(f"Loaded Medicaid {geo_level.value} data: {df.shape}")
            return df
        except Exception as e:
            logger.error(f"Error loading Medicaid {geo_level.value} data: {e}")
            return None

    def _standardize_medicaid_data(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Standardize Medicaid data for merging.

        County rows are matched by uppercase NAME (the same key SNAP uses);
        the detail CSV carries the island/county name in a `county` column,
        so expose it as NAME. District rows merge by geoid (already present).
        medicaid_rate is already on a 0-100 scale (like poverty_rate), so no
        rescaling is applied.
        """
        df = df.copy()
        if geo_level == GeoLevel.COUNTY and 'county' in df.columns and 'NAME' not in df.columns:
            df['NAME'] = df['county'].astype(str).str.strip().str.upper()
        return df


class CEPDataLoader(BaseDataLoader):
    """Loader for Community Eligibility Provision (CEP) data."""
    
    def load_data(self, geo_level: GeoLevel) -> Optional[pd.DataFrame]:
        """Load CEP data for a geographic level."""
        if not self._validate_geo_level(geo_level):
            logger.error(f"Invalid geographic level for CEP: {geo_level}")
            return None
        
        # For state level, aggregate from county data
        if geo_level == GeoLevel.STATE:
            return self._aggregate_state_cep_from_counties()
        
        file_path = self.data_dir / self.config.file_patterns[geo_level.value]
        if not file_path.exists():
            logger.error(f"CEP data file not found: {file_path}")
            return None
        
        try:
            # Read the CSV file
            df = pd.read_csv(file_path)
            
            # Standardize the data
            df = self._standardize_cep_data(df, geo_level)
            
            # Add geoid based on district number
            df = self._add_geoid(df, geo_level)
            
            logger.info(f"Loaded CEP {geo_level.value} data: {df.shape}")
            return df
            
        except Exception as e:
            logger.error(f"Error loading CEP {geo_level.value} data: {e}", exc_info=True)
            return None
    
    def _aggregate_state_cep_from_counties(self) -> Optional[pd.DataFrame]:
        """Aggregate county-level CEP data to create state-level data."""
        try:
            # Load county-level CEP data
            county_file = self.data_dir / self.config.file_patterns['county']
            if not county_file.exists():
                logger.error(f"County CEP data file not found: {county_file}")
                return None
            
            county_df = pd.read_csv(county_file)
            
            # Aggregate totals
            total_schools = county_df['total_schools'].sum()
            cep_schools = county_df['cep_schools'].sum()
            cep_percentage = (cep_schools / total_schools * 100) if total_schools > 0 else 0
            
            # Create state-level dataframe
            state_df = pd.DataFrame([{
                'geoid': '15',
                'NAME': 'Hawaii',
                'total_schools': total_schools,
                'cep_schools': cep_schools,
                'cep_percentage': cep_percentage,
                'cep_display': f"{int(cep_schools)}/{int(total_schools)} CEP schools"
            }])
            
            logger.info(f"Aggregated state CEP data: {cep_schools}/{total_schools} schools ({cep_percentage:.1f}%)")
            return state_df
            
        except Exception as e:
            logger.error(f"Error aggregating state CEP data: {e}", exc_info=True)
            return None
    
    def _add_geoid(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Add geoid column based on district number or county name."""
        df = df.copy()
        
        if 'geoid' in df.columns:
            return df
        
        # Handle county-level data (uses 'county' field instead of 'district')
        if geo_level == GeoLevel.COUNTY and 'county' in df.columns:
            county_codes = {
                'Hawaii': '15001',
                'Honolulu': '15003',
                'Kauai': '15007',
                'Maui': '15009'
            }
            df['geoid'] = df['county'].map(county_codes)
            
            # Add NAME field for consistency with other data sources
            if 'NAME' not in df.columns:
                df['NAME'] = df['county'] + ' County, Hawaii'
            
            return df
            
        # Extract district number from district code (e.g., 'H01' -> 1, '1' -> 1)
        if 'district' in df.columns:
            df['district_num'] = df['district'].str.extract(r'(\d+)').astype(int)
            
            # Create geoid based on geographic level
            if geo_level == GeoLevel.HOUSE:
                # For house districts: 15 + 3-digit district number (e.g., 15001, 15051)
                df['geoid'] = '15' + df['district_num'].astype(str).str.zfill(3)
            elif geo_level == GeoLevel.SENATE:
                # For senate districts: 15 + 3-digit district number (same as house for now)
                df['geoid'] = '15' + df['district_num'].astype(str).str.zfill(3)
            
            # Add NAME field for consistency with other data sources
            if 'NAME' not in df.columns:
                if geo_level == GeoLevel.HOUSE:
                    df['NAME'] = 'State House District ' + df['district'].str.replace('H', '')
                elif geo_level == GeoLevel.SENATE:
                    df['NAME'] = 'State Senate District ' + df['district']
        
        return df
    
    def _standardize_cep_data(self, df: pd.DataFrame, geo_level: GeoLevel) -> pd.DataFrame:
        """Standardize CEP data format."""
        df = df.copy()
        
        # Ensure district code is in the expected format
        if 'district' in df.columns:
            df['district'] = df['district'].astype(str).str.strip()
            
            # Convert to standard format (e.g., '1' -> 'H01' for house districts)
            if geo_level == GeoLevel.HOUSE and df['district'].str.match(r'^\d+$').all():
                df['district'] = 'H' + df['district'].str.zfill(2)
        
        # Ensure numeric columns are properly typed
        numeric_cols = ['total_schools', 'cep_schools', 'cep_percentage']
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce')
        
        # Calculate any derived fields if needed
        if 'cep_percentage' not in df.columns and 'cep_schools' in df.columns and 'total_schools' in df.columns:
            df['cep_percentage'] = (df['cep_schools'] / df['total_schools']) * 100
        
        if 'cep_display' not in df.columns and 'cep_schools' in df.columns and 'total_schools' in df.columns:
            df['cep_display'] = df.apply(
                lambda x: f"{int(x['cep_schools'])}/{int(x['total_schools'])} CEP schools",
                axis=1
            )
        
        # Add state FIPS code for consistency
        df['state'] = '15'
        
        return df


class GeoJSONProcessor:
    """Handles GeoJSON processing and data merging."""
    
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir
        self.geojson_configs = {
            GeoLevel.STATE: {
                'file': 'hawaii_state_boundary.geojson',
                'id_field': 'GEOID',
                'converter': lambda x: '15'
            },
            GeoLevel.COUNTY: {
                'file': 'hawaii_county_boundaries.geojson',
                'id_field': 'GEOID',
                'converter': self._convert_county_to_fips
            },
            GeoLevel.HOUSE: {
                'file': 'Hawaii_State_House_Districts_2022.geojson',
                'id_field': 'GEOID',
                'converter': lambda x: '15' + str(x).replace('H', '').zfill(3)
            },
            GeoLevel.SENATE: {
                'file': 'Hawaii_State_Senate_Districts_2022.geojson',
                'id_field': 'GEOID',
                'converter': lambda x: '15' + str(x).replace('S', '').zfill(3)
            }
        }
    
    def get_geojson_path(self, geo_level: GeoLevel) -> Optional[Path]:
        """Get path to GeoJSON file for geographic level."""
        config = self.geojson_configs.get(geo_level)
        if not config:
            return None
        
        geojson_dir = self.base_dir / 'data' / 'Processed GeoJsons'
        geojson_path = geojson_dir / config['file']
        
        return geojson_path if geojson_path.exists() else None
    
    def merge_geojson_with_data(self, geojson_data: dict, data: pd.DataFrame,
                               geo_level: GeoLevel) -> dict:
        """Merge GeoJSON with data DataFrame."""
        if data is None or data.empty:
            logger.warning(f"No data available for merging with {geo_level.value} GeoJSON")
            return geojson_data
        
        # Standardize GeoJSON IDs
        geojson_data = self._standardize_geojson_ids(geojson_data, geo_level)
        
        # Merge data into features
        for feature in geojson_data.get('features', []):
            properties = feature.get('properties', {})
            matching_data = self._find_matching_data(properties, data, geo_level)
            
            if matching_data:
                self._add_data_to_properties(properties, matching_data)
        
        return geojson_data
    
    def _standardize_geojson_ids(self, geojson_data: dict, geo_level: GeoLevel) -> dict:
        """Standardize ID fields in GeoJSON data."""
        config = self.geojson_configs.get(geo_level)
        if not config:
            return geojson_data
        
        # Find the appropriate source field
        source_field = self._find_source_field(geojson_data, geo_level)
        if not source_field:
            return geojson_data
        
        # Convert IDs for each feature
        for feature in geojson_data.get('features', []):
            props = feature.get('properties', {})
            if source_field in props:
                try:
                    source_id = props[source_field]
                    target_id = config['converter'](source_id)
                    props[config['id_field']] = target_id
                    props['geoid'] = target_id
                except Exception as e:
                    logger.error(f"Error converting ID for {geo_level.value}: {e}")
        
        return geojson_data
    
    def _find_source_field(self, geojson_data: dict, geo_level: GeoLevel) -> Optional[str]:
        """Find the source field for ID conversion."""
        features = geojson_data.get('features', [])
        if not features:
            return None
        
        props = features[0].get('properties', {})
        
        field_mappings = {
            GeoLevel.STATE: ['state_fips'],
            GeoLevel.COUNTY: ['county_name'],
            GeoLevel.HOUSE: ['state_house', 'STATE_HOUSE', 'house_id', 'DISTRICT', 'district'],
            GeoLevel.SENATE: ['state_senate', 'STATE_SENATE', 'senate_id', 'DISTRICT', 'district']
        }
        
        possible_fields = field_mappings.get(geo_level, [])
        for field in possible_fields:
            if field in props:
                return field
        
        return None
    
    def _convert_county_to_fips(self, county_name: str) -> str:
        """Convert county name to FIPS code."""
        county_map = {
            'oahu': '15003',
            'honolulu': '15003',
            'hawaii': '15001',
            'maui': '15009',
            'kauai': '15007',
            'kalawao': '15005'
        }
        
        county_name = str(county_name).lower()
        for pattern, fips in county_map.items():
            if pattern in county_name:
                return fips
        
        return '15000'  # Default for unknown county
    
    def _find_matching_data(self, properties: dict, data: pd.DataFrame,
                           geo_level: GeoLevel) -> Optional[dict]:
        """Find matching data row for GeoJSON feature."""
        if geo_level == GeoLevel.STATE and len(data) > 0:
            return data.iloc[0].to_dict()
        
        if geo_level == GeoLevel.COUNTY:
            return self._find_county_match(properties, data)
        
        if geo_level in [GeoLevel.HOUSE, GeoLevel.SENATE]:
            return self._find_district_match(properties, data)
        
        return None
    
    def _find_county_match(self, properties: dict, data: pd.DataFrame) -> Optional[dict]:
        """Find matching county data."""
        county_name = properties.get('county_name', properties.get('NAME', ''))
        
        # Try direct matching strategies
        strategies = [
            ('NAME', county_name),
            ('NAME', f"{county_name} County, Hawaii"),
        ]
        
        # Special case for Oahu/Honolulu
        if 'oahu' in county_name.lower():
            strategies.extend([
                ('NAME', 'Honolulu County, Hawaii'),
                ('NAME', 'Honolulu')
            ])
        
        for col, value in strategies:
            if col in data.columns:
                matches = data[data[col].str.lower() == value.lower()]
                if len(matches) > 0:
                    return matches.iloc[0].to_dict()
        
        return None
    
    def _find_district_match(self, properties: dict, data: pd.DataFrame) -> Optional[dict]:
        """Find matching district data with improved matching logic."""
        # Try to get district number from various possible property names
        district_num = None
        
        # Check for common district ID fields in properties
        for field in ['DISTRICT', 'house_id', 'senate_id', 'district', 'DISTRICT_NUM', 'DISTRICT_ID']:
            if field in properties and properties[field] is not None:
                district_num = str(properties[field]).strip()
                break
        
        if not district_num:
            return None
        
        # Clean up the district number (remove any non-numeric prefixes/suffixes)
        import re
        match = re.search(r'\d+', district_num)
        if match:
            district_num = match.group(0)
        
        # Try to match on various possible column names
        possible_columns = [
            'district', 
            'state legislative district (lower chamber)',
            'state legislative district (upper chamber)',
            'state_house',
            'state_senate',
            'house_district',
            'senate_district',
            'geoid',
            'GEOID',
            'id',
            'ID',
            'fips',
            'FIPS'
        ]
        
        # First try exact matches
        for col in possible_columns:
            if col in data.columns:
                # Convert to string and strip whitespace for comparison
                data_col = data[col].astype(str).str.strip()
                matches = data[data_col == district_num]
                if len(matches) > 0:
                    return matches.iloc[0].to_dict()
        
        # If no exact match, try partial matches (e.g., '1' matches 'H1' or 'S1')
        for col in possible_columns:
            if col in data.columns:
                # Convert to string and extract numbers for comparison
                data_col = data[col].astype(str).str.extract(r'(\d+)')[0]
                matches = data[data_col == district_num]
                if len(matches) > 0:
                    return matches.iloc[0].to_dict()
        
        # If still no match, try to match the last 1-3 digits of GEOID
        if 'geoid' in data.columns:
            try:
                # Try to match the last 1-3 digits of the GEOID
                data['geoid_str'] = data['geoid'].astype(str).str.strip()
                matches = data[data['geoid_str'].str.endswith(district_num)]
                if len(matches) > 0:
                    return matches.iloc[0].to_dict()
                
                # Try to match just the district number part
                data['district_part'] = data['geoid_str'].str.extract(r'(\d{1,3})$')
                matches = data[data['district_part'] == district_num]
                if len(matches) > 0:
                    return matches.iloc[0].to_dict()
            except Exception as e:
                logger.warning(f"Error matching district by GEOID: {e}")
        
        logger.warning(f"Could not find matching district data for district_num: {district_num}")
        return None
    
    def _add_data_to_properties(self, properties: dict, data: dict):
        """Add data to GeoJSON feature properties."""
        for key, value in data.items():
            if key not in ['index', 'level_0'] and value is not None:
                if pd.isna(value):
                    properties[key] = None
                else:
                    properties[key] = value


class DataLoader:
    """Main data loader class that coordinates all data sources."""
    
    def __init__(self, data_dir: str = 'data/processed'):
        """Initialize the data loader."""
        self.base_dir = Path(__file__).parent.parent.parent
        self.data_dir = self.base_dir / data_dir
        self.data_cache = {}
        self._merged_cache = {}  # Cache merged DataFrames to avoid re-merging on every call
        
        # Initialize data loaders
        self._init_data_loaders()
        
        # Skip preloading for cloud performance - load on demand instead
        # self._preload_data()
        self.merger = DataMerger(self._get_geo_name_mapping())
        self.geojson_processor = GeoJSONProcessor(self.base_dir)
        
        # Available variables for the dashboard
        self.available_variables = self._get_available_variables()
    
    def _init_data_loaders(self):
        """Initialize data loaders — file patterns come from data_sources.json."""
        from src.data.data_source_registry import get_file_path as _fp, get_alice_excel_path as _alice_path

        def _patterns(source: str) -> dict:
            """Return {level: filename_only} for a given source."""
            return {
                lvl: _fp(source, lvl).name
                for lvl in ('state', 'county', 'house', 'senate')
            }

        # ACS data — year-stamped filenames resolved from data_sources.json
        acs_config = DataConfig(_patterns('acs'))

        # ALICE data — Excel workbook; sheet names are fixed
        alice_config = DataConfig(
            file_patterns={},
            sheet_patterns={
                'state': 'State',
                'county': 'Counties',
                'house': 'House',
                'senate': 'Senate'
            }
        )

        # SNAP data — year-stamped filenames resolved from data_sources.json
        snap_config = DataConfig(_patterns('snap'))

        # CEP data — filenames resolved from data_sources.json
        cep_config = DataConfig(_patterns('cep'))

        # Medicaid data — year-stamped filenames resolved from data_sources.json
        medicaid_config = DataConfig(_patterns('medicaid'))

        # Initialize loaders
        self.acs_loader = ACSDataLoader(self.data_dir, acs_config)
        self.alice_loader = ALICEDataLoader(self.data_dir / 'alice', alice_config)
        self.snap_loader = SNAPDataLoader(self.data_dir / 'snap_benefits', snap_config)
        self.cep_loader = CEPDataLoader(self.data_dir / 'cep_schools', cep_config)
        self.medicaid_loader = MedicaidDataLoader(self.data_dir / 'medicaid', medicaid_config)

        # Map data types to their loaders
        self.loaders = {
            DataType.ACS: self.acs_loader,
            DataType.ALICE: self.alice_loader,
            DataType.SNAP: self.snap_loader,
            DataType.CEP: self.cep_loader,
            DataType.MEDICAID: self.medicaid_loader,
        }
    
    def _get_geo_name_mapping(self) -> Dict[str, Dict[str, str]]:
        """Get geographic name mappings."""
        return {
            'county': {
                'Honolulu': 'Oahu',
                'Hawaii': 'Hawaii',
                'Maui': 'Maui',
                'Kauai': 'Kauai'
            }
        }
    
    def _get_available_variables(self) -> Dict[str, str]:
        """Get available variables and their display names from the centralized registry."""
        return get_available_variables()
    
    def _preload_data(self):
        """Preload all data at initialization."""
        for geo_level in GeoLevel:
            for data_type in DataType:
                try:
                    self._load_and_cache_data(data_type, geo_level)
                except Exception as e:
                    logger.error(f"Error preloading {data_type.value} {geo_level.value} data: {e}")
    
    def _load_and_cache_data(self, data_type: DataType, geo_level: GeoLevel):
        """Load and cache data for a specific type and geographic level."""
        cache_key = f"{data_type.value}_{geo_level.value}"
        
        if cache_key not in self.data_cache:
            loader = self.loaders.get(data_type)
            if loader:
                data = loader.load_data(geo_level)
                
                self.data_cache[cache_key] = data
    
    def get_data(self, geo_level: str) -> Optional[pd.DataFrame]:
        """Get combined data for a geographic level."""
        # Return cached merged result if available (avoids re-merging 4 datasets)
        if geo_level in self._merged_cache:
            return self._merged_cache[geo_level].copy()

        geo_enum = GeoLevel(geo_level)

        # Load data on-demand if not cached
        for data_type in DataType:
            cache_key = f"{data_type.value}_{geo_level}"
            if cache_key not in self.data_cache:
                self._load_and_cache_data(data_type, geo_enum)

        # Get individual datasets
        acs_data = self.data_cache.get(f"{DataType.ACS.value}_{geo_level}")
        alice_data = self.data_cache.get(f"{DataType.ALICE.value}_{geo_level}")
        snap_data = self.data_cache.get(f"{DataType.SNAP.value}_{geo_level}")
        cep_data = self.data_cache.get(f"{DataType.CEP.value}_{geo_level}")
        medicaid_data = self.data_cache.get(f"{DataType.MEDICAID.value}_{geo_level}")

        # Start with ACS data as base
        merged_data = acs_data.copy() if acs_data is not None else None

        # Merge additional datasets
        if merged_data is not None and alice_data is not None:
            merged_data = self.merger.merge_datasets(merged_data, alice_data, geo_enum, DataType.ALICE)
        elif merged_data is not None and alice_data is None:
            # ALICE load failed or unavailable — still initialize columns so GeoJSON
            # properties always contain alice_rate (as None) rather than missing entirely.
            self.merger._initialize_columns_by_type(merged_data, DataType.ALICE)

        if merged_data is not None and snap_data is not None:
            logger.debug(f"Merging SNAP data for {geo_level}, shape: {snap_data.shape}")
            merged_data = self.merger.merge_datasets(merged_data, snap_data, geo_enum, DataType.SNAP)
            logger.debug(f"After SNAP merge, shape: {merged_data.shape}")

        if merged_data is not None and cep_data is not None:
            logger.debug(f"Merging CEP data for {geo_level}, shape: {cep_data.shape}")
            merged_data = self.merger.merge_datasets(merged_data, cep_data, geo_enum, DataType.CEP)
            logger.debug(f"After CEP merge, shape: {merged_data.shape}")

        if merged_data is not None and medicaid_data is not None:
            logger.debug(f"Merging Medicaid data for {geo_level}, shape: {medicaid_data.shape}")
            merged_data = self.merger.merge_datasets(merged_data, medicaid_data, geo_enum, DataType.MEDICAID)
            logger.debug(f"After Medicaid merge, shape: {merged_data.shape}")
        elif merged_data is not None and medicaid_data is None:
            # Medicaid load failed/unavailable — still initialize columns so the
            # GeoJSON always carries medicaid_rate (as None) rather than missing it.
            self.merger._initialize_columns_by_type(merged_data, DataType.MEDICAID)

        # Cache the merged result for subsequent calls
        if merged_data is not None:
            self._merged_cache[geo_level] = merged_data

        return merged_data
    
    def get_all_data_for_geo(self, geo_id: str) -> Dict[str, Any]:
        """Get all available data for a specific geography ID."""
        result = {
            "id": geo_id,
            "name": "",
            "demographics": {},
            "economic": {},
            "housing": {},
            "snap": {},
            "tax_credits": {}
        }
        
        print(f"\n=== DEBUG: Getting data for geo_id: {geo_id} ===")
        
        try:
            geo_level = self._determine_geo_level(geo_id)
            if not geo_level:
                logger.warning(f"Could not determine geo level for ID: {geo_id}")
                return result
                
            print(f"DEBUG: Determined geo_level: {geo_level}")
            
            # Convert prefixed ID to numeric geoid for data matching
            numeric_geoid = self._convert_to_numeric_geoid(geo_id, geo_level)
            print(f"DEBUG: Converted {geo_id} to numeric geoid: {numeric_geoid}")
            
            # Get merged data for the geographic level
            data = self.get_data(geo_level.value)
            if data is None or data.empty:
                logger.warning(f"No data available for {geo_level.value}")
                return result
                
            print(f"DEBUG: Loaded data with {len(data)} rows and columns: {data.columns.tolist()}")
            
            # Find the specific geography using numeric geoid
            print(f"\nDEBUG: Looking for numeric geoid: {numeric_geoid} in data")
            print(f"DEBUG: First 10 geoids: {data['geoid'].head(10).tolist() if 'geoid' in data.columns else 'No geoid column'}")
            
            # Try exact match with numeric geoid
            geo_row = data[data['geoid'].astype(str) == str(numeric_geoid)]
            
            # If no exact match, try more flexible matching ONLY for districts (not state)
            if geo_row.empty and geo_level in [GeoLevel.HOUSE, GeoLevel.SENATE]:
                print(f"DEBUG: No exact match for {numeric_geoid}, trying flexible matching...")
                # Try matching just the district number part
                district_num = str(numeric_geoid)[-3:] if len(str(numeric_geoid)) >= 3 else str(numeric_geoid)
                print(f"DEBUG: Trying to match district number: {district_num}")
                
                # Try matching the last 3 digits of the geoid
                data['geoid_str'] = data['geoid'].astype(str)
                geo_row = data[data['geoid_str'].str.endswith(district_num)]
                
                # If still no match, try extracting just the numeric part
                if geo_row.empty:
                    print("DEBUG: Trying to extract numeric part from geoid")
                    data['district_num'] = data['geoid_str'].str.extract(r'(\d{1,3})$')
                    geo_row = data[data['district_num'] == district_num]
            elif geo_row.empty and geo_level == GeoLevel.STATE:
                # For state level, we should only have one row
                print(f"DEBUG: State level - using first row of data")
                if len(data) > 0:
                    geo_row = data.iloc[[0]]  # Get first row as DataFrame
            
            if geo_row.empty:
                logger.warning(f"No data found for geography ID: {geo_id}")
                print(f"DEBUG: Could not find geo_id: {geo_id} in data")
                print(f"DEBUG: Sample of available geoids: {data['geoid'].head().tolist() if 'geoid' in data.columns else 'No geoid column'}")
                return result
                
            print(f"\nDEBUG: Found {len(geo_row)} matching row(s).")
            print(f"DEBUG: Matching row data: {geo_row.iloc[0].to_dict() if not geo_row.empty else 'No data'}")
            
            # Log available columns for debugging
            if not geo_row.empty:
                print("\nDEBUG: Available columns in the matched row:")
                for col in sorted(geo_row.columns):
                    if col not in ['geoid', 'geoid_str', 'district_num']:  # Skip debug columns
                        print(f"  - {col}: {geo_row[col].values[0] if col in geo_row.columns else 'N/A'}")
            
            geo_row = geo_row.iloc[0]
            result = self._build_geography_result(result, geo_row)
            
            # Debug the built result
            print("\nDEBUG: Built result structure:")
            for key, value in result.items():
                if isinstance(value, dict):
                    print(f"  - {key}: {list(value.keys())}")
                else:
                    print(f"  - {key}: {value}")
            
        except Exception as e:
            logger.error(f"Error getting data for geography {geo_id}: {e}")
            import traceback
            print(f"ERROR: {str(e)}\n{traceback.format_exc()}")
        
        print("=== End of debug output ===\n")
        return result
    
    def _convert_to_numeric_geoid(self, geo_id: str, geo_level: GeoLevel) -> str:
        """Convert prefixed geo ID to numeric geoid for data matching."""
        geo_id_str = str(geo_id).strip()
        
        # If it's already numeric, return as-is
        if geo_id_str.isdigit():
            return geo_id_str
            
        # Handle prefixed IDs
        if geo_id_str.startswith('county_'):
            # Extract numeric part after 'county_'
            return geo_id_str.replace('county_', '')
        elif geo_id_str.startswith('house_'):
            # Convert house_00001 to 15001 format (5-digit geoid)
            district_num = geo_id_str.replace('house_', '').lstrip('0')
            return f"15{district_num.zfill(3)}"
        elif geo_id_str.startswith('senate_'):
            # Convert senate_00001 to 15001 format (5-digit geoid)
            district_num = geo_id_str.replace('senate_', '').lstrip('0')
            return f"15{district_num.zfill(3)}"
        
        # Fallback: return original ID
        return geo_id_str

    def _determine_geo_level(self, geo_id: str) -> Optional[GeoLevel]:
        """Determine the geographic level from a geo ID."""
        geo_id_str = str(geo_id).strip()
        
        print(f"DEBUG: Determining geo level for ID: '{geo_id_str}'")
        
        # Handle prefixed IDs (new system)
        if geo_id_str.startswith('county_'):
            print("DEBUG: Detected county prefix")
            return GeoLevel.COUNTY
        elif geo_id_str.startswith('house_'):
            print("DEBUG: Detected house prefix")
            return GeoLevel.HOUSE
        elif geo_id_str.startswith('senate_'):
            print("DEBUG: Detected senate prefix")
            return GeoLevel.SENATE
        
        # Handle legacy numeric IDs (fallback)
        print("DEBUG: No prefix detected, checking legacy numeric ID patterns")
        
        # Check if it's a 5-digit ID that could be county or district
        if len(geo_id_str) == 5 and geo_id_str.isdigit():
            print(f"DEBUG: 5-digit ID detected: {geo_id_str}")
            
            # Check if this ID exists in house district data
            house_data = self.data_cache.get(f"{DataType.ACS.value}_house")
            if house_data is not None and 'geoid' in house_data.columns:
                house_match = house_data[house_data['geoid'].astype(str) == geo_id_str]
                if not house_match.empty:
                    print(f"DEBUG: Found {geo_id_str} in house district data")
                    return GeoLevel.HOUSE
            
            # Check if this ID exists in county data
            county_data = self.data_cache.get(f"{DataType.ACS.value}_county")
            if county_data is not None and 'geoid' in county_data.columns:
                county_match = county_data[county_data['geoid'].astype(str) == geo_id_str]
                if not county_match.empty:
                    print(f"DEBUG: Found {geo_id_str} in county data")
                    return GeoLevel.COUNTY
        
        # Check for state-level ID FIRST (before 2-digit check)
        elif geo_id_str in ['15', '15000']:
            print(f"DEBUG: State-level ID detected: {geo_id_str}")
            return GeoLevel.STATE
        
        # Check for 2-digit senate districts
        elif len(geo_id_str) == 2 and geo_id_str.isdigit():
            print(f"DEBUG: 2-digit ID detected, assuming senate district: {geo_id_str}")
            return GeoLevel.SENATE
        
        print(f"DEBUG: Could not determine geo level for ID: {geo_id_str}")
        return None
    
    def _build_geography_result(self, result: Dict[str, Any], geo_row: pd.Series) -> Dict[str, Any]:
        """Build the result dictionary from a geography data row."""
        print("\n=== DEBUG: Building geography result ===")
        
        # Get all available columns for debugging
        all_columns = geo_row.index.tolist()
        print(f"DEBUG: All available columns in geo_row: {all_columns}")
        
        # Log values of interest for debugging
        columns_of_interest = [
            'NAME', 'geoid', 'median_rent', 'median_home_value', 'homeownership_rate',
            'renter_rate', 'rent_burden_rate', 'severe_rent_burden_rate',
            'snap_household_rate', 'snap_benefit_annual_per_household',
            'snap_benefits_annual_total', 'total_population', 'median_income',
            'poverty_rate', 'unemployment_rate', 'alice_rate'
        ]
        
        print("\nDEBUG: Values of interest:")
        for col in columns_of_interest:
            if col in geo_row:
                print(f"  - {col}: {geo_row[col]}")
        
        # Set the name with a fallback
        result['name'] = geo_row.get('NAME', f"Geography {result['id']}")
        
        # Extract all values using _safe_get to handle missing values
        median_rent = self._safe_get(geo_row, 'median_rent')
        median_home_value = self._safe_get(geo_row, 'median_home_value')
        homeownership_rate = self._safe_get(geo_row, 'homeownership_rate')
        renter_rate = self._safe_get(geo_row, 'renter_rate')
        
        print(f"\nDEBUG: Extracted housing values - median_rent: {median_rent}, "
              f"median_home_value: {median_home_value}, "
              f"homeownership_rate: {homeownership_rate}, "
              f"renter_rate: {renter_rate}")
        
        # Demographics
        result['demographics'] = {
            'population': self._safe_get(geo_row, 'total_population'),
            'median_age': self._safe_get(geo_row, 'median_age'),
            'population_by_race': {
                'White': self._safe_get(geo_row, 'white_alone', 0),
                'Native Hawaiian/Pacific Islander': self._safe_get(geo_row, 'nhpi_alone', 0),
                'Asian': self._safe_get(geo_row, 'asian_alone', 0),
                'Two or More Races': self._safe_get(geo_row, 'two_or_more_races', 0),
                'Other': self._safe_get(geo_row, 'other_race', 0)
            }
        }
        
        # Economic indicators
        result['economic'] = {
            'median_income': self._safe_get(geo_row, 'median_income'),
            'poverty_rate': self._safe_get(geo_row, 'poverty_rate'),
            'unemployment_rate': self._safe_get(geo_row, 'unemployment_rate'),
            'alice_rate': self._safe_get(geo_row, 'alice_rate')
        }
        
        # Housing indicators
        result['housing'] = {
            'median_home_value': median_home_value,
            'median_rent': median_rent,
            'homeownership_rate': homeownership_rate,
            'renter_rate': renter_rate,
            'rent_burden_rate': self._safe_get(geo_row, 'rent_burden_rate'),
            'severe_rent_burden_rate': self._safe_get(geo_row, 'severe_rent_burden_rate')
        }
        
        # SNAP data
        result['snap'] = {
            'snap_household_count': self._safe_get(geo_row, 'snap_households'),  # Use snap_households from data
            'snap_household_rate': self._safe_get(geo_row, 'snap_household_rate'),
            'snap_benefit_annual_per_household': self._safe_get(geo_row, 'snap_benefit_annual_per_household'),
            'snap_benefits_annual_total': self._safe_get(geo_row, 'snap_benefits_annual_total')
        }
        
        # Tax credit data
        result['tax_credits'] = {
            'ctc_avg_amount': self._safe_get(geo_row, 'ctc_avg_amount'),
            'ctc_participation_rate': self._safe_get(geo_row, 'ctc_participation_rate'),
            'federal_eitc_avg_amount': self._safe_get(geo_row, 'federal_eitc_avg_amount'),
            'eitc_participation_rate': self._safe_get(geo_row, 'eitc_participation_rate'),
            'state_eitc_avg_amount': self._safe_get(geo_row, 'state_eitc_avg_amount')
        }
        
        # Transportation data
        result['transportation'] = {
            'travel_time_to_work_minutes': self._safe_get(geo_row, 'travel_time_to_work_minutes'),
            'public_transportation_pct': self._safe_get(geo_row, 'public_transportation_pct')
        }
        
        # Log the final result structure
        print("\nDEBUG: Final result structure:")
        for section, values in result.items():
            if isinstance(values, dict):
                print(f"  - {section}: {list(values.keys())}")
                if section in ['demographics', 'economic', 'housing', 'snap']:
                    for key, value in values.items():
                        if isinstance(value, dict):
                            print(f"    - {key}: {list(value.keys())}")
                        else:
                            print(f"    - {key}: {value}")
            else:
                print(f"  - {section}: {values}")
        
        print("=== End of building geography result ===\n")
        return result
    
    def _safe_get(self, series: pd.Series, key: str, default: Any = None) -> Any:
        """
        Safely get a value from a pandas Series, handling NaN and None values.
        
        Args:
            series: The pandas Series to get the value from
            key: The key to look up in the Series
            default: The default value to return if the key is not found or the value is NaN/None
            
        Returns:
            The value from the Series, or the default value if the key is not found or the value is NaN/None
        """
        # Debug: Log the key being looked up
        debug = False  # Set to True to enable debug logging for this method
        
        if debug:
            print(f"\nDEBUG: _safe_get - Looking up key: {key}")
            print(f"DEBUG: _safe_get - Available keys: {series.index.tolist() if hasattr(series, 'index') else 'N/A'}")
        
        # Check if the key exists in the Series
        if key not in series:
            if debug:
                print(f"DEBUG: _safe_get - Key '{key}' not found in Series. Returning default: {default}")
            return default
        
        # Get the value
        value = series.get(key, default)
        
        # Handle None/NaN values
        if value is None or (hasattr(value, '__len__') and len(value) == 0) or (pd.isna(value) if hasattr(pd, 'isna') and hasattr(value, '__array__') else False):
            if debug:
                print(f"DEBUG: _safe_get - Value for key '{key}' is None/NaN/empty. Returning default: {default}")
            return default
        
        # Debug: Log the value that will be returned
        if debug:
            print(f"DEBUG: _safe_get - Found value for key '{key}': {value}")
        
        return value
    
    def get_available_variables(self) -> Dict[str, str]:
        """Get available variables and their display names."""
        return self.available_variables
    
    def get_variable_values(self, geo_level: str, variable: str) -> Optional[pd.Series]:
        """Get values for a specific variable at a geographic level."""
        df = self.get_data(geo_level)
        if df is None or variable not in df.columns:
            if df is not None:
                logger.error(f"Variable {variable} not found in {geo_level} data. "
                           f"Available columns: {list(df.columns)}")
            return None
        return df[variable]
    
    def get_geojson_path(self, geo_level: str) -> Optional[Path]:
        """Get path to GeoJSON file for a geographic level."""
        try:
            geo_enum = GeoLevel(geo_level)
            return self.geojson_processor.get_geojson_path(geo_enum)
        except ValueError:
            logger.error(f"Invalid geographic level: {geo_level}")
            return None
    
    def merge_geojson_with_data(self, geojson_data: dict, geo_level: str) -> dict:
        """Merge GeoJSON with data for a geographic level."""
        try:
            geo_enum = GeoLevel(geo_level)
            data = self.get_data(geo_level)
            return self.geojson_processor.merge_geojson_with_data(geojson_data, data, geo_enum)
        except ValueError:
            logger.error(f"Invalid geographic level: {geo_level}")
            return geojson_data
        except Exception as e:
            logger.error(f"Error merging GeoJSON with data for {geo_level}: {e}")
            return geojson_data


# Legacy compatibility functions (if needed for existing code)
def load_acs_data(geo_level: str) -> Optional[pd.DataFrame]:
    """Legacy function for loading ACS data."""
    loader = DataLoader()
    return loader.data_cache.get(f"{DataType.ACS.value}_{geo_level}")


def load_alice_data(geo_level: str) -> Optional[pd.DataFrame]:
    """Legacy function for loading ALICE data."""
    loader = DataLoader()
    return loader.data_cache.get(f"{DataType.ALICE.value}_{geo_level}")


def load_snap_data(geo_level: str) -> Optional[pd.DataFrame]:
    """Legacy function for loading SNAP data."""
    loader = DataLoader()
    return loader.data_cache.get(f"{DataType.SNAP.value}_{geo_level}")


# Example usage and testing
if __name__ == "__main__":
    # Initialize the data loader
    loader = DataLoader()
    
    # Test loading different data types
    for geo_level in ['state', 'county', 'house', 'senate']:
        print(f"\n=== Testing {geo_level.upper()} level ===")
        
        # Get combined data
        combined_data = loader.get_data(geo_level)
        if combined_data is not None:
            print(f"Combined data shape: {combined_data.shape}")
            print(f"Columns: {list(combined_data.columns)[:10]}...")  # First 10 columns
        else:
            print("No combined data available")
        
        # Test specific geography lookup (if data exists)
        if combined_data is not None and not combined_data.empty:
            first_geoid = combined_data['geoid'].iloc[0] if 'geoid' in combined_data.columns else None
            if first_geoid:
                geo_data = loader.get_all_data_for_geo(first_geoid)
                print(f"Sample geography data for {first_geoid}: {geo_data['name']}")
    
    # Test available variables
    variables = loader.get_available_variables()
    print(f"\nAvailable variables: {len(variables)}")
    for var, desc in list(variables.items())[:5]:  # First 5 variables
        print(f"  {var}: {desc}")
    
    print("\nData loader initialization and testing complete!")
    