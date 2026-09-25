"""Module for loading and processing ALICE (Asset Limited, Income Constrained, Employed) data."""
import pandas as pd
from pathlib import Path
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)

class ALICEDataLoader:
    """Load and manage ALICE data from Excel files."""
    
    def __init__(self, file_path: str = None):
        """Initialize the ALICE data loader.
        
        Args:
            file_path: Path to the ALICE Excel file. If None, will look in the default location.
        """
        if file_path is None:
            from data.data_source_registry import get_alice_excel_path
            self.file_path = get_alice_excel_path()
        else:
            self.file_path = Path(file_path)
            
        self.data = {}
        
    def load_data(self) -> bool:
        """Load ALICE data from the Excel file.
        
        Returns:
            bool: True if data was loaded successfully, False otherwise.
        """
        try:
            # Map sheet names to our internal geo levels
            sheet_map = {
                'State': 'state',
                'Counties': 'county',
                'House': 'house',
                'Senate': 'senate'
            }
            
            for sheet_name, geo_level in sheet_map.items():
                try:
                    df = pd.read_excel(self.file_path, sheet_name=sheet_name)
                    
                    # Standardize column names
                    df.columns = [col.lower().replace(' ', '_') for col in df.columns]
                    
                    # Handle different column names in different sheets
                    if 'county' in df.columns:
                        df = df.rename(columns={'county': 'name'})
                    elif 'district' in df.columns:
                        df = df.rename(columns={'district': 'name'})
                    elif 'senate_district' in df.columns:
                        df = df.rename(columns={'senate_district': 'name'})
                    
                    # Ensure name is string and clean it
                    if 'name' in df.columns:
                        df['name'] = df['name'].astype(str).str.strip()
                    
                    # Store the data
                    self.data[geo_level] = df
                    
                except Exception as e:
                    logger.warning(f"Error loading {geo_level} data from ALICE file: {e}")
                    continue
            
            return len(self.data) > 0
            
        except Exception as e:
            logger.error(f"Error loading ALICE data: {e}")
            return False
    
    def get_alice_rate(self, geo_level: str, location_name: str) -> Optional[float]:
        """Get the ALICE rate for a specific location.
        
        Args:
            geo_level: Geographic level ('state', 'county', 'house', 'senate')
            location_name: Name of the location to look up
            
        Returns:
            float: The ALICE rate as a decimal (e.g., 0.35 for 35%), or None if not found
        """
        if geo_level not in self.data:
            logger.warning(f"No data found for geo_level: {geo_level}")
            return None
            
        df = self.data[geo_level]
        logger.info(f"Looking for location: {location_name} in {geo_level}. Available locations: {df['name'].tolist()}")
        
        # Try exact match first
        result = df[df['name'].str.lower() == location_name.lower()]
        
        # If no match, try partial match
        if len(result) == 0:
            logger.info(f"No exact match for {location_name}, trying partial match")
            result = df[df['name'].str.lower().str.contains(location_name.lower())]
        
        if len(result) > 0:
            logger.info(f"Found {len(result)} matches for {location_name}")
            # Get the first column that contains 'percentage' or 'alice'
            for col in result.columns:
                if any(x in col.lower() for x in ['percentage', 'alice', 'rate']):
                    value = result[col].iloc[0]
                    logger.info(f"Found ALICE rate column: {col} with value: {value}")
                    # Convert to decimal if it's a percentage (e.g., 35% -> 0.35)
                    if isinstance(value, str) and '%' in value:
                        try:
                            return float(value.strip('%')) / 100
                        except (ValueError, TypeError):
                            logger.error(f"Could not convert ALICE rate value: {value}")
                            return None
                    # If it's already a float, ensure it's in decimal format
                    elif isinstance(value, (int, float)):
                        if value > 1.0:  # If it's a whole number percentage (e.g., 35 for 35%)
                            return value / 100
                        return value  # Already in decimal format
                    return value
            
            logger.warning(f"No ALICE rate column found in result columns: {result.columns.tolist()}")
        else:
            logger.warning(f"No match found for location: {location_name} in {geo_level}")
        
        return None

# Create a singleton instance
alice_data_loader = ALICEDataLoader()
