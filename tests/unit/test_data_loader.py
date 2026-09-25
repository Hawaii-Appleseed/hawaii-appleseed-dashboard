"""
Unit tests for data loading functionality.
"""
import pytest
import pandas as pd
import json
from pathlib import Path
import sys
from unittest.mock import patch, MagicMock, mock_open

# Import the modules to test
from data.data_loader import DataLoader, DataType, GeoLevel

class TestDataLoader:
    """Test suite for DataLoader class."""

    @patch('data.data_loader.DataLoader._preload_data')
    def test_load_acs_data(self, mock_preload):
        """County ACS data loads from its processed CSV, as the build reads it
        (scripts/build_static/02_build_layer_geojsons.py via DataLoader)."""
        acs_data = DataLoader().loaders[DataType.ACS].load_data(GeoLevel.COUNTY)

        assert isinstance(acs_data, pd.DataFrame), "ACS data should be a DataFrame"
        assert {'15001', '15003', '15007', '15009'} <= set(acs_data['geoid']), \
            "ACS data should have the four mapped counties"

        required_columns = ['geoid', 'NAME', 'poverty_rate', 'median_income', 'college_educated_pct']
        for col in required_columns:
            assert col in acs_data.columns, f"Column {col} should be present in ACS data"
        assert acs_data['poverty_rate'].between(0, 100).all(), "Poverty rates are percentages"

    @pytest.mark.skip(reason="Legacy Streamlit UI, superseded by web/: ui.leaflet_map_view.load_geojson "
                             "now reads the gzipped boundary files, which this test's open() mock doesn't cover")
    @patch('ui.leaflet_map_view.open', new_callable=mock_open, read_data=json.dumps({
        'type': 'FeatureCollection',
        'features': [{
            'type': 'Feature',
            'properties': {'NAME': 'Hawaii'},
            'geometry': {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}
        }]
    }))
    @patch('ui.leaflet_map_view.Path')
    def test_load_geojson(self, mock_path, mock_file):
        """Test loading GeoJSON data."""
        # Import the function from the correct module
        from ui.leaflet_map_view import load_geojson
        
        # Mock the Path to return itself for any operations
        mock_path_instance = MagicMock()
        mock_path.return_value = mock_path_instance
        mock_path_instance.__truediv__.return_value = mock_path_instance
        mock_path_instance.parent.parent.parent = mock_path_instance
        
        # Test loading state boundary
        state_geojson = load_geojson('State Boundary')
        assert state_geojson is not None, "State boundary GeoJSON should not be None"
        assert 'features' in state_geojson, "GeoJSON should have features"
        assert len(state_geojson['features']) > 0, "GeoJSON should have at least one feature"
        
        # Verify that the file was opened with the correct path
        mock_file.assert_called_with(mock_path_instance, 'r')
    
    def test_get_variable_options(self):
        """Test getting variable options."""
        data_loader = DataLoader()
        variable_options = data_loader.get_available_variables()
        
        # Verify options structure
        assert isinstance(variable_options, dict), "Variable options should be a dictionary"
        assert len(variable_options) > 0, "Variable options should not be empty"
        
        # Verify required variables are present
        required_vars = ['poverty_rate', 'median_income', 'population']
        for var in required_vars:
            assert var in variable_options, f"Variable {var} should be in options"
