"""
Visual tests for dropdown menus in the Hawaii Appleseed Dashboard.
These tests focus on the visual aspects of the dropdowns to ensure they render correctly.

Requirements:
- playwright
- pytest-playwright

Install with:
pip install playwright pytest-playwright
playwright install
"""
import pytest
import time
import os
import sys
from pathlib import Path

# Add the project root to the Python path
sys.path.append(str(Path(__file__).parent.parent.parent))

# Skipped as a module so the autouse fixture below never starts Streamlit.
pytestmark = pytest.mark.skip(
    reason="Legacy Streamlit UI, superseded by web/: drives run_leaflet.py in a browser "
           "and needs pytest-playwright"
)

# Test constants
STREAMLIT_PORT = 8501
TIMEOUT = 30000  # 30 seconds

@pytest.fixture(scope="module", autouse=True)
def start_streamlit_server(request):
    """Start the Streamlit server for testing."""
    import subprocess
    import time
    import signal
    
    # Start the Streamlit server
    process = subprocess.Popen(
        ["streamlit", "run", "run_leaflet.py"],
        cwd=str(Path(__file__).parent.parent.parent),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Wait for the server to start
    time.sleep(5)
    
    # Add finalizer to stop the server
    def fin():
        process.send_signal(signal.SIGTERM)
        process.wait()
    
    request.addfinalizer(fin)
    return process

@pytest.mark.visual
async def test_dropdown_no_text_cutoff(page):
    """Test that dropdown text is not cut off."""
    # Navigate to the Streamlit app
    await page.goto(f"http://localhost:{STREAMLIT_PORT}")
    
    # Wait for the app to load
    await page.wait_for_selector("[data-testid='stApp']", timeout=TIMEOUT)
    
    # Find all dropdown elements
    dropdowns = await page.query_selector_all("[data-baseweb='select']")
    
    # Ensure we found at least one dropdown
    assert len(dropdowns) > 0, "No dropdown elements found"
    
    for i, dropdown in enumerate(dropdowns):
        # Click to open the dropdown
        await dropdown.click()
        
        # Wait for the dropdown menu to appear
        dropdown_menu = await page.wait_for_selector("[data-baseweb='menu']", timeout=5000)
        assert dropdown_menu, f"Dropdown menu {i} did not appear"
        
        # Get all options in the dropdown
        options = await dropdown_menu.query_selector_all("[role='option']")
        assert len(options) > 0, f"No options found in dropdown {i}"
        
        # Check each option for text visibility
        for j, option in enumerate(options):
            # Get the option's bounding box
            bbox = await option.bounding_box()
            
            # Get the option's text content
            text_content = await option.text_content()
            
            # Take a screenshot of the option for visual inspection
            screenshot_path = f"dropdown_{i}_option_{j}.png"
            await option.screenshot(path=screenshot_path)
            
            # Check that the option has reasonable dimensions
            assert bbox["width"] > 50, f"Option {j} in dropdown {i} is too narrow: {bbox['width']}px"
            
            # Check that the option's text is not empty
            assert text_content.strip(), f"Option {j} in dropdown {i} has no text content"
            
            # Log the option's text and dimensions for debugging
            print(f"Dropdown {i}, Option {j}: '{text_content}' - Width: {bbox['width']}px, Height: {bbox['height']}px")
        
        # Close the dropdown by clicking elsewhere
        await page.click("[data-testid='stApp']")
        
        # Wait a moment for the dropdown to close
        await page.wait_for_timeout(500)

@pytest.mark.visual
async def test_dropdown_no_blinking_cursor(page):
    """Test that dropdowns don't have a blinking cursor issue."""
    # Navigate to the Streamlit app
    await page.goto(f"http://localhost:{STREAMLIT_PORT}")
    
    # Wait for the app to load
    await page.wait_for_selector("[data-testid='stApp']", timeout=TIMEOUT)
    
    # Find all dropdown elements
    dropdowns = await page.query_selector_all("[data-baseweb='select']")
    
    # Ensure we found at least one dropdown
    assert len(dropdowns) > 0, "No dropdown elements found"
    
    for i, dropdown in enumerate(dropdowns):
        # Click to open the dropdown
        await dropdown.click()
        
        # Wait for the dropdown menu to appear
        dropdown_menu = await page.wait_for_selector("[data-baseweb='menu']", timeout=5000)
        assert dropdown_menu, f"Dropdown menu {i} did not appear"
        
        # Take a screenshot of the open dropdown for visual inspection
        screenshot_path = f"dropdown_{i}_open.png"
        await page.screenshot(path=screenshot_path)
        
        # Check CSS properties related to cursor
        cursor_style = await dropdown.evaluate("""element => {
            const style = window.getComputedStyle(element);
            return {
                cursor: style.cursor,
                caretColor: style.caretColor,
                userSelect: style.userSelect
            };
        }""")
        
        # Log the cursor style for debugging
        print(f"Dropdown {i} cursor style: {cursor_style}")
        
        # Check that the cursor style is appropriate
        assert cursor_style["cursor"] in ["pointer", "default"], f"Dropdown {i} has unexpected cursor style: {cursor_style['cursor']}"
        
        # Close the dropdown by clicking elsewhere
        await page.click("[data-testid='stApp']")
        
        # Wait a moment for the dropdown to close
        await page.wait_for_timeout(500)

@pytest.mark.visual
async def test_dropdown_css_injection(page):
    """Test that the CSS for dropdowns is properly injected."""
    # Navigate to the Streamlit app
    await page.goto(f"http://localhost:{STREAMLIT_PORT}")
    
    # Wait for the app to load
    await page.wait_for_selector("[data-testid='stApp']", timeout=TIMEOUT)
    
    # Check that the CSS for dropdowns is injected
    css_injected = await page.evaluate("""() => {
        // Get all style elements
        const styleElements = Array.from(document.querySelectorAll('style'));
        
        // Check if any style element contains dropdown-related CSS
        return styleElements.some(style => {
            const css = style.textContent || '';
            return css.includes('[data-baseweb="select"]') || 
                   css.includes('[data-baseweb="popover"]') ||
                   css.includes('[data-baseweb="menu"]');
        });
    }""")
    
    # Assert that dropdown-related CSS is injected
    assert css_injected, "Dropdown-related CSS is not injected"
    
    # Get the dropdown-related CSS
    dropdown_css = await page.evaluate("""() => {
        // Get all style elements
        const styleElements = Array.from(document.querySelectorAll('style'));
        
        // Extract dropdown-related CSS
        const dropdownCss = styleElements
            .map(style => style.textContent || '')
            .filter(css => css.includes('[data-baseweb="select"]') || 
                           css.includes('[data-baseweb="popover"]') ||
                           css.includes('[data-baseweb="menu"]'))
            .join('\\n');
        
        return dropdownCss;
    }""")
    
    # Log the dropdown CSS for debugging
    print(f"Dropdown CSS: {dropdown_css}")
    
    # Check for specific CSS properties
    assert "[data-baseweb=" in dropdown_css, "Missing data-baseweb selector in CSS"
    assert "width" in dropdown_css.lower(), "Missing width-related CSS properties"

@pytest.mark.visual
async def test_dropdown_interaction(page):
    """Test dropdown interaction to ensure they work properly."""
    # Navigate to the Streamlit app
    await page.goto(f"http://localhost:{STREAMLIT_PORT}")
    
    # Wait for the app to load
    await page.wait_for_selector("[data-testid='stApp']", timeout=TIMEOUT)
    
    # Find all dropdown elements
    dropdowns = await page.query_selector_all("[data-baseweb='select']")
    
    # Ensure we found at least one dropdown
    assert len(dropdowns) > 0, "No dropdown elements found"
    
    for i, dropdown in enumerate(dropdowns):
        # Get the initial selected value
        initial_value = await dropdown.evaluate("""element => {
            const valueElement = element.querySelector('[data-testid="stSelectboxLabel"]');
            return valueElement ? valueElement.textContent : null;
        }""")
        
        # Click to open the dropdown
        await dropdown.click()
        
        # Wait for the dropdown menu to appear
        dropdown_menu = await page.wait_for_selector("[data-baseweb='menu']", timeout=5000)
        assert dropdown_menu, f"Dropdown menu {i} did not appear"
        
        # Get all options in the dropdown
        options = await dropdown_menu.query_selector_all("[role='option']")
        assert len(options) > 0, f"No options found in dropdown {i}"
        
        # Select a different option (the second option if available)
        if len(options) > 1:
            await options[1].click()
        else:
            await options[0].click()
        
        # Wait for the page to update
        await page.wait_for_timeout(1000)
        
        # Get the new selected value
        new_value = await dropdown.evaluate("""element => {
            const valueElement = element.querySelector('[data-testid="stSelectboxLabel"]');
            return valueElement ? valueElement.textContent : null;
        }""")
        
        # Log the values for debugging
        print(f"Dropdown {i}: Initial value: '{initial_value}', New value: '{new_value}'")
        
        # If we selected a different option, the value should have changed
        if len(options) > 1:
            assert new_value != initial_value, f"Dropdown {i} value did not change after selection"

if __name__ == "__main__":
    pytest.main(["-xvs", __file__])
