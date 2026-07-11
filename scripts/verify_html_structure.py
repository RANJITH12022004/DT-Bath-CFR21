#!/usr/bin/env python3
"""Verify all page-* elements live inside .page-content in index.html."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"


def page_content_close_index(html: str) -> int:
    start = html.find('<div class="page-content">')
    if start < 0:
        raise RuntimeError("page-content div not found")
    depth = 0
    i = start
    while i < len(html):
        if html.startswith("<div", i):
            depth += 1
            i = html.find(">", i) + 1
        elif html.startswith("</div>", i):
            depth -= 1
            i += 6
            if depth == 0:
                return i
        else:
            i += 1
    raise RuntimeError("page-content never closed")


def main() -> int:
    html = INDEX.read_text(encoding="utf-8")
    close_at = page_content_close_index(html)
    pages = re.findall(r'id="(page-[^"]+)"', html)
    outside = []
    for page_id in pages:
        pos = html.find(f'id="{page_id}"')
        if pos >= close_at:
            outside.append(page_id)
    if outside:
        print("FAIL: pages outside .page-content:", ", ".join(outside))
        return 1
    print("OK: all", len(pages), "pages inside .page-content")
    return 0


if __name__ == "__main__":
    sys.exit(main())
