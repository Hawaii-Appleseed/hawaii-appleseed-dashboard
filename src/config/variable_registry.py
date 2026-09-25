"""
Centralized variable registry for the Hawaii Appleseed Dashboard.

All variable definitions live in variables.json. This module loads that file
once and provides accessor functions used by the UI and data layers.
"""

import json
import os
from functools import lru_cache
from typing import Dict, List, Optional, Any


_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "variables.json")
_DATA_SOURCES_PATH = os.path.join(os.path.dirname(__file__), "data_sources.json")


_UNIT_SUFFIX = {"percentage": " (%)", "currency": " ($)"}


def _expand(key: str, entry: dict) -> dict:
    """Fill in the fields a variables.json entry may leave out.

    Mirrors expandVariable() in web/scripts/variables-config.mjs, which builds
    the copy the web app loads (that file lists the defaults); keep the two in
    step.
    """
    v = dict(entry)
    v.setdefault("display_name_long", v["display_name"] + _UNIT_SUFFIX.get(v.get("data_type"), ""))
    v.setdefault("dropdown_label", v["display_name_long"])
    v.setdefault("show_in_dropdown", True)
    v.setdefault("dropdown_group", None)
    v.setdefault("info_panel_category", None)
    v.setdefault("info_panel_label", None if v["info_panel_category"] is None else v["display_name"])
    v.setdefault("info_panel_order", None)
    v.setdefault("show_in_info_panel", v["info_panel_category"] is not None)
    v.setdefault("fact_sheet_category", None)
    v.setdefault("fact_sheet_label", None if v["fact_sheet_category"] is None else v["display_name"])
    v.setdefault("show_in_fact_sheet", v["fact_sheet_category"] is not None)
    v.setdefault("show_in_default_metrics", v["show_in_info_panel"])
    v.setdefault("is_special_variable", False)
    v.setdefault("legend_direction", "neutral")
    v.setdefault("csv_column", key)
    v.setdefault("data_source", None)
    v.setdefault("description", "")
    return v


@lru_cache(maxsize=1)
def _load_config() -> dict:
    with open(_CONFIG_PATH, "r") as f:
        config = json.load(f)
    config["variables"] = {k: _expand(k, v) for k, v in config["variables"].items()}
    return config


@lru_cache(maxsize=1)
def _load_data_sources() -> dict:
    """Load data_sources.json (single source of truth for per-source years)."""
    with open(_DATA_SOURCES_PATH, "r") as f:
        return json.load(f)["sources"]


def get_all_variables() -> Dict[str, dict]:
    """Return the full variables dict from config."""
    return _load_config()["variables"]


# ---------------------------------------------------------------------------
# Valid variable keys
# ---------------------------------------------------------------------------

def get_valid_variable_keys() -> List[str]:
    """All variable keys known to the dashboard (replaces valid_variables list)."""
    return list(get_all_variables().keys())


def get_special_variable_keys() -> List[str]:
    """Variables that are merged from separate data sources."""
    return [k for k, v in get_all_variables().items() if v.get("is_special_variable")]


# ---------------------------------------------------------------------------
# DEFAULT_METRICS — ordered list of {key, label, type} for the info panel
# ---------------------------------------------------------------------------

def get_default_metrics() -> List[dict]:
    """Return the DEFAULT_METRICS list (replaces the hardcoded list in leaflet_component.py)."""
    variables = get_all_variables()
    metrics = []
    for key, v in variables.items():
        if v.get("show_in_default_metrics"):
            metrics.append({
                "key": key,
                "label": v["display_name"],
                "type": v["data_type"],
            })
    return metrics


# ---------------------------------------------------------------------------
# Display-name mappings
# ---------------------------------------------------------------------------

def get_display_names(long: bool = False) -> Dict[str, str]:
    """
    Map of variable_key -> display name.
    If long=True, uses display_name_long (includes units).
    Replaces both variable_display_names dicts in leaflet_map_view.py.
    """
    field = "display_name_long" if long else "display_name"
    return {k: v[field] for k, v in get_all_variables().items()}


def get_display_name(key: str, long: bool = False) -> str:
    """Display name for a single variable, with fallback."""
    names = get_display_names(long=long)
    return names.get(key, key.replace("_", " ").title())


# ---------------------------------------------------------------------------
# Dropdown helpers
# ---------------------------------------------------------------------------

def get_dropdown_groups() -> Dict[str, dict]:
    """Return dropdown group definitions, sorted by order."""
    groups = _load_config()["dropdown_groups"]
    return dict(sorted(groups.items(), key=lambda x: x[1]["order"]))


def get_variables_for_dropdown(group: str) -> List[dict]:
    """
    Return sorted list of {key, label} for a given dropdown group.
    Replaces the hardcoded st.selectbox option lists in leaflet_map_view.py.
    """
    variables = get_all_variables()
    items = []
    for key, v in variables.items():
        if v.get("show_in_dropdown") and v.get("dropdown_group") == group:
            items.append({
                "key": key,
                "label": v["dropdown_label"],
                "order": v.get("dropdown_order", 999),
            })
    items.sort(key=lambda x: x["order"])
    return [{"key": i["key"], "label": i["label"]} for i in items]


# ---------------------------------------------------------------------------
# Info-panel categories (injected as JSON into JS iframe template)
# ---------------------------------------------------------------------------

