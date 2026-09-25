#!/usr/bin/env python3
"""
Match Schools to Legislative Districts

This script matches public schools to their respective Hawaii State House and Senate districts
using school location data and district boundary GeoJSON files.
"""
import json
import csv
import math
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Union
import logging
import pandas as pd

# Set up logging
logging.basicConfig(
    level=logging.DEBUG,  # Set to DEBUG for more detailed logging
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('school_district_matching.log')
    ]
)
logger = logging.getLogger(__name__)

# Project directories
PROJECT_ROOT = Path(__file__).parent.parent
DATA_DIR = PROJECT_ROOT / 'data'
RAW_DATA = DATA_DIR / 'raw'
PROCESSED_DATA = DATA_DIR / 'processed'
GEOJSON_DIR = DATA_DIR / 'Processed GeoJsons'

# Input files
SCHOOLS_GEOJSON = RAW_DATA / 'Public_Schools.geojson'
CEP_CSV = RAW_DATA / 'cep_schools.csv'
HOUSE_DISTRICTS = GEOJSON_DIR / 'Hawaii_State_House_Districts_2022.geojson'
SENATE_DISTRICTS = GEOJSON_DIR / 'Hawaii_State_Senate_Districts_2022.geojson'

# Output file
OUTPUT_CSV = PROCESSED_DATA / 'schools_with_districts.csv'

# A school on a district line can land in the sliver between two boundaries
# (Ilima Intermediate, on Fort Weaver Road); it takes the nearest district
# within this distance.
NEAREST_DISTRICT_MAX_M = 100


def distance_to_ring_m(point: Tuple[float, float], ring: List[Tuple[float, float]]) -> float:
    """Approximate distance in metres from a (lon, lat) point to a ring's edges."""
    lon, lat = point
    kx = 111_320 * math.cos(math.radians(lat))  # metres per degree of longitude here
    ky = 110_574                                  # metres per degree of latitude
    best = math.inf
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        ax, ay = (x1 - lon) * kx, (y1 - lat) * ky
        dx, dy = (x2 - x1) * kx, (y2 - y1) * ky
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy or 1)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best

def point_in_polygon(point: Tuple[float, float], polygon: List[Tuple[float, float]]) -> bool:
    """
    Determine if a point is inside a polygon using the ray casting algorithm.
    
    Args:
        point: Tuple of (longitude, latitude)
        polygon: List of (longitude, latitude) points forming the polygon
        
    Returns:
        bool: True if point is inside the polygon
    """
    x, y = point
    n = len(polygon)
    inside = False
    
    p1x, p1y = polygon[0]
    for i in range(n + 1):
        p2x, p2y = polygon[i % n]
        if y > min(p1y, p2y):
            if y <= max(p1y, p2y):
                if x <= max(p1x, p2x):
                    if p1y != p2y:
                        xinters = (y - p1y) * (p2x - p1x) / (p2y - p1y) + p1x
                    if p1x == p2x or x <= xinters:
                        inside = not inside
        p1x, p1y = p2x, p2y
    
    return inside

