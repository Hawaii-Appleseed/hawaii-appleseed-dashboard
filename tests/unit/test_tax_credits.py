"""Checks for scripts/build_tax_credits.py against the committed inputs in
data/raw/tax_credits/ and the committed outputs in data/processed/tax_credits/."""
import csv
import filecmp
import importlib.util
from collections import defaultdict
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_tax_credits', ROOT / 'scripts' / 'build_tax_credits.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


@pytest.fixture(scope='module')
def zip_data():
    return build.read_zip_data()


def committed(level):
    with open(ROOT / 'data' / 'processed' / 'tax_credits' / f'hawaii_{level}_tax_credits_{build.YEAR}.csv') as f:
        return list(csv.DictReader(f))


def test_ctc_amount_is_the_refundable_credit(zip_data):
    # The earlier files took the CTC amount from the next column over (EITC
    # with one qualifying child, $62,978K), halving every average.
    state, _ = zip_data
    assert state['ctc_n'] == 60600
    assert state['ctc_a'] == 117786
    assert 1500 < 1000 * state['ctc_a'] / state['ctc_n'] < 2500


@pytest.mark.parametrize('target', ['sldl22', 'sldu22'])
def test_zip_allocation_adds_up_to_the_state(zip_data, target):
    state, zips = zip_data
    totals, population = build.allocate(zips, build.read_crosswalk(target))
    assert len(totals) == {'sldl22': 51, 'sldu22': 25}[target]
    for m in build.MEASURES:
        # SOI rounds each ZIP's counts to the nearest 10 and amounts to the
        # nearest $1,000, so ZIP sums miss the state total by up to that much.
        slack = (5 if m in ('returns', 'eitc_n', 'ctc_n') else 0.5) * len(zips)
        assert sum(t[m] for t in totals.values()) == pytest.approx(state[m], abs=slack)
    assert sum(population.values()) == pytest.approx(1455271)


def test_state_eitc_estimate_matches_reported_claims():
    # 40% of the federal EITC on 2023 returns, against the credits the
    # Department of Taxation reports for 2023: 78,094 claims, $73,258,049.
    state, _ = build.read_county_data(build.YEAR)
    claims, amount = build.read_state_eitc_claims()
    assert (claims, amount) == (78094, 73258049)
    estimate = build.STATE_EITC_SHARE * 1000 * state['eitc_a'] / state['eitc_n']
    assert estimate == pytest.approx(amount / claims, rel=0.02)


@pytest.mark.parametrize('level,target', [('house_district', 'sldl22'), ('senate_district', 'sldu22')])
def test_districts_add_up_to_the_counties(level, target):
    county_of = {int(d): fips for d, fips in
                 build.district_counties(build.read_crosswalk(target), build.read_crosswalk('county')).items()}
    sums = defaultdict(lambda: defaultdict(float))
    rows = committed(level)
    for r in rows:
        for col in ('total_returns', 'eitc_returns', 'federal_eitc_total_amount', 'ctc_returns', 'ctc_total_amount'):
            sums[county_of[int(r['district'])]][col] += float(r[col])
    for county in committed('county'):
        for col, total in sums[county['geoid']].items():
            # Counts are written to 0.1 and amounts to $1 per district.
            assert total == pytest.approx(float(county[col]), abs=len(rows)), (county['NAME'], col)


def test_committed_files_match_a_fresh_build(tmp_path, monkeypatch):
    monkeypatch.setattr(build, 'OUT', tmp_path)
    assert build.main() == 0
    for fresh in sorted(tmp_path.iterdir()):
        committed_file = ROOT / 'data' / 'processed' / 'tax_credits' / fresh.name
        assert filecmp.cmp(fresh, committed_file, shallow=False), f'{fresh.name} differs from a fresh build'
