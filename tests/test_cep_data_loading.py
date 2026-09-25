"""Tests for CEP data loading functionality."""
import unittest
from pathlib import Path
import pandas as pd
from src.data.data_loader import DataLoader, GeoLevel, DataType

class TestCEPDataLoading(unittest.TestCase):
    """Test case for CEP data loading functionality."""
    
    @classmethod
    def setUpClass(cls):
        """Set up test fixtures before any tests are run."""
        cls.data_loader = DataLoader()
    
    def test_load_house_cep_data(self):
        """Test loading house district CEP data."""
        # Load house district CEP data
        df = self.data_loader.loaders[DataType.CEP].load_data(GeoLevel.HOUSE)
        
        # Verify the data was loaded
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 0)
        
        # Check required columns
        required_columns = ['district', 'total_schools', 'cep_schools', 'cep_percentage', 'geoid', 'NAME']
        for col in required_columns:
            self.assertIn(col, df.columns)
        
        # Check data types
        self.assertTrue(pd.api.types.is_numeric_dtype(df['total_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_percentage']))
        self.assertTrue(all(df['geoid'].str.startswith('15')))
    
    def test_load_senate_cep_data(self):
        """Test loading senate district CEP data."""
        # Load senate district CEP data
        df = self.data_loader.loaders[DataType.CEP].load_data(GeoLevel.SENATE)
        
        # Verify the data was loaded
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 0)
        
        # Check required columns
        required_columns = ['district', 'total_schools', 'cep_schools', 'cep_percentage', 'geoid', 'NAME']
        for col in required_columns:
            self.assertIn(col, df.columns)
        
        # Check data types
        self.assertTrue(pd.api.types.is_numeric_dtype(df['total_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_percentage']))
        self.assertTrue(all(df['geoid'].str.startswith('15')))
    
    def test_load_county_cep_data(self):
        """Test loading county CEP data."""
        # Load county CEP data
        df = self.data_loader.loaders[DataType.CEP].load_data(GeoLevel.COUNTY)
        
        # Verify the data was loaded
        self.assertIsNotNone(df)
        self.assertGreater(len(df), 0)
        
        # Check required columns (counties are keyed by `county`, not `district`)
        required_columns = ['county', 'total_schools', 'cep_schools', 'cep_percentage', 'geoid', 'NAME']
        for col in required_columns:
            self.assertIn(col, df.columns)

        # Check data types
        self.assertTrue(pd.api.types.is_numeric_dtype(df['total_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_schools']))
        self.assertTrue(pd.api.types.is_numeric_dtype(df['cep_percentage']))
        self.assertTrue(all(df['geoid'].str.startswith('15')))

    def test_cep_variables_in_available_variables(self):
        """Test that CEP variables are included in available variables."""
        available_vars = self.data_loader.get_available_variables()
        
        # Check that CEP variables are included
        cep_vars = ['cep_percentage', 'cep_schools', 'total_schools', 'cep_display']
        for var in cep_vars:
            self.assertIn(var, available_vars)

if __name__ == '__main__':
    unittest.main()