def load_geojson(file_path: Path) -> dict:
    """Load a GeoJSON file."""
    try:
        with open(file_path, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Error loading {file_path}: {e}")
        raise

def load_cep_data() -> List[dict]:
    """Load and clean CEP school data."""
    cep_data = []
    try:
        with open(CEP_CSV, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                # Clean and standardize the data
                row['is_cep'] = row.get('is_cep', '').strip() == 'X'
                try:
                    row['enrollment'] = int(row.get('enrollment', '0').replace(',', '').strip() or '0')
                except (ValueError, AttributeError):
                    row['enrollment'] = 0
                cep_data.append(row)
        logger.info(f"Loaded CEP data for {len(cep_data)} schools")
        return cep_data
    except Exception as e:
        logger.error(f"Error loading CEP data: {e}")
        raise

def process_districts(geojson_data: dict, district_type: str = 'house') -> Dict[str, dict]:
    """
    Process district GeoJSON into a more usable format.
    
    Args:
        geojson_data: Loaded GeoJSON data
        district_type: Type of district ('house' or 'senate')
        
    Returns:
        Dict mapping district IDs to their properties and coordinates
    """
    districts = {}
    for feature in geojson_data.get('features', []):
        props = feature.get('properties', {})
        geom = feature.get('geometry', {})
        
        # Try different possible ID fields based on district type
        if district_type.lower() == 'senate':
            # For senate districts, use state_senate property (e.g., "S01")
            district_id = props.get('state_senate')
            if district_id and district_id.startswith('S'):
                # Convert to just the number (e.g., "S01" -> "1")
                district_id = district_id[1:].lstrip('0')
        else:
            # For house districts, try various possible ID fields
            district_id = props.get('GEOID') or props.get('state_house') or props.get('house_abbr')
        
        if not district_id:
            logger.warning(f"No district ID found in properties: {props.keys()}")
            continue
            
        # Extract coordinates (handle different GeoJSON geometries)
        coordinates = []
        if geom['type'] == 'Polygon':
            coordinates = geom['coordinates'][0]  # Take the exterior ring
        elif geom['type'] == 'MultiPolygon':
            # Take the first polygon's exterior ring
            coordinates = geom['coordinates'][0][0] if geom['coordinates'] else []
        
        if not coordinates:
            logger.warning(f"No coordinates found for district {district_id}")
            continue
        
        # Get district name based on district type
        if district_type.lower() == 'senate':
            name = props.get('senate_name', f"State Senate District {district_id}")
        else:
            name = props.get('house_name', f"House District {district_id}")
            
        districts[district_id] = {
            'name': name,
            'coordinates': coordinates,
            'type': district_type
        }
    
    logger.info(f"Processed {len(districts)} districts")
    if not districts:
        logger.error("No districts were processed. Check the GeoJSON structure and property names.")
        logger.error(f"Sample feature properties: {next(iter(geojson_data.get('features', [{}])), {}).get('properties', {})}")
    return districts

def find_district(school_point: Tuple[float, float], districts: Dict[str, dict]) -> Optional[str]:
    """
    Find which district a school point is in.
    
    Args:
        school_point: Tuple of (longitude, latitude)
        districts: Dictionary of district data from process_districts()
        
    Returns:
        str: District ID if found, None otherwise
    """
    if not school_point or len(school_point) != 2:
        logger.warning(f"Invalid school point: {school_point}")
        return None
        
    lon, lat = school_point
    logger.debug(f"Checking point at ({lon}, {lat}) against {len(districts)} districts")
    
    # First check if point is in Molokai or Lanai
    molokai = (-157.5 <= lon <= -156.7) and (20.8 <= lat <= 21.3)
    lanai = (-157.0 <= lon <= -156.8) and (20.7 <= lat <= 20.9)
    
    # Get district type from first district (if available) or default to house
    district_type = next(iter(districts.values()), {}).get('type', 'house')
    
    if molokai or lanai:
        if district_type == 'senate':
            # Molokai and Lanai are in Senate District 7 (SD07)
            logger.info(f"Assigning Molokai/Lanai school at ({lon:.4f}, {lat:.4f}) to SD07")
            return "7"
        else:
            # For house districts, Molokai and Lanai are in H13
            logger.info(f"Assigning Molokai/Lanai school at ({lon:.4f}, {lat:.4f}) to H13")
            return "H13"
    
    for district_id, district in districts.items():
        if not district.get('coordinates'):
            logger.debug(f"Skipping district {district_id}: no coordinates")
            continue
            
        # Convert to list of (x,y) tuples
        try:
            polygon = [(float(coord[0]), float(coord[1])) for coord in district['coordinates']]
            if not polygon:
                logger.debug(f"Skipping district {district_id}: empty polygon")
                continue
                
            # Log the first and last points of the polygon for debugging
            logger.debug(f"Checking district {district_id} with {len(polygon)} points")
            min_lon = min(p[0] for p in polygon)
            min_lat = min(p[1] for p in polygon)
            max_lon = max(p[0] for p in polygon)
            max_lat = max(p[1] for p in polygon)
            logger.debug(f"  Polygon bounds: ({min_lon:.2f}, {min_lat:.2f}) to ({max_lon:.2f}, {max_lat:.2f})")
            
            if point_in_polygon(school_point, polygon):
                logger.info(f"Found match for point ({lon:.4f}, {lat:.4f}) in district {district_id}")
                return district_id
                
        except Exception as e:
            logger.warning(f"Error checking district {district_id}: {e}", exc_info=True)

    nearest = min(
        ((distance_to_ring_m(school_point, [(float(c[0]), float(c[1])) for c in d['coordinates']]), district_id)
         for district_id, d in districts.items() if d.get('coordinates')),
        default=None,
    )
    if nearest and nearest[0] <= NEAREST_DISTRICT_MAX_M:
        logger.info(f"Point ({lon:.4f}, {lat:.4f}) is in no district; nearest is {nearest[1]}, {nearest[0]:.0f} m away")
        return nearest[1]

    logger.debug(f"No district found for point ({lon:.4f}, {lat:.4f})")
    return None

def clean_school_name(name: str) -> str:
    """Clean and standardize school names for matching."""
    if not name:
        return ""
    
    # Convert to lowercase and remove common suffixes/words
    name = name.lower().strip()
    for suffix in ['elementary', 'middle', 'high', 'school', 'academy', 
                  'public', 'charter', 'intermediate', '&', 'and']:
        name = name.replace(suffix, '')
    
    # Remove extra whitespace and special characters
    name = ' '.join(name.split())
    return name

def main():
    """Main function to process the data."""
    try:
        # Ensure output directory exists
        PROCESSED_DATA.mkdir(parents=True, exist_ok=True)
        
        logger.info("Starting school to district matching...")
        
        # Load CEP data
        cep_schools = load_cep_data()
        cep_by_id = {row.get('school_id', '').strip(): row for row in cep_schools}
        
        # Load school locations
        logger.info(f"Loading school locations from {SCHOOLS_GEOJSON}")
        schools_geojson = load_geojson(SCHOOLS_GEOJSON)
        
        # Load district boundaries
        logger.info("Processing district boundaries...")
        house_districts = process_districts(load_geojson(HOUSE_DISTRICTS), 'house')
        senate_districts = process_districts(load_geojson(SENATE_DISTRICTS), 'senate')
        
        # Prepare output
        output = []
        matched_count = 0
        
        # Process each school
        logger.info("Matching schools to districts...")
        for school_feature in schools_geojson.get('features', []):
            props = school_feature.get('properties', {})
            geom = school_feature.get('geometry', {})
            
            if geom['type'] != 'Point' or not geom.get('coordinates'):
                continue
                
            # Get school coordinates (longitude, latitude)
            lon, lat = geom['coordinates']
            
            # Clean school name for matching
            school_name = props.get('sch_name', '')
            clean_name = clean_school_name(school_name)
            
            # Find matching CEP data: by DOE school code first. Name matching
            # alone paired schools that share a word ("Aiea High" with Aiea
            # Elementary, "Kalihi Kai" with Kalihi Elementary), mis-flagging 24
            # schools. It's kept only as a fallback for charter schools, whose
            # codes in the CEP list ("275-PCS") don't line up with sch_code.
            cep_match = cep_by_id.get(str(props.get('sch_code', '')).strip())
            if cep_match is None:
                for cep_school in cep_schools:
                    cep_name = clean_school_name(cep_school.get('school_name', ''))
                    if clean_name and cep_name and (clean_name in cep_name or cep_name in clean_name):
                        cep_match = cep_school
                        break
            
            # Find districts
            house_district = find_district((lon, lat), house_districts)
            senate_district = find_district((lon, lat), senate_districts)
            
            if house_district or senate_district:
                matched_count += 1
            
            # Prepare output row
            output.append({
                'school_id': props.get('sch_code', ''),
                'school_name': school_name,
                'address': props.get('address', ''),
                'city': props.get('city', ''),
                'zip': props.get('zip', ''),
                'county': props.get('county', ''),
                'longitude': lon,
                'latitude': lat,
                'house_district': house_district or 'Not found',
                'senate_district': senate_district or 'Not found',
                'is_cep': cep_match['is_cep'] if cep_match else False,
                'cep_enrollment': cep_match['enrollment'] if cep_match else 0,
                'cep_school_name': cep_match['school_name'] if cep_match else ''
            })
        
        # Save the results
        output_file = Path(OUTPUT_CSV)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_file, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=output[0].keys())
            writer.writeheader()
            writer.writerows(output)
        
        # Count schools by district
        house_dist_counts = {}
        senate_dist_counts = {}
        for school in output:
            hd = school['house_district']
            sd = school['senate_district']
            if hd != 'Not found':
                house_dist_counts[hd] = house_dist_counts.get(hd, 0) + 1
            if sd != 'Not found':
                senate_dist_counts[sd] = senate_dist_counts.get(sd, 0) + 1
        
        # Log results
        logger.info(f"\nResults saved to: {output_file}")
        logger.info(f"Total schools processed: {len(output)}")
        logger.info(f"Schools matched to house districts: {matched_count} ({matched_count/len(output)*100:.1f}%)")
        logger.info(f"CEP schools found: {sum(1 for s in output if s['is_cep'])}")
        
        logger.info("\nSchools by House District:")
        for district in sorted(house_dist_counts.keys()):
            logger.info(f"  {district}: {house_dist_counts[district]} schools")
        
        logger.info("\nSchools by Senate District:")
        for district in sorted(senate_dist_counts.keys()):
            logger.info(f"  {district}: {senate_dist_counts[district]} schools")
        
        # Generate CEP summary files
        logger.info("\nGenerating CEP summary files...")
        generate_cep_summaries(output, output_file.parent / 'cep_schools')
        
    except Exception as e:
        logger.error(f"An error occurred: {e}", exc_info=True)
        raise

def generate_cep_summaries(schools_data: List[dict], output_dir: Union[str, Path]) -> None:
    """
    Generate CEP summary files for house and senate districts in a format compatible with the dashboard.
    
    Args:
        schools_data: List of school data dictionaries
        output_dir: Directory to save the output files
    """
    # Create output directory if it doesn't exist
    os.makedirs(output_dir, exist_ok=True)
    
    # Convert to DataFrame for easier manipulation
    df = pd.DataFrame(schools_data)
    
    # Define output file paths
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    
    house_output = output_dir / 'hawaii_house_district_cep_2023.csv'
    senate_output = output_dir / 'hawaii_senate_district_cep_2023.csv'
    
    def _generate_summary(df: pd.DataFrame, district_col: str, district_type: str) -> pd.DataFrame:
        """
        Helper function to generate summary for a district type.
        
        Args:
            df: Input DataFrame with school data
            district_col: Name of the district column to group by
            district_type: Either 'house' or 'senate'
            
        Returns:
            DataFrame with summary statistics
        """
        # Group by district and calculate summary statistics
        summary = df.groupby(district_col).agg(
            total_schools=('is_cep', 'count'),
            cep_schools=('is_cep', 'sum'),
            total_enrollment=('cep_enrollment', 'sum')
        ).reset_index()
        
        # Calculate derived metrics
        summary['cep_percentage'] = (summary['cep_schools'] / summary['total_schools']) * 100
        summary['cep_display'] = summary.apply(
            lambda x: f"{int(x['cep_schools'])}/{int(x['total_schools'])} CEP schools", 
            axis=1
        )
        
        # Add standard columns to match SNAP data format
        summary['NAME'] = summary[district_col].apply(
            lambda x: f"{'State House' if district_type == 'house' else 'State Senate'} District {x.replace('H', '').replace('S', '')}; Hawaii; Hawaii"
        )
        summary['state'] = '15'  # FIPS code for Hawaii
        
        # Add district number column (numeric part only)
        summary['district'] = summary[district_col].str.extract(r'(\d+)').astype(int)
        
        # Create GEOID (15 + 2-digit district number for house, 15 + 3-digit for senate)
        if district_type == 'house':
            summary['geoid'] = '15' + summary['district'].astype(str).str.zfill(2)
        else:  # senate
            summary['geoid'] = '15' + summary['district'].astype(str).str.zfill(3)
        
        # Calculate average enrollment per school
        summary['avg_enrollment'] = (summary['total_enrollment'] / summary['total_schools']).round(0).astype(int)
        
        # Calculate estimated students in CEP schools
        summary['cep_students'] = (summary['cep_percentage'] / 100 * summary['total_enrollment']).round(0).astype(int)
        
        # Select and order columns to match the expected format
        columns = [
            'NAME', 'state', 'district', 'geoid',
            'total_schools', 'cep_schools', 'cep_percentage', 'cep_display',
            'total_enrollment', 'cep_students', 'avg_enrollment'
        ]
        
        return summary[columns]
    
    # Generate and save house district summary
    house_summary = _generate_summary(df, 'house_district', 'house')
    house_summary.to_csv(house_output, index=False)
    logger.info(f"Saved house district CEP summary to {house_output}")
    
    # Generate and save senate district summary
    senate_summary = _generate_summary(df, 'senate_district', 'senate')
    senate_summary.to_csv(senate_output, index=False)
    logger.info(f"Saved senate district CEP summary to {senate_output}")
    
    # Log summary statistics
    total_schools = len(df)
    cep_schools = df['is_cep'].sum()
    cep_percentage = (cep_schools / total_schools) * 100
    logger.info(f"\nCEP Summary Statistics:")
    logger.info(f"Total schools: {total_schools}")
    logger.info(f"CEP schools: {cep_schools} ({cep_percentage:.1f}%)")
    logger.info(f"House districts: {len(house_summary)}")
    logger.info(f"Senate districts: {len(senate_summary)}")

if __name__ == "__main__":
    main()
