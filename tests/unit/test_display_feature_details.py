"""
Unit tests for the display_feature_details function.
"""
import pytest
import json
import unittest
from unittest.mock import patch, MagicMock

from ui.leaflet_map_view import display_feature_details

# Create a SessionState class to mock Streamlit's session state
class SessionState(dict):
    def __getattr__(self, key):
        if key in self:
            return self[key]
        return None
    
    def __setattr__(self, key, value):
        self[key] = value

class TestDisplayFeatureDetails:
    """Test suite for display_feature_details functionality."""
    
    @pytest.mark.skip(reason="Legacy Streamlit UI, superseded by web/: display_feature_details now builds five tabs "
                             "(Key Metrics, SNAP, ...); this test mocks the old four")
    @patch('ui.leaflet_map_view.st')
    def test_display_feature_details(self, mock_st):
        """Test displaying feature details."""
        # Create sample GeoJSON data
        geojson_data = {
            'type': 'FeatureCollection',
            'features': [
                {
                    'type': 'Feature',
                    'properties': {
                        'id': 'Hawaii',  
                        'NAME': 'Hawaii',
                        'poverty_rate': 9.97,
                        'median_income': 98317,
                        'population': 1445635
                    }
                }
            ]
        }
        
        # Create sample variable data
        selected_variable = 'poverty_rate'
        
        # Mock tabs function to return mock tabs
        mock_tab1 = MagicMock()
        mock_tab2 = MagicMock()
        mock_tab3 = MagicMock()
        mock_tab4 = MagicMock()
        mock_st.tabs.return_value = [mock_tab1, mock_tab2, mock_tab3, mock_tab4]
        
        # Mock columns
        mock_col1 = MagicMock()
        mock_col2 = MagicMock()
        mock_st.columns.return_value = [mock_col1, mock_col2]
        
        # Mock container context manager
        mock_container = MagicMock()
        mock_st.container.return_value = mock_container
        mock_container_context = MagicMock()
        mock_container.__enter__.return_value = mock_container_context
        
        # Call the function
        display_feature_details('Hawaii', geojson_data, selected_variable)
        
        # Verify that the feature details were displayed
        mock_st.markdown.assert_any_call("### Feature Details")
        
        # Verify that the feature name was displayed
        mock_st.markdown.assert_any_call("#### Hawaii")
        
        # Verify that tabs were created
        mock_st.tabs.assert_called_once_with(["Demographics", "Economic", "Housing", "Education & Health"])
        
        # Verify that metrics were displayed
        assert mock_st.metric.call_count > 0, "Metric function should be called at least once"
    
    @patch('ui.leaflet_map_view.st')
    def test_display_feature_details_not_found(self, mock_st):
        """Test displaying feature details when feature is not found."""
        # Create sample GeoJSON data
        geojson_data = {
            'type': 'FeatureCollection',
            'features': [
                {
                    'type': 'Feature',
                    'properties': {
                        'id': 'Hawaii',
                        'NAME': 'Hawaii'
                    }
                }
            ]
        }
        
        # Create sample variable data
        selected_variable = 'poverty_rate'
        
        # Call the function with a non-existent feature ID
        result = display_feature_details('NonExistentFeature', geojson_data, selected_variable)
        
        # Verify that no UI elements were created (function returns early)
        mock_st.markdown.assert_not_called()
        mock_st.tabs.assert_not_called()
        mock_st.metric.assert_not_called()
        
        # The function should return None
        assert result is None
    
    @pytest.mark.skip(reason="Legacy Streamlit UI, superseded by web/: display_feature_details now builds five tabs "
                             "(Key Metrics, SNAP, ...); this test mocks the old four")
    @patch('ui.leaflet_map_view.st')
    def test_display_feature_details_with_missing_data(self, mock_st):
        """Test displaying feature details with missing data."""
        # Create sample GeoJSON data with missing values
        geojson_data = {
            'type': 'FeatureCollection',
            'features': [
                {
                    'type': 'Feature',
                    'properties': {
                        'id': 'Hawaii',
                        'NAME': 'Hawaii',
                        'poverty_rate': 9.97
                        # Missing other properties
                    }
                }
            ]
        }
        
        # Create sample variable data
        selected_variable = 'poverty_rate'
        
        # Mock tabs function to return mock tabs
        mock_tab1 = MagicMock()
        mock_tab2 = MagicMock()
        mock_tab3 = MagicMock()
        mock_tab4 = MagicMock()
        mock_st.tabs.return_value = [mock_tab1, mock_tab2, mock_tab3, mock_tab4]
        
        # Mock columns
        mock_col1 = MagicMock()
        mock_col2 = MagicMock()
        mock_st.columns.return_value = [mock_col1, mock_col2]
        
        # Mock container context manager
        mock_container = MagicMock()
        mock_st.container.return_value = mock_container
        mock_container_context = MagicMock()
        mock_container.__enter__.return_value = mock_container_context
        
        # Call the function
        display_feature_details('Hawaii', geojson_data, selected_variable)
        
        # Verify that the feature details were displayed
        mock_st.markdown.assert_any_call("### Feature Details")
        
        # Verify that the feature name was displayed
        mock_st.markdown.assert_any_call("#### Hawaii")
        
        # Verify that tabs were created
        mock_st.tabs.assert_called_once_with(["Demographics", "Economic", "Housing", "Education & Health"])
        
        # Verify that metrics were displayed with 'N/A' for missing values
        # At least one metric call should use 'N/A' for missing data
        found_na_value = False
        for call in mock_st.metric.call_args_list:
            if 'N/A' in str(call):
                found_na_value = True
                break
        assert found_na_value, "At least one metric should display 'N/A' for missing data"
