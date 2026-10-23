# App Store Connect screenshot series

Localized screenshots (en-US, it, ja) for the Safari app, at the native sizes App Store Connect requires. Same method as bitSnake: a caption on top, the real UI below, opaque JPEG.

| Folder | Size | Device |
|---|---|---|
| `out/<lang>/iphone-6.3/` | 1206 × 2622 | iPhone 6.3" (required) |
| `out/<lang>/ipad-13/` | 2064 × 2752 | iPad 13" (required) |
| `out/<lang>/mac/` | 2880 × 1800 | Mac (required) |
| `out/<lang>/duo-outer/` | 1398 × 2034 | iPhone Duo, outer display (optional now; required from April 2027 with the iOS 27.1 SDK) |
| `out/<lang>/duo-inner/` | 2007 × 2853 | iPhone Duo, inner display (same rule) |

Six scenes per device and language, in this upload order: `1-extract`, `2-frequency`, `3-new-terms`, `4-sync` (iCloud, Safari-only), `5-save`, `6-privacy`.

## How it is made

`build.py` opens the shipped `src/popup.html` + `popup.css` + `popup.js` in headless Chrome with the shipped `_locales`, stubs only the extension APIs (sample page, sample terms), drives the popup into each state and screenshots it. The popup is then placed on an iPhone sheet, an iPad popover or a Safari window under the caption. Nothing in the popup is mocked.

`captions.json` holds the per-scene captions.

```
pip install playwright pillow      # uses the installed Google Chrome, no download
python3 build.py [--lang it] [--device mac] [--scene 3-new-terms]
```

`out/` is git-ignored: regenerate it. Rebuild after any popup UI or locale change.

## Notes

- iPhone Duo: portrait only (landscape, 2034 × 1398 and 2853 × 2007, is optional and not produced). Submitting Duo screenshots makes the product page show an "optimized for iPhone Duo" badge. The outer display is shot with the iPhone behaviour (full-width sheet); the inner display, whose size classes are regular/regular, with the iPad-style popover. That mapping is an assumption: the real Safari extension popup on a Duo has not been seen, so check it on a device or simulator before relying on it.

- The background article and the URL `news.example.jp` are generic on purpose (no real publisher).
- The sheet/popover frames are schematic, not Apple device frames.
- `../screenshots/appstore_*.png` are the older hand-drawn mockups at non-standard sizes (1520 px wide): App Store Connect rejects them, use this series instead.
