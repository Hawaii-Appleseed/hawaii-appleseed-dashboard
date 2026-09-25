"""Unit tests for dropdown menus in the map view."""
import unittest
from unittest.mock import patch, MagicMock, call, ANY
import streamlit as st
import sys
import os
from pathlib import Path
import pytest
import re

# Add the src directory to the Python path
sys.path.append(str(Path(__file__).parent.parent.parent / "src"))

# Import local modules
from ui.leaflet_map_view import create_leaflet_map_view

class TestDropdownMenus(unittest.TestCase):
    """Test class for dropdown menus in the map view."""
    
    def setUp(self):
        """Set up test environment."""
        # Reset session state before each test
        st.session_state = {
            'active_layer': 'State Boundary',
            'selected_variable': 'poverty_rate',
            'color_scheme': 'blue'
        }
    
    @unittest.skip("Legacy Streamlit UI, superseded by web/: create_leaflet_map_view merges through the "
                   "st.cache_data-cached _get_merged_geojson, which can't pickle this test's MagicMocks")
    @patch("streamlit.selectbox")
    def test_dropdown_keys_are_unique(self, mock_selectbox):
        """Test that dropdown keys are unique to avoid duplicate key errors."""
        # Create a set to track keys
        keys = set()
        
        # Mock the selectbox to capture keys
        def mock_selectbox_impl(label, options, **kwargs):
            key = kwargs.get('key')
            if key:
                # Ensure key is not already in the set
                self.assertNotIn(key, keys, f"Duplicate key found: {key}")
                keys.add(key)
            # Return the first option by default
            return options[0] if options else None
        
        mock_selectbox.side_effect = mock_selectbox_impl
        
        # Call the function that creates the dropdowns
        create_leaflet_map_view()
        
        # Verify that selectbox was called at least once
        mock_selectbox.assert_called()
        
        # Verify we have some keys (at least 2 for layer and variable selectors)
        self.assertGreaterEqual(len(keys), 2, f"Expected at least 2 unique keys, got {keys}")
    
    @unittest.skip("Legacy Streamlit UI, superseded by web/: create_leaflet_map_view merges through the "
                   "st.cache_data-cached _get_merged_geojson, which can't pickle this test's MagicMocks")
    @patch("streamlit.selectbox")
    @patch("streamlit.columns")
    def test_dropdown_implementation(self, mock_columns, mock_selectbox):
        """Test that dropdowns are implemented correctly with appropriate options and keys."""
        # Mock the columns to return a list of mock columns
        mock_col = MagicMock()
        mock_columns.return_value = [mock_col, mock_col, mock_col]
        
        # Track the selectbox calls
        selectbox_calls = []
        
        # Mock the selectbox to track calls and return the first option
        def mock_selectbox_impl(label, options, **kwargs):
            selectbox_calls.append({
                'label': label,
                'options': options,
                'kwargs': kwargs
            })
            return options[0] if options else None
        
        mock_selectbox.side_effect = mock_selectbox_impl
        
        # Call the function that creates the dropdowns
        create_leaflet_map_view()
        
        # Verify that selectbox was called at least once
        mock_selectbox.assert_called()
        
        # Check that we have the expected number of dropdowns (3: layer, variable, color scheme)
        self.assertGreaterEqual(len(selectbox_calls), 3, "Expected at least 3 dropdowns")
        
        # Check that each dropdown has the expected properties
        for call in selectbox_calls:
            self.assertIn('key', call['kwargs'], f"Missing 'key' in selectbox call: {call}")
            self.assertIsNotNone(call['options'], f"No options provided for {call['label']}")
            self.assertGreater(len(call['options']), 0, f"Empty options for {call['label']}")
            
            # Verify specific dropdowns based on their labels
            if call['label'] == 'Geographic Layer':
                self.assertListEqual(
                    call['options'],
                    ['State Boundary', 'Counties', 'House Districts', 'Senate Districts'],
                    "Incorrect options for Geographic Layer dropdown"
                )
            elif call['label'] == 'Data Variable':
                self.assertIn('format_func', call['kwargs'], "Missing format_func for Data Variable dropdown")
                self.assertIn('poverty_rate', call['options'], "Missing poverty_rate in Data Variable options")
            elif call['label'] == 'Color Scheme':
                self.assertListEqual(
                    call['options'],
                    ['blue', 'green', 'red', 'purple'],
                    "Incorrect options for Color Scheme dropdown"
                )
    
    def test_css_injection_for_dropdowns(self):
        """Test that the CSS for dropdowns is properly injected."""
        from run_leaflet import main
        
        # Mock streamlit's markdown function to capture CSS
        with patch('streamlit.markdown') as mock_markdown:
            # Run the main function which should inject CSS
            main()
            
            # Check that markdown was called with CSS content
            css_calls = [c for c in mock_markdown.call_args_list 
                       if c[0] and isinstance(c[0][0], str) and '<style>' in c[0][0]]
            
            # Ensure CSS was injected
            self.assertTrue(len(css_calls) > 0, "No CSS was injected")
            
            # Extract the CSS content
            css_content = '\n'.join([c[0][0] for c in css_calls])
            
            # Check for dropdown-related CSS properties
            self.assertIn("[data-baseweb=\"select\"]", css_content, 
                         "Missing CSS selector for dropdown base")
            
            # Check for width-related properties to prevent text cutoff
            self.assertTrue(
                re.search(r'(width|min-width|max-width)', css_content, re.IGNORECASE),
                "Missing width-related CSS properties for dropdowns"
            )

if __name__ == "__main__":
    unittest.main()