def get_info_panel_categories() -> Dict[str, List[dict]]:
    """
    Return info-panel categories as {category_name: [{key, label, type}, ...]}.
    Sorted by category order, then by variable info_panel_order within each.
    """
    cat_order = _load_config()["info_panel_categories"]
    variables = get_all_variables()

    categories: Dict[str, List[dict]] = {}
    for key, v in variables.items():
        cat = v.get("info_panel_category")
        if not cat or not v.get("show_in_info_panel"):
            continue
        categories.setdefault(cat, []).append({
            "key": key,
            "label": v["info_panel_label"],
            "type": v["data_type"],
            # _expand() stores None when the entry leaves it out; sort those
            # last, as the web app does (`info_panel_order || 999`).
            "_order": v.get("info_panel_order") or 999,
        })

    # Sort variables within each category
    for cat in categories:
        categories[cat].sort(key=lambda x: x["_order"])
        for item in categories[cat]:
            del item["_order"]

    # Sort categories by their defined order
    sorted_cats = {}
    for cat_name in sorted(categories.keys(), key=lambda c: cat_order.get(c, {}).get("order", 999)):
        sorted_cats[cat_name] = categories[cat_name]
    return sorted_cats


def get_info_panel_categories_json() -> str:
    """JSON string ready for injection into JS template (no f-string brace escaping needed)."""
    return json.dumps(get_info_panel_categories())


# ---------------------------------------------------------------------------
# Color thresholds (injected as JSON into JS iframe template)
# ---------------------------------------------------------------------------

def get_color_thresholds() -> Dict[str, List]:
    """Map of variable_key -> threshold array for getColorForValue()."""
    variables = get_all_variables()
    return {k: v["color_thresholds"] for k, v in variables.items() if v.get("color_thresholds")}


def get_color_thresholds_json() -> str:
    """JSON string ready for injection into JS template."""
    return json.dumps(get_color_thresholds())


def get_default_color_thresholds() -> List:
    """Fallback thresholds when a variable has no explicit thresholds."""
    return _load_config()["default_color_thresholds"]


def get_default_color_thresholds_json() -> str:
    return json.dumps(get_default_color_thresholds())


# ---------------------------------------------------------------------------
# Legend direction + display names (injected into JS for legend indicator)
# ---------------------------------------------------------------------------

def get_legend_meta() -> Dict[str, dict]:
    """Map of variable_key -> {direction, display_name_long} for JS legend."""
    variables = get_all_variables()
    return {
        k: {
            "direction": v.get("legend_direction", "neutral"),
            "label": v.get("display_name_long", v.get("display_name", k)),
        }
        for k, v in variables.items()
    }


def get_legend_meta_json() -> str:
    """JSON string ready for injection into JS template."""
    return json.dumps(get_legend_meta())


# ---------------------------------------------------------------------------
# Data source + vintage year (for tooltip/attribution display)
#
# Each variable has a `data_source` pointer (e.g. "acs", "snap") into
# data_sources.json, which is the single source of truth for the year
# that data was published. Display strings are composed at read time
# from that pointer — so when the year for a source is updated in
# data_sources.json, every label that mentions that source updates too.
#
# The old hardcoded `source` string (e.g. "American Community Survey
# 2023") is kept on each variable as a fallback for cases where the
# data_source pointer is missing, but the registry now prefers the
# composed label.
# ---------------------------------------------------------------------------

def get_variable_data_source_key(key: str) -> Optional[str]:
    """The `data_source` pointer for a variable (e.g. "acs"), or None."""
    return get_all_variables().get(key, {}).get("data_source")


def get_variable_year(key: str) -> Optional[int]:
    """Return the data-vintage year for a variable, or None.

    Looks up the variable's data_source pointer in data_sources.json
    and returns sources[that_pointer].year.
    """
    ds_key = get_variable_data_source_key(key)
    if not ds_key:
        return None
    return _load_data_sources().get(ds_key, {}).get("year")


def get_variable_source(key: str) -> str:
    """Return the full source attribution string for a variable.

    Composes "<short_label> <year>" from data_sources.json when the
    variable has a `data_source` pointer. Falls back to the hardcoded
    `source` field on the variable otherwise.
    """
    ds_key = get_variable_data_source_key(key)
    if ds_key:
        meta = _load_data_sources().get(ds_key, {})
        label = meta.get("short_label") or meta.get("label") or ds_key
        year = meta.get("year")
        return f"{label} {year}" if year else label
    # Legacy fallback: the freeform string baked into variables.json
    return get_all_variables().get(key, {}).get("source", "")


def get_data_source_meta(source_key: str) -> dict:
    """Return the full data_sources.json entry for a source key, or {}."""
    return _load_data_sources().get(source_key, {})


# ---------------------------------------------------------------------------
# Fact-sheet helpers
# ---------------------------------------------------------------------------

def get_fact_sheet_categories() -> Dict[str, dict]:
    """Return fact-sheet tab definitions sorted by order."""
    cats = _load_config()["fact_sheet_categories"]
    return dict(sorted(cats.items(), key=lambda x: x[1]["order"]))


def get_fact_sheet_variables(category_key: str) -> List[dict]:
    """Variables shown in a given fact-sheet tab, sorted by fact_sheet_label."""
    variables = get_all_variables()
    items = []
    for key, v in variables.items():
        if v.get("show_in_fact_sheet") and v.get("fact_sheet_category") == category_key:
            items.append({
                "key": key,
                "label": v["fact_sheet_label"],
                "data_type": v["data_type"],
            })
    return items


# ---------------------------------------------------------------------------
# Available-variables dict (replaces _get_available_variables in data_loader)
# ---------------------------------------------------------------------------

def get_available_variables() -> Dict[str, str]:
    """Map of variable_key -> long display name (replaces data_loader._get_available_variables)."""
    return get_display_names(long=True)
