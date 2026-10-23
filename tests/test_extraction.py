#!/usr/bin/env python3
"""Run the real page extractor in JavaScriptCore with a minimal DOM fixture.

Usage:
    python3 tests/test_extraction.py
    python3 tests/test_extraction.py 'Kanji Extractor Chrome/popup.js'
    python3 tests/test_extraction.py --engine /path/to/jsc src/popup.js

Multiple popup.js paths may be supplied to check generated browser packages.
No browser extension, Python packages, or JavaScript dependencies are needed.
"""

import argparse
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SYSTEM_JSC = Path(
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sources", type=Path, nargs="*", help="popup.js files to test")
    parser.add_argument("--engine", help="JavaScriptCore executable (jsc)")
    args = parser.parse_args()
    engine = args.engine or shutil.which("jsc")
    if not engine and SYSTEM_JSC.is_file():
        engine = str(SYSTEM_JSC)
    if not engine:
        parser.error("JavaScriptCore was not found; provide --engine /path/to/jsc")

    cases = (Path(__file__).with_name("extraction-cases.js")).read_text(encoding="utf-8")
    failures = 0
    for source in args.sources or [ROOT / "src/popup.js"]:
        source = source.resolve()
        print(f"Testing {source}", flush=True)
        contents = source.read_text(encoding="utf-8")
        declaration = re.search(r"^function extractKanjiInPage\(mode\) \{", contents, re.M)
        if declaration is None:
            parser.error(f"extractKanjiInPage was not found in {source}")

        # The injected function is the final top-level declaration in popup.js.
        # Evaluate that original source, avoiding unrelated popup initialization.
        extraction = contents[declaration.start():]
        script = (
            "var extractKanjiInPage = (function () {\n"
            + extraction
            + "\nreturn extractKanjiInPage;\n})();\n"
            + cases
        )
        with tempfile.TemporaryDirectory(prefix="kanji-extraction-tests-") as directory:
            script_path = Path(directory) / "extraction-test.js"
            script_path.write_text(script, encoding="utf-8")
            result = subprocess.run([engine, str(script_path)], check=False)
            failures += result.returncode != 0

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
