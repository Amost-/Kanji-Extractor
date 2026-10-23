#!/usr/bin/env python3
"""Serve isolated browser DOM checks against the real extractor on loopback.

Run: python3 tests/serve_browser_extraction.py --port 18754
Then open the printed URL in a browser. Ctrl-C stops and removes temporary files.
Only the fixture and extracted function are exposed, never the project directory.
"""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18754)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = (root / "src/popup.js").read_text(encoding="utf-8")
    declaration = re.search(r"^function extractKanjiInPage\(mode\) \{", source, re.M)
    if declaration is None:
        parser.error("extractKanjiInPage was not found")

    with tempfile.TemporaryDirectory(prefix="kanji-browser-dom-", dir="/tmp") as directory:
        path = Path(directory)
        (path / "extractor.js").write_text(source[declaration.start():], encoding="utf-8")
        (path / "index.html").write_text(
            (root / "tests/browser-extraction.html").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        handler = partial(SimpleHTTPRequestHandler, directory=directory)
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
            print(f"Browser checks: http://127.0.0.1:{server.server_port}/", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
