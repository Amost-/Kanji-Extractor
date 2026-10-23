#!/usr/bin/env python3
"""Build Kanji Extractor's iOS 27 App Store creative assets (header + search).

These are the text-free brand images Apple shows at the top of the product
page and in search results. They carry no words, so one set serves every
language. Same recipe as bitSnake's `creative/`: one composition, three
canvases.

    testata-21x9.png     3840 x 1646   product page header
    ricerca-3x2.png      3840 x 2560   search results card
    universale-16x9.png  5244 x 2950   single asset for both
                                       ("Use header asset in search results")

each in a dark and a light (`-chiara`) variant. The subject sits in a "safe
box" (about 2:1) centred on the canvas, sized so it survives both the 21:9 and
the 3:2 crop of the universal 16:9 asset.

The subject is the real Hiku app icon (the two layers of
`HikuIcon.icon/Assets`, composited with an iOS-style rounded square) next to a
stack of word cards: kanji terms with frequency bars and counts, the shape of
the app's ranked list. Only kanji and digits appear, never a localized word.

Usage: python3 build.py [--variant dark|light] [--asset testata|ricerca|universale]
Requires: pip install playwright pillow, Google Chrome, macOS font Hiragino Sans.
"""

import argparse
import base64
import io
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ICON_ASSETS = (HERE.parent.parent / "Kanji Extractor Safari - multi" / "Shared (App)"
               / "Resources" / "AppIcon" / "HikuIcon.icon" / "Assets")

# Pixel size and "Art Safe Area" of each asset: (file stem, width, height,
# (x, y, w, h)). The rectangles are measured from Apple's Photoshop templates
# (creative_assets-product_page_header_template / universal_asset_template,
# green "Art Safe Area" layer). Anything outside them may be cropped by the
# App Store. The 3:2 search asset has no template of its own: its rectangle is
# the universal one mapped onto the 3:2 centre crop of the 16:9 canvas
# (x offset (5244 - 4425) / 2, scale 3840 / 4425).
# Sizes are rendered at 2x from a half-size CSS viewport, so every dimension
# must be even.
ASSETS = {
    "testata": ("testata-21x9", 3840, 1646, (1097, 493, 1646, 661)),
    "ricerca": ("ricerca-3x2", 3840, 2560, (1311, 573, 1217, 835)),
    "universale": ("universale-16x9", 5244, 2950, (1921, 660, 1402, 962)),
}
# Fraction of the safe rectangle the subject may fill; the rest is breathing room.
FILL = 0.94

# Word cards: (term, count). Terms are the same sample vocabulary as the
# screenshot series; widths of the frequency bars follow the counts.
CARDS = [("日本", 12), ("経済", 9), ("政府", 8)]

# Background pattern: large, very faint kanji (common words of the sample
# vocabulary and a few more) that fill the canvas outside the art-safe area.
# They are decoration only, faded out around the subject so it stays clean.
PATTERN_GLYPHS = "日本語漢字経済政府企業市場社会世界影響調査発表問題環境学習言葉文化歴史自然教育勉強"

THEMES = {
    "dark": dict(bg="#090e1a", glow="255,150,70", glow2="0,122,255", glow2_a=".30", card="rgba(255,255,255,.96)",
                 ink="#14181f", muted="#8a93a3", bar="#007aff", barbg="rgba(0,0,0,.07)",
                 shadow="0 18px 40px rgba(0,0,0,.5)", glyph="rgba(120,170,255,.085)", suffix=""),
    "light": dict(bg="#f6f2ec", glow="255,170,100", glow2="0,122,255", glow2_a=".10", card="#ffffff",
                  ink="#14181f", muted="#8a93a3", bar="#007aff", barbg="rgba(0,0,0,.06)",
                  shadow="0 16px 36px rgba(120,90,50,.22)", glyph="rgba(150,100,50,.10)", suffix="-chiara"),
}


def icon_data_url():
    """The app icon as a PNG data URL: background gradient layer with the
    white glyph layer on top, full bleed. Rounding is done in CSS."""
    base = Image.open(ICON_ASSETS / "hiku sfondo.png").convert("RGBA")
    glyph = Image.open(ICON_ASSETS / "hiku.png").convert("RGBA")
    base.alpha_composite(glyph)
    buf = io.BytesIO()
    base.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# Subject geometry in units `u`: icon 70 tall, gap 9, cards 76 wide (+/- 2.5
# of stagger on each side) -> 160 wide x 70 tall (cards: 3 x 20 + 2 x 5).
SUBJECT_W, SUBJECT_H = 160.0, 70.0


