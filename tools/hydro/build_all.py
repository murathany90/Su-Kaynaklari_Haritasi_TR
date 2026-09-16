"""Run the canonical offline build chain in its required order."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def run(script: str) -> None:
    subprocess.run([sys.executable, str(ROOT / script)], cwd=ROOT, check=True)


def main() -> None:
    # Fetch jobs are explicit because a build must remain reproducible when a
    # remote provider is unavailable. CI can set HYDRO_FETCH=1 before calling.
    if os.getenv("HYDRO_FETCH") == "1":
        run("tools/hydro/fetch_tatus.py")
        run("tools/hydro/build_river_reach_map.py")
        run("tools/hydro/fetch_geoglows.py")
        run("tools/hydro/fetch_epias.py")
    if os.getenv("HYDRO_FETCH") == "1" or os.getenv("FULLNESS_FETCH") == "1":
        run("tools/hydro/fetch_observation_catalogs.py")
        # Provider observation downloads. Each adapter is credential-gated
        # (skipped without secrets) and idempotent; EPİAŞ exits nonzero only
        # when credentials ARE configured but the fetch errors.
        run("tools/hydro/fetch_hydroweb.py")
        run("tools/hydro/fetch_copernicus.py")
        run("tools/hydro/fetch_dahiti.py")
        run("tools/hydro/fetch_swot.py")
        run("tools/hydro/fetch_sentinel2.py")
    run("tools/build_hes177.py")
    run("tools/hydro/build_reservoirs.py")
    run("tools/hydro/audit_fullness_sources.py")
    run("tools/validate_hes177.py")


if __name__ == "__main__":
    main()
