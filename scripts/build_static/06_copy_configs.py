#!/usr/bin/env python3
"""Copy src/config/*.json -> web/src/config/ verbatim.

Keeps the JS port reading the same single-source-of-truth JSON files
that the Streamlit app uses today. variables.json isn't copied: the web
build reads src/config/variables.json directly and checks it (see
web/scripts/variables-config.mjs).
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SRC = ROOT / 'src' / 'config'
DEST = ROOT / 'web' / 'src' / 'config'


def main() -> int:
    DEST.mkdir(parents=True, exist_ok=True)
    for name in ('theme.json', 'ui_strings.json', 'data_sources.json'):
        src = SRC / name
        if not src.exists():
            print(f'  ! missing {src}, skipping')
            continue
        shutil.copy2(src, DEST / name)
        print(f'  copy {name}')
    print('[copy-configs] Done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
