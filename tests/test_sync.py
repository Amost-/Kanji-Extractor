#!/usr/bin/env python3
"""Run sync regression cases against the real coordinator in JavaScriptCore.

Usage:
    python3 tests/test_sync.py
    python3 tests/test_sync.py 'Kanji Extractor Chrome/sync-core.js'
    python3 tests/test_sync.py --engine /path/to/jsc src/sync-core.js
"""

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SYSTEM_JSC = Path(
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, nargs="*", help="sync-core.js files with a sibling sync-coordinator.js")
    parser.add_argument("--engine", help="JavaScriptCore executable (jsc)")
    parser.add_argument("--known-races", action="store_true", help="run the previously failing concurrency regressions")
    args = parser.parse_args()
    engine = args.engine or shutil.which("jsc")
    if not engine and SYSTEM_JSC.is_file():
        engine = str(SYSTEM_JSC)
    if not engine:
        parser.error("JavaScriptCore was not found; provide --engine /path/to/jsc")

    case_file = "sync-race-cases.js" if args.known_races else "sync-cases.js"
    cases = Path(__file__).with_name(case_file).read_text(encoding="utf-8")
    fixture = Path(__file__).with_name("sync-fixture.js").read_text(encoding="utf-8")
    failures = 0
    for source in args.sources or [ROOT / "src/sync-core.js"]:
        source = source.resolve()
        print(f"Testing {source}", flush=True)
        coordinator = source.parent / "sync-coordinator.js"
        if not coordinator.is_file():
            print(f"Missing coordinator: {coordinator}", file=sys.stderr)
            failures += 1
            continue
        script = "\n".join((source.read_text(encoding="utf-8"),
                            coordinator.read_text(encoding="utf-8"), fixture, cases))
        with tempfile.TemporaryDirectory(prefix="kanji-sync-tests-") as directory:
            script_path = Path(directory) / "sync-test.js"
            script_path.write_text(script, encoding="utf-8")
            result = subprocess.run(
                [engine, str(script_path)], check=False, capture_output=True, text=True,
                timeout=60,
            )
            print(result.stdout, end="")
            print(result.stderr, end="", file=sys.stderr)
            # JSC can exit with 0 when quit(1) runs inside a Promise callback.
            # Require proof that the asynchronous suite actually completed.
            completed = "KANJI_SYNC_TESTS_OK" in result.stdout.splitlines()
            failures += result.returncode != 0 or not completed
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
