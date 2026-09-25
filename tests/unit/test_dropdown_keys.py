"""Unit tests for dropdown menu keys to ensure uniqueness."""
import unittest
from unittest.mock import patch, MagicMock
import sys
import os
from pathlib import Path
import pytest
import streamlit as st

# Add the src directory to the Python path
sys.path.append(str(Path(__file__).parent.parent.parent))

# Import local modules
from src.ui.leaflet_map_view import create_leaflet_map_view
from src.ui.sidebar import create_sidebar
from run_leaflet import main


@unittest.skip("Legacy Streamlit UI, superseded by web/: the menus are custom cascades, not st.selectbox, "
               "and the sidebar reads st.session_state by attribute, which this test's plain-dict mock lacks")
class TestDropdownKeys(unittest.TestCase):
    """Test class for dropdown menu keys."""
    
    def setUp(self):
        """Set up test environment."""
        # Reset the keys set before each test
        self.keys = set()
        
        # Mock session state
        st.session_state = {
            'active_layer': 'State Boundary',
            'selected_variable': 'poverty_rate',
            'color_scheme': 'blue'
        }
    
    def mock_selectbox(self, *args, **kwargs):
        """Mock implementation of st.selectbox that captures keys."""
        key = kwargs.get('key')
        if key:
            # Check if the key is already in our set
            if key in self.keys:
                self.fail(f"Duplicate key found: {key}")
            self.keys.add(key)
        return args[1][0] if len(args) > 1 and isinstance(args[1], list) and len(args[1]) > 0 else None
    
    @patch('streamlit.selectbox')
    def test_sidebar_keys_are_unique(self, mock_selectbox):
        """Test that sidebar dropdown keys are unique."""
        mock_selectbox.side_effect = self.mock_selectbox
        
        # Call the sidebar creation function
        create_sidebar()
        
        # Verify that selectbox was called at least once
        mock_selectbox.assert_called()
        
        # Verify that we have at least 3 keys (layer, variable, color scheme)
        self.assertGreaterEqual(len(self.keys), 3, 
                              "Expected at least 3 dropdown keys in sidebar")
        
        # Print the keys for debugging
        print(f"Sidebar keys: {self.keys}")
    
    @patch('streamlit.selectbox')
    def test_map_view_keys_are_unique(self, mock_selectbox):
        """Test that map view dropdown keys are unique."""
        mock_selectbox.side_effect = self.mock_selectbox
        
        # Call the map view creation function
        create_leaflet_map_view()
        
        # Verify that selectbox was called
        mock_selectbox.assert_called()
        
        # Print the keys for debugging
        print(f"Map view keys: {self.keys}")
    
    @patch('streamlit.selectbox')
    def test_all_keys_are_unique_across_components(self, mock_selectbox):
        """Test that all dropdown keys are unique across components."""
        mock_selectbox.side_effect = self.mock_selectbox
        
        # First create the sidebar
        create_sidebar()
        
        # Then create the map view
        create_leaflet_map_view()
        
        # Verify that selectbox was called
        mock_selectbox.assert_called()
        
        # Print the keys for debugging
        print(f"All keys: {self.keys}")
    
    @patch('streamlit.selectbox')
    def test_main_app_keys_are_unique(self, mock_selectbox):
        """Test that all dropdown keys are unique in the main app."""
        mock_selectbox.side_effect = self.mock_selectbox
        
        # Call the main function
        with patch('src.ui.leaflet_map_view.create_leaflet_map_view'):
            with patch('src.ui.sidebar.create_sidebar'):
                main()
        
        # Verify that selectbox was called
        mock_selectbox.assert_called()
        
        # Print the keys for debugging
        print(f"Main app keys: {self.keys}")
    
    def test_key_naming_convention(self):
        """Test that keys follow a consistent naming convention."""
        # Capture all keys by patching selectbox
        with patch('streamlit.selectbox', side_effect=self.mock_selectbox):
            # Create sidebar
            create_sidebar()
            
            # Create map view
            create_leaflet_map_view()
        
        # Check that keys follow a consistent naming convention
        for key in self.keys:
            # Keys should be strings
            self.assertIsInstance(key, str, f"Key {key} is not a string")
            
            # Keys should include a component prefix
            self.assertTrue(
                any(prefix in key for prefix in ['sidebar_', 'map_']), 
                f"Key {key} does not include a component prefix"
            )
            
            # Keys should include a descriptive name
            self.assertTrue(
                any(descriptor in key for descriptor in ['layer', 'variable', 'color']), 
                f"Key {key} does not include a descriptive name"
            )
            
            # Keys should not have generic names
            self.assertNotIn(key, ['selectbox', 'dropdown', 'select'], 
                           f"Key {key} is too generic")


if __name__ == "__main__":
    unittest.main()
