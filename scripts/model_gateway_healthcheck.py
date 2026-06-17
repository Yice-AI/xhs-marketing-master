#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.services.model_gateway_diagnostics import (  # noqa: E402
    build_model_gateway_summary,
    probe_image_gateway,
    probe_text_gateway,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Check model gateway configuration and reachability.")
    parser.add_argument("--probe", action="store_true", help="Run live text/image gateway probes")
    args = parser.parse_args()

    payload = {
        "summary": build_model_gateway_summary(),
    }

    exit_code = 0
    if args.probe:
        payload["probe"] = {
            "text": probe_text_gateway(),
            "image": probe_image_gateway(),
        }
        if not payload["probe"]["text"].get("ok") or not payload["probe"]["image"].get("ok"):
            exit_code = 1

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
