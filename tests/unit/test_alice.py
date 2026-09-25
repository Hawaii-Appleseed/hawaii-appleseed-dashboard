"""Checks for scripts/build_alice.py and the ALICE workbook it writes, which
the data pipeline reads."""
import filecmp
import importlib.util
from pathlib import Path

import pytest

from data.data_loader import DataLoader, DataType, GeoLevel

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_alice', ROOT / 'scripts' / 'build_alice.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


@pytest.fixture(scope='module')
def sheets():
    return build.build()


def test_committed_workbook_matches_a_fresh_build(tmp_path, monkeypatch):
    committed = build.OUT
    monkeypatch.setattr(build, 'OUT', tmp_path / committed.name)
    assert build.main() == 0
    assert filecmp.cmp(tmp_path / committed.name, committed, shallow=False)


def test_state_and_counties_are_the_published_alice_shares(sheets):
    # United For ALICE, Hawaii, 2024: 164,744 of 493,475 households ALICE (33%).
    assert sheets['State'][1] == ['Hawaii', 33.4, 493475, 51810, 164744]
    assert {r[0]: r[1] for r in sheets['Counties'][1:]} == \
        {'Hawaii': 37.3, 'Honolulu': 31.7, 'Kauai': 36.9, 'Maui': 36.8}


@pytest.mark.parametrize('chamber', ['House', 'Senate'])
def test_districts_add_up_to_the_state(sheets, chamber):
    # ALICE only, as for the counties -- not "below the ALICE Threshold"
    # (poverty plus ALICE, about 44%), which the earlier district sheets held.
    rows = sheets[chamber][1:]
    assert len(rows) == {'House': 51, 'Senate': 25}[chamber]
    assert sum(r[2] for r in rows) == pytest.approx(493475, abs=len(rows))
    assert 100 * sum(r[4] for r in rows) / sum(r[2] for r in rows) == pytest.approx(33.4, abs=0.05)


def test_kauai_senate_district_is_kauai_county(sheets):
    # Senate District 8 is all of Kauaʻi County (with Niʻihau).
    assert {r[0]: r for r in sheets['Senate'][1:]}[8][1:] == \
        {r[0]: r for r in sheets['Counties'][1:]}['Kauai'][1:]


@pytest.mark.parametrize('level,count', [(GeoLevel.STATE, 1), (GeoLevel.COUNTY, 4), (GeoLevel.HOUSE, 51), (GeoLevel.SENATE, 25)])
def test_pipeline_reads_the_workbook(level, count):
    df = DataLoader().loaders[DataType.ALICE].load_data(level)
    assert len(df) == count
    assert df['alice_rate'].between(10, 60).all()
