"""Checks for scripts/build_tax_credits.py against the committed IRS inputs in
data/raw/tax_credits/ and the committed outputs in data/processed/tax_credits/."""
import filecmp
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('build_tax_credits', ROOT / 'scripts' / 'build_tax_credits.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


@pytest.fixture(scope='module')
def zip_data():
    return build.read_zip_data()


def test_ctc_amount_is_the_refundable_credit(zip_data):
    # The earlier files took the CTC amount from the next column over (EITC
    # with one qualifying child, $62,978K), halving every average.
    state, _ = zip_data
    assert state['ctc_n'] == 60600
    assert state['ctc_a'] == 117786
    assert 1500 < 1000 * state['ctc_a'] / state['ctc_n'] < 2500


@pytest.mark.parametrize('target', ['sldl22', 'sldu22'])
def test_districts_add_up_to_the_state(zip_data, target):
    state, zips = zip_data
    totals, population = build.allocate(zips, build.read_crosswalk(target))
    assert len(totals) == {'sldl22': 51, 'sldu22': 25}[target]
    for m in build.MEASURES:
        # SOI rounds each ZIP's counts to the nearest 10 and amounts to the
        # nearest $1,000, so ZIP sums miss the state total by up to that much.
        slack = (5 if m in ('returns', 'eitc_n', 'ctc_n') else 0.5) * len(zips)
        assert sum(t[m] for t in totals.values()) == pytest.approx(state[m], abs=slack)
    assert sum(population.values()) == pytest.approx(1455271)


def test_committed_files_match_a_fresh_build(tmp_path, monkeypatch):
    monkeypatch.setattr(build, 'OUT', tmp_path)
    assert build.main() == 0
    for fresh in sorted(tmp_path.iterdir()):
        committed = ROOT / 'data' / 'processed' / 'tax_credits' / fresh.name
        assert filecmp.cmp(fresh, committed, shallow=False), f'{fresh.name} differs from a fresh build'
