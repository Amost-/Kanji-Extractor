# Kanji Extractor — Firefox Extension

Manifest V3 extension for Firefox that scans the current page for runs of 2+
kanji (CJK ideographs), shows them in a popup, and downloads them as a `.txt`
file.

Requires **Firefox 115 or later** (MV3 support stabilized in that release).

## File layout

```
KanjiFirefox/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js          ← All extraction logic
├── background.js     ← Minimal event script
└── icons/
    ├── icon-48.png
    ├── icon-96.png
    └── icon-128.png
```

## Load it temporarily (development)

Temporary installs disappear when Firefox restarts — fine for testing.

1. Provide PNG icons in `icons/` at sizes 48, 96, 128.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Click **Load Temporary Add-on…**.
4. Select the `manifest.json` file inside this folder.
5. The extension icon appears in the toolbar.

## Install persistently (unsigned)

By default, Firefox release/beta builds require all extensions to be signed.
For local development that survives restarts, use **Firefox Developer
Edition** or **Firefox Nightly** and set `xpinstall.signatures.required` to
`false` in `about:config`. Regular Firefox release won't allow this.

## Publishing to addons.mozilla.org (AMO)

1. Sign in at https://addons.mozilla.org/developers/ — **no upfront fee**
   (unlike Apple's $99/year or Chrome's $5).
2. Zip the contents of `KanjiFirefox/` (the files, not the folder itself).
   The zip can have any extension; AMO accepts `.zip` or `.xpi`.
3. **Submit a New Add-on** → upload the zip.
4. Choose distribution:
   - **On this site** — listed on AMO, reviewed by Mozilla, public.
   - **On your own** — Mozilla signs it but doesn't list it; you distribute
     the signed `.xpi` yourself.
5. Fill in:
   - Description, categories, tags
   - Screenshots
   - Privacy policy (required if you handle any user data; this extension
     doesn't, so a short statement saying so is fine)
6. Submit for review. Automated review is usually fast (minutes); human
   review for new add-ons can take days.

The signed `.xpi` from AMO is required for installation in Firefox release
builds, even for self-distribution.

## Differences from the Chrome version

- **Manifest's `background` block uses `scripts`, not `service_worker`** —
  Firefox MV3 hasn't adopted service workers. The script runs as an event
  page (loaded on demand, unloaded when idle).
- **`browser_specific_settings.gecko.id`** declares a unique add-on ID.
  Change `kanji-extractor@example.com` to your own identifier before
  publishing.
- **`browser` namespace is native and Promise-based** in Firefox; in Chrome,
  it's the `chrome` namespace with callbacks (also Promise-based in MV3).
  The shared `popup.js` uses `browser ?? chrome` so the same code runs on
  both.
- Icon sizes follow Mozilla's recommended set (48/96/128); Chrome prefers
  16/32/48/128. The two sets overlap enough that you can share icons in
  practice.

## Honest caveats

- **MV3 on Firefox is still evolving.** Some APIs that work in Chrome are
  stubbed or partial in Firefox. For this extension (just `activeTab`,
  `scripting`, `downloads`), everything is well-supported in 115+.
- **`scripting.executeScript`** in Firefox sometimes needs the host
  permission explicitly granted via `activeTab` interaction (i.e., the user
  clicking the toolbar icon). That matches our flow, so no change needed,
  but if you ever automate extraction without a user click you'll hit
  permission errors.