def page_html(width, height, safe, theme, icon_url):
    """HTML for one canvas. `safe` = (x, y, w, h) is the art-safe rectangle in
    canvas pixels (CSS px = pixels / 2). The subject is scaled so its box fits
    inside the rectangle (times FILL) and centred on it."""
    t = THEMES[theme]
    sx, sy, sw, sh = (v / 2 for v in safe)
    u = min(sw / SUBJECT_W, sh / SUBJECT_H) * FILL
    cx, cy = sx + sw / 2, sy + sh / 2
    maxc = max(c for _, c in CARDS)
    cards = "".join(
        f'<div class="card c{i}"><span class="term">{term}</span>'
        f'<span class="barbg"><span class="bar" style="width:{count / maxc * 100:.0f}%"></span></span>'
        f'<span class="count">{count}×</span></div>'
        for i, (term, count) in enumerate(CARDS))
    # Pattern: a tilted flow of glyphs, enough of them to cover the canvas at
    # any aspect ratio. The wrapper (not tilted) carries the mask, so the
    # clear zone is an ellipse around the subject: opaque-to-clear at 85% of
    # its radius (subject corners sit at ~77%), fully visible from 170%.
    # The flow box is 150% x 150% of the canvas; one glyph cell is about
    # (26u + 9u) x (26u + 3u), so this many glyphs fill it (plus a margin).
    count = int(2.25 * width * height / ((35 * u) * (29 * u))) + 40
    glyphs = "".join(f"<i>{PATTERN_GLYPHS[(k * 7) % len(PATTERN_GLYPHS)]}</i>" for k in range(count))
    rx, ry = u * 125, u * 80
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
* {{ box-sizing: border-box; margin: 0; }}
html, body {{ width: {width}px; height: {height}px; overflow: hidden; }}
.pattern {{ position: absolute; inset: 0; overflow: hidden;
  -webkit-mask-image: radial-gradient(ellipse {rx}px {ry}px at {cx}px {cy}px, transparent 85%, #000 170%);
  mask-image: radial-gradient(ellipse {rx}px {ry}px at {cx}px {cy}px, transparent 85%, #000 170%); }}
.pattern div {{ position: absolute; left: -25%; top: -25%; width: 150%; height: 150%; display: flex;
  flex-wrap: wrap; align-content: flex-start; justify-content: center; gap: {u * 3}px {u * 9}px;
  transform: rotate(-9deg); font-size: {u * 26}px; font-weight: 700; line-height: 1; color: {t['glyph']}; }}
.pattern i {{ font-style: normal; }}
body {{ background: {t['bg']}; position: relative; font-family: "Hiragino Sans", sans-serif; }}
.glow {{ position: absolute; inset: 0;
  background:
    radial-gradient(ellipse {u * 120}px {u * 80}px at {cx - u * 50}px {cy}px, rgba({t['glow']}, .42), transparent 70%),
    radial-gradient(ellipse {u * 130}px {u * 85}px at {cx + u * 50}px {cy}px, rgba({t['glow2']}, {t['glow2_a']}), transparent 72%); }}
.subject {{ --u: {u}px; position: absolute; left: {cx}px; top: {cy}px; width: calc(var(--u) * {SUBJECT_W});
  height: calc(var(--u) * {SUBJECT_H}); transform: translate(-50%, -50%); display: flex; align-items: center;
  gap: calc(var(--u) * 9); }}
.icon {{ width: calc(var(--u) * 70); height: calc(var(--u) * 70); flex: none;
  border-radius: 22.4%; background: url({icon_url}) center / cover;
  box-shadow: 0 calc(var(--u) * 2.6) calc(var(--u) * 6) rgba(0,0,0,.38), inset 0 0 0 calc(var(--u) * .25) rgba(255,255,255,.35); }}
.cards {{ width: calc(var(--u) * 76); margin-left: calc(var(--u) * 2.5); display: flex; flex-direction: column;
  gap: calc(var(--u) * 5); }}
.card {{ display: flex; align-items: center; gap: calc(var(--u) * 3.4); height: calc(var(--u) * 20);
  padding: 0 calc(var(--u) * 5.5); border-radius: calc(var(--u) * 5.2); background: {t['card']};
  box-shadow: {t['shadow']}; color: {t['ink']}; }}
.c0 {{ transform: translateX(calc(var(--u) * -2.5)); }}
.c2 {{ transform: translateX(calc(var(--u) * 2.5)); }}
.term {{ font-size: calc(var(--u) * 10); font-weight: 600; width: calc(var(--u) * 22); }}
.barbg {{ flex: 1; height: calc(var(--u) * 3); border-radius: 99px; background: {t['barbg']}; overflow: hidden; }}
.bar {{ display: block; height: 100%; border-radius: 99px; background: {t['bar']}; }}
.count {{ font-size: calc(var(--u) * 4.8); color: {t['muted']}; width: calc(var(--u) * 10); text-align: right;
  font-variant-numeric: tabular-nums; font-family: "SF Pro Display", sans-serif; }}
</style></head><body><div class="glow"></div><div class="pattern"><div>{glyphs}</div></div>
<div class="subject"><div class="icon"></div><div class="cards">{cards}</div></div></body></html>"""


def build(browser, key, theme, icon_url):
    """Renders one asset/theme pair and writes it as an opaque PNG."""
    name, w, h, safe = ASSETS[key]
    ctx = browser.new_context(viewport={"width": w // 2, "height": h // 2}, device_scale_factor=2)
    page = ctx.new_page()
    page.set_content(page_html(w // 2, h // 2, safe, theme, icon_url))
    page.wait_for_timeout(150)
    png = page.screenshot(type="png")
    ctx.close()
    image = Image.open(io.BytesIO(png)).convert("RGB")
    assert image.size == (w, h), f"{name}: got {image.size}, want {(w, h)}"
    out = HERE / "out" / f"{name}{THEMES[theme]['suffix']}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out, "PNG", optimize=True)
    print(out.relative_to(HERE))


def main():
    """Parses the filters and builds every matching asset."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--variant", choices=list(THEMES))
    ap.add_argument("--asset", choices=list(ASSETS))
    args = ap.parse_args()
    icon_url = icon_data_url()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        for key in ASSETS:
            for theme in THEMES:
                if (args.asset and key != args.asset) or (args.variant and theme != args.variant):
                    continue
                build(browser, key, theme, icon_url)
        browser.close()


if __name__ == "__main__":
    main()
