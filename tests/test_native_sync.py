#!/usr/bin/env python3
"""Compile native sync code and test DTOs, ordering and reset recovery offline.

Usage: python3 tests/test_native_sync.py
Requires the macOS SDK and Swift compiler. DEVELOPER_DIR can select an Xcode.
"""

import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def main():
    env = os.environ.copy()
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if "DEVELOPER_DIR" not in env and xcode.is_dir():
        env["DEVELOPER_DIR"] = str(xcode)
    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], env=env, text=True
    ).strip()
    source = ROOT / "Kanji Extractor Safari - multi/Shared (Extension)/CloudKitSyncManager.swift"
    handler = source.with_name("SafariWebExtensionHandler.swift")
    cases = Path(__file__).with_name("native_sync_cases.swift")
    with tempfile.TemporaryDirectory(prefix="kanji-native-sync-tests-") as directory:
        binary = Path(directory) / "native-sync-tests"
        subprocess.run(
            ["xcrun", "swiftc", "-sdk", sdk, "-module-cache-path",
             str(Path(directory) / "module-cache"), "-application-extension", "-warnings-as-errors",
             str(source), str(handler), str(cases), "-o", str(binary)],
            env=env, check=True,
        )
        return subprocess.run([str(binary)], env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
