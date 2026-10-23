# Kanji Extractor — Chrome Extension

Manifest V3 extension that scans the current page for runs of 2+ kanji (CJK
ideographs), shows them in a popup, and downloads them as a `.txt` file.

## File layout

```
KanjiChrome/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js          ← All extraction logic
├── background.js     ← Minimal service worker
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

## Load it locally (development)

1. Provide PNG icons in `icons/` at sizes 16, 32, 48, 128. Any square PNGs
   resized to those dimensions work for testing.
2. Open `chrome://extensions` in Chrome (or Edge, Brave, etc. — all
   Chromium-based browsers support this).
3. Toggle **Developer mode** (top right).
4. Click **Load unpacked** and select the `KanjiChrome/` folder.
5. The extension icon appears in your toolbar (you may need to pin it via the
   puzzle-piece menu).

## Use it

- Open a page with kanji.
- Click the extension icon.
- Click **Extract** in the popup.
- Click **Download .txt** to save to your Downloads folder.

## Publishing to the Chrome Web Store

1. Sign up at https://chrome.google.com/webstore/devconsole — there's a
   one-time $5 USD registration fee.
2. Zip the contents of `KanjiChrome/` (the files, not the folder itself).
3. In the developer dashboard: **New Item** → upload the zip.
4. Fill in:
   - Store listing (description, category, language)
   - Screenshots (1280×800 or 640×400)
   - At least one promotional tile (440×280) recommended
   - Privacy practices: declare what data you handle (this extension handles
     none — page text is processed locally and never transmitted)
   - Single-purpose description (Chrome requires extensions to have one clear
     purpose)
5. Submit for review. Typical review time is a few hours to a few days.

## Compatibility with other browsers

This extension's code works in any Chromium browser without changes:
- **Microsoft Edge** — install via `edge://extensions`, or publish to the
  Edge Add-ons store (free, similar process to Chrome Web Store).
- **Brave, Opera, Vivaldi, Arc** — load unpacked via their extensions pages.
- **Firefox** — needs minor changes (different review process via AMO,
  `browser` namespace is native there, and the `downloads` permission works
  the same way). The `popup.js` code already uses the `browser ?? chrome`
  pattern so it would mostly run as-is.

## Differences from the Safari version

- No native Swift code, no container app, no Apple Developer Program fee.
- Distribution is one zip upload instead of an Xcode archive.
- Downloads always go to the browser's configured Downloads folder. Chrome's
  `downloads.download()` accepts `saveAs: true` if you want a per-file prompt;
  edit `popup.js` to change this.
- The extraction logic, popup UI, and 2+ kanji filter are identical.
