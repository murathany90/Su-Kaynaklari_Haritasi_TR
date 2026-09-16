"""Historical backfill CLI for providers that serve the past.

Usage::

    python tools/hydro/backfill_fullness.py --provider copernicus \\
        --from 2024-01-01 --to 2026-09-16 [--mode backfill] [--max-pages N]

Guarantees: incremental (resume state), dedupe by
``hesId|provider|observationTimestamp|sourceClass``, rate-limit aware.
EPİAŞ serves no history -> forward archive only (refuses with a reason).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from providers import dedupe_key, read_provider_file

ROOT = Path(__file__).resolve().parents[2]
HISTORY_PROVIDERS = {"copernicus", "hydroweb", "dahiti", "swot"}


def parse_day(value: str) -> date:
    return date.fromisoformat(value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True, choices=sorted(HISTORY_PROVIDERS | {"epias", "sentinel"}))
    parser.add_argument("--from", dest="date_from", required=True)
    parser.add_argument("--to", dest="date_to", required=True)
    parser.add_argument("--mode", default="backfill", choices=["incremental", "backfill"])
    parser.add_argument("--max-pages", type=int, default=20)
    args = parser.parse_args()
    start, end = parse_day(args.date_from), parse_day(args.date_to)
    if start > end:
        parser.error("--from must be on or before --to")
    if args.provider == "epias":
        print(json.dumps({"provider": "epias", "status": "refused",
                          "reason": "EPİAŞ serves no history; forward archive only via the daily fetch"},
                         ensure_ascii=False, indent=2))
        return 3
    if args.provider == "sentinel":
        print(json.dumps({"provider": "sentinel", "status": "refused",
                          "reason": "Sentinel-2 backfill runs through staged tile jobs, not this CLI"},
                         ensure_ascii=False, indent=2))
        return 3
    script = {"copernicus": "tools/hydro/fetch_copernicus.py", "hydroweb": "tools/hydro/fetch_hydroweb.py",
              "dahiti": "tools/hydro/fetch_dahiti.py", "swot": "tools/hydro/fetch_swot.py"}[args.provider]
    before = read_provider_file({"copernicus": "copernicus_lwl", "hydroweb": "hydroweb_levels",
                                 "dahiti": "dahiti_levels", "swot": "swot_levels"}[args.provider])
    seen_before = {dedupe_key(o.get("canonicalHesId"), o.get("provider"), o.get("observedAt"), o.get("sourceClass"))
                   for o in before.get("observations", []) if isinstance(o, dict)}
    command = [sys.executable, str(ROOT / script), "--mode", args.mode]
    if args.provider == "copernicus":
        command += ["--from", args.date_from, "--to", args.date_to]
    completed = subprocess.run(command, cwd=ROOT)
    if completed.returncode != 0:
        return completed.returncode
    after = read_provider_file({"copernicus": "copernicus_lwl", "hydroweb": "hydroweb_levels",
                                "dahiti": "dahiti_levels", "swot": "swot_levels"}[args.provider])
    new = sum(dedupe_key(o.get("canonicalHesId"), o.get("provider"), o.get("observedAt"), o.get("sourceClass")) not in seen_before
              for o in after.get("observations", []) if isinstance(o, dict))
    print(json.dumps({"provider": args.provider, "mode": args.mode, "from": args.date_from, "to": args.date_to,
                      "observations": len(after.get("observations", [])), "newObservations": new,
                      "status": after.get("status")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
