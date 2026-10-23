#!/usr/bin/env python3
"""Exercise real popup event handlers with a mocked coordinator message contract and no browser I/O."""

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SYSTEM_JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, default=ROOT / "src/popup.js")
    parser.add_argument("--engine", default=shutil.which("jsc") or SYSTEM_JSC)
    args = parser.parse_args()
    source = args.source.resolve()
    popup = source.read_text(encoding="utf-8")
    # Capture the existing initialization promise without changing its body.
    marker = "(async () => {"
    if marker not in popup:
        parser.error("popup initialization promise was not found")
    popup = popup.replace(marker, "const popupReady = (async () => {", 1)
    fixtures = Path(__file__).with_name("popup-fixture.js").read_text(encoding="utf-8")
    cases = Path(__file__).with_name("popup-cases.js").read_text(encoding="utf-8")
    passed = True
    for promise_api, label in ((True, "Safari/Firefox Promise API"), (False, "Chrome callback API")):
        script = "\n".join((
            "const POPUP_TEST_PROMISE_API = " + str(promise_api).lower() + ";",
            fixtures, popup, cases,
        ))
        with tempfile.TemporaryDirectory(prefix="kanji-popup-tests-") as directory:
            test_file = Path(directory) / "popup-test.js"
            test_file.write_text(script, encoding="utf-8")
            result = subprocess.run([args.engine, str(test_file)], check=False, capture_output=True, text=True)
            print(label + ":")
            print(result.stdout, end="")
            print(result.stderr, end="")
            passed = passed and result.returncode == 0 and "KANJI_POPUP_TESTS_OK" in result.stdout.splitlines()
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
