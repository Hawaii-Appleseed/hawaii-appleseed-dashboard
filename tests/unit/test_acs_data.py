"""Offline unit tests for ACSDataFetcher derived metrics, MOE propagation, and
request chunk-merging. No network/API key needed: we bypass ``__init__`` (which
otherwise makes a live Census connection test) via ``__new__`` and exercise the
pure-DataFrame methods directly."""
import math

import numpy as np
import pandas as pd
import pytest

from data.acs_data import ACSDataFetcher


@pytest.fixture
def fetcher():
    # Bypass __init__ (it calls _test_connection -> live API). The methods under
    # test operate purely on the passed DataFrame and class attributes.
    return ACSDataFetcher.__new__(ACSDataFetcher)


# ── Derived metrics ──────────────────────────────────────────────────────────

def test_derived_metrics(fetcher):
    df = pd.DataFrame([{
        'below_poverty': 100, 'total_population': 1000,        # poverty 10%
        'aggregate_vehicles': 900, 'veh_hh_total': 500,        # 1.8 veh/hh
        'veh_hh_0': 50,                                        # 10% zero-vehicle
        'walked_workers': 20, 'bicycle_workers': 10, 'total_workers': 1000,  # 3% active
        'aggregate_travel_time': 26000, 'b08303_001e': 1000,  # 26 min commute
        'total_resident_population': 1500,                     # 0.6 veh/capita
    }])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    assert out['poverty_rate'] == pytest.approx(10.0)
    assert out['avg_vehicles_per_household'] == pytest.approx(1.8)
    assert out['zero_vehicle_household_pct'] == pytest.approx(10.0)
    assert out['active_transportation_pct'] == pytest.approx(3.0)
    assert out['travel_time_to_work_minutes'] == pytest.approx(26.0)
    assert out['vehicles_per_capita'] == pytest.approx(0.6)


def test_bachelors_or_higher_includes_graduate_degrees(fetcher):
    # B15003_022E is bachelor's only; "bachelor's or higher" adds master's,
    # professional and doctorate (_023E–_025E), and so does its MOE.
    df = pd.DataFrame([{
        'edu_bachelors': 200, 'edu_masters': 80, 'edu_professional': 15, 'edu_doctorate': 5,
        'pop_25_plus': 1000,
        'b15003_022m': 30, 'b15003_023m': 20, 'b15003_024m': 8, 'b15003_025m': 4,
        'b15003_001m': 0,
    }])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    assert out['bachelors_plus'] == 300
    assert out['college_educated_pct'] == pytest.approx(30.0)
    expected_moe = math.sqrt(30**2 + 20**2 + 8**2 + 4**2) / 1000 * 100  # ≈ 3.71
    assert out['college_educated_pct_moe'] == pytest.approx(round(expected_moe, 2), abs=0.01)


# ── MOE propagation ──────────────────────────────────────────────────────────

def test_moe_subset_proportion(fetcher):
    # poverty rate is a subset proportion: MOE = sqrt(m_num^2 - p^2*m_den^2)/den*100
    df = pd.DataFrame([{
        'below_poverty': 100, 'total_population': 1000,
        'b17001_002m': 10, 'b17001_001m': 30,
    }])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    expected = math.sqrt(10**2 - 0.1**2 * 30**2) / 1000 * 100  # ≈ 0.954
    assert out['poverty_rate_moe'] == pytest.approx(round(expected, 2), abs=0.01)


def test_moe_direct_median_passthrough(fetcher):
    df = pd.DataFrame([{'median_income': 100000, 'b19013_001m': 1121}])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    assert out['median_income_moe'] == pytest.approx(1121)


def test_moe_ratio(fetcher):
    # vehicles per household is a ratio: MOE = sqrt(m_num^2 + r^2*m_den^2)/den
    df = pd.DataFrame([{
        'aggregate_vehicles': 900, 'veh_hh_total': 500,
        'b25046_001m': 40, 'b08201_001m': 20,
    }])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    r = 1.8
    expected = math.sqrt(40**2 + (r**2) * 20**2) / 500  # ≈ 0.108
    assert out['avg_vehicles_per_household_moe'] == pytest.approx(round(expected, 2), abs=0.01)


def test_jam_value_controlled_count_is_zero_error(fetcher):
    # A controlled count denominator (-555555555) -> 0 sampling error, so the
    # proportion MOE is finite (driven by the numerator only), never NaN.
    df = pd.DataFrame([{
        'white_aoic': 400, 'race_total_pop': 1000,
        'b02008_001m': 50, 'b02001_001m': -555555555,
    }])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    assert not pd.isna(out['white_pct_moe'])
    assert out['white_pct_moe'] == pytest.approx(50 / 1000 * 100, abs=0.01)  # 5.0


def test_jam_value_median_is_nan(fetcher):
    # For a median, -555555555 means "not calculable" -> NaN (not a false ±0).
    df = pd.DataFrame([{'median_income': 100000, 'b19013_001m': -555555555}])
    out = fetcher.calculate_poverty_rate(df).iloc[0]
    assert pd.isna(out['median_income_moe'])


# ── Request chunk-merge (batched path) ───────────────────────────────────────

def test_get_acs_data_chunk_merge(fetcher):
    # Two fixture chunks sharing geoid; metrics span the chunk boundary so the
    # merge must combine them before a single derive pass.
    chunk1 = pd.DataFrame({'geoid': ['15001', '15003'],
                           'below_poverty': [100, 200], 'total_population': [1000, 2000]})
    chunk2 = pd.DataFrame({'geoid': ['15001', '15003'],
                           'aggregate_vehicles': [900, 1800], 'veh_hh_total': [500, 1000]})
    chunks = iter([chunk1, chunk2])
    fetcher._get_acs_data_single = lambda *a, **k: next(chunks)

    # >45 variables forces the batched path (45 + 5 -> 2 chunks -> 2 calls).
    result = fetcher.get_acs_data([f'V{i}' for i in range(50)])

    assert {'poverty_rate', 'avg_vehicles_per_household'}.issubset(result.columns)
    row = result.set_index('geoid').loc['15001']
    assert row['poverty_rate'] == pytest.approx(10.0)            # 100/1000
    assert row['avg_vehicles_per_household'] == pytest.approx(1.8)  # 900/500
