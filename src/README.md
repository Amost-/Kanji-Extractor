# Kanji Extractor — shared source

This `src/` folder is the **single source of truth** for the browser extension.
The same code ships to Chrome, Firefox, and Safari (macOS + iOS); browser
differences are resolved at runtime, not by maintaining separate copies.

## Layout

```
src/
  popup.js            extraction/download UI; sends history commands
  popup.html          shared popup markup (uses data-i18n)
  popup.css           shared styles
  background.js       runtime messages, native transport, stable recovery alarms
  sync-core.js        pure history merge and normalization helpers
  sync-coordinator.js single writer; durable migration, jobs and checkpoints
  _locales/{en,it,ja}/messages.json
  manifests/
    chrome.json       MV3, service_worker, downloads + storage
    firefox.json      MV3, background.scripts, gecko id
    safari.json       MV3, service_worker, full icon set
```

## Build

```sh
./build.sh
```

Stages the web assets, locales and stamped manifest beside each package, then
replaces that package only after generation succeeds. It preserves each package's
`icons/` folder and optional `README.md`, removes other orphan files (including
`.DS_Store`), and reports what it removed. The Xcode project is left untouched.

Targets:
- `Kanji Extractor Chrome/`            (load unpacked)
- `KanjiFirefox/`                      (load temporary add-on / AMO)
- `Kanji Extractor Safari - multi/Shared (Extension)/Resources/` (Xcode build)

### Release version and build number

`build.sh` reads `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` from the
Xcode project. All app/extension targets and configurations must agree; the
script stops before copying files if either setting is missing or inconsistent.
The release metadata is generated as follows (the build number changes on
every Safari commit, so check the Xcode project for the current one):

| Metadata | Generated value | Source |
| --- | --- | --- |
| Native app/extension release (`CFBundleShortVersionString`) | `1.5` | Xcode `MARKETING_VERSION` |
| Native app/extension build (`CFBundleVersion`) | `<build>` (e.g. `36`) | Xcode `CURRENT_PROJECT_VERSION`, bumped by the Safari pre-commit hook |
| Safari manifest display version (`version_name`) | `1.5` | Xcode `MARKETING_VERSION` |
| Numeric manifest `version`, all browsers | `1.5.<build>` | Manifest template base `1.5` + Xcode build |

Apple distinguishes the [bundle release version and build number](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html).
WebKit reads its [extension display version from `version_name`, falling back to `version`](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Extensions/WebExtension.cpp#L858).
The native bundle settings do not rewrite `manifest.json`; omitting
`version_name` previously exposed the numeric `1.3.22` as the display version.

Keep the numeric manifest scheme for browser update ordering. Chrome and Firefox
retain the numeric version scheme; only Safari receives `version_name`. For a new release, update
the two Xcode settings and the Safari template's display-version default, then
run `./build.sh` before building in Xcode. The script always overwrites Safari's
display version from Xcode, so increasing only the build never changes `1.5`.
Confirm Safari Settings against the newly installed app after rebuilding.

## Runtime branching (why one file works everywhere)

- **i18n**: `localizedMessage()` uses `i18n.getMessage` when locales are present
  and falls back to the inline English string otherwise.
- **Download**: iOS → Web Share API; Safari macOS → native `saveDownload` into
  Downloads; Chrome/Firefox → `downloads.download()`. Other unsupported desktop
  paths use an injected `<a download>` click.
- **Word recognition**: `Intl.Segmenter` (locale `ja`) splits text into words;
  if it's missing (Firefox < 125) → fall back to contiguous kanji runs.

## Extraction modes (switch in the popup)

`kanjiState.extractMode` in `storage.local`:

- `"kanji-words"` (default, B) — whole words made **only** of kanji, 2+ chars.
  Fixes false compounds (`今日本` → `今日`); long compounds split into
  dictionary sub-words (`国際空港` → `国際` + `空港`).
- `"all-words"` (A) — any word containing at least one kanji, excluding tokens
  containing Hangul (includes verbs with okurigana and mixed kana/kanji words,
  e.g. `食べる`, `お茶`). Kana-only words are not extracted.

Changing the mode requires a re-scan (tokenization happens in the page).

`Intl.Segmenter("ja")` supplies word boundaries, not language detection. Han
ideographs are shared with Chinese and Korean Hanja, so the current extractor
does not guarantee that a Han-only term comes from Japanese text. Hangul is a
separate script and is excluded; in `all-words`, an explicit script check also
rejects Korean tone marks that the segmenter may attach to a kanji.

### What counts as a kanji

Two constants in `popup.js` define it, and every regex is built from them:

- `KANJI_BASE` — real ideographs: CJK Unified, Ext A–I, Compatibility (+ Supplement).
- `KANJI_MARKS` — the ideographic iteration marks (`々`, `〻`), which repeat the
  preceding kanji, so `人々`/`時々`/`様々` count as all-kanji words.

Unicode variation selectors (U+FE00–FE0F and U+E0100–E01EF) are removed
before word segmentation and mode classification. An IVS spelling such as
`漢󠄀字` is extracted and stored as `漢字`; the selector does not make an otherwise
all-kanji word fail the "kanji words" rule.

Marks are kept **separate** on purpose: they are not kanji on their own (a bare
`々` must never become a term) and they must not join a run in the no-`Segmenter`
fallback, or `時々大雨` would match as one term and lose `大雨`.

**Edit those two lists only, with `\u{…}` escapes, never a literal CJK
character** — `U+8C48` and `U+F900` are indistinguishable on screen, and that
typo shipped for every release before 1.3.21.

### Extraction regression checks

From the project root on macOS, run:

```sh
python3 tests/test_extraction.py
```

This executes the real injected function in JavaScriptCore, using small DOM
fixtures and both the segmenter and fallback paths. It needs no extra packages.
Optional `popup.js` paths check the generated browser copies; `--engine` selects
a different `jsc` executable. These checks cover extraction logic, not browser
installation, extension permissions, downloads, or iCloud integration.

The scanner joins visible inline text before segmenting, preserving words across
formatting tags and ruby base text. Ruby readings (`rt/rp`) are omitted; block
elements, line breaks and hidden content delimit runs.

Additional checks from the project root:

```sh
python3 tests/test_popup.py
python3 tests/test_sync.py
python3 tests/test_sync.py --known-races
python3 tests/test_native_sync.py
node --test tests/background-cases.mjs
python3 tests/serve_browser_extraction.py
```

Performance measurements (not tests; `node` here is any Node 18+ binary):

```sh
node tests/bench/bench-coordinator.mjs     # full-state reads/writes and ms per operation, 1k/12k/50k terms (~40 s)
node tests/bench/bench-popup-render.mjs    # popup renderState cost with a large history
```

The Swift checks require Xcode and do not contact CloudKit. The browser test
server exposes only an isolated temporary fixture on loopback. The concurrency
regressions run separately with `--known-races` and must now pass. See
[`docs/code-review-2026-09-05.md`](../docs/code-review-2026-09-05.md) for the review,
implemented fixes, and remaining release checks.

## "New terms only" feature

The background owns one versioned value in `storage.local`:

```jsonc
{
  "kanjiState": {
    "schemaVersion": 2,
    "revision": 12,
    "generation": 0,
    "seenKanji": { "日本語": { "count": 12, "firstSeen": "...", "lastSeen": "...", "firstUrl": "..." } },
    "newOnlyEnabled": true,
    "syncQueue": { "日本語": 12 },
    "syncToken": null,
    "sync": { "requested": true, "stage": "pull", "phase": "waiting", "nextAttemptAt": 0 }
    // Other preferences, job metadata and recent command receipts omitted.
  }
}
```

When the toggle is on, a scan exports only terms **not** already in
`seenKanji`. After the browser accepts a download or the share flow succeeds,
the popup submits those exact terms to the background. The command is accepted
only after history and pending work are stored. The downloads API confirms that
the download started; it does not prove the file finished writing.

## Sync ownership and recovery

Only `sync-coordinator.js`, hosted in the background, changes history and sync
state. The popup observes `storage.onChanged`; it does not run a CloudKit loop.
Each inbound page stores its records and cursor in the same envelope. Each
outbound group (up to 400 records) clears only the revisions it confirmed.

### Native sync message protocol

The native `push` reply includes `confirmed: [String]`, listing terms whose
records were saved or whose merge already matched the server. The coordinator
removes only those terms' unchanged queue revisions; other terms remain queued
for a later push. A reply without `confirmed` comes from an older native layer
and confirms the whole sent group. An empty confirmation stops with `noProgress`
instead of spinning. Native replies use `ok: false, code: "protocol"` for unknown
actions or malformed terms; the popup shows an update instruction. Import,
commit and native push decoding accept at most 64 Unicode code points per term.

One JSON value avoids partial writes of history versus cursor; `storage.local`
still offers no cross-context transaction or filesystem fsync guarantee. The
single dispatcher and fresh reads after failed writes are part of the design.
Legacy keys are read once during migration and retained as a backup; they must
never be merged back into an existing envelope, including an empty history.
Schema-2 data is not automatically compatible with older extension releases.

The periodic alarm is created only if absent. A separate recovery alarm is
restored from the persisted deadline. Worker suspension can delay progress,
but cannot erase already accepted work. A successful sync means the current
queue is empty and the inbound pass finished, not that another device received it.

Cloud reset is a durable intent: it advances a native generation, blocks history
edits while pending, and clears local records only after confirmation. The Swift
gate and file lock order requests across awaits and handler processes, with an
idempotent native reset journal. Local-only clear does not change the CloudKit
generation; a separate job cycle discards older JavaScript responses.

If the native journal is ahead of local history, the popup offers **Keep history
and resync**. It adopts the native generation and uploads every local term. The
server's maximum merge preserves counts and dates, but this recovery can
reintroduce terms deleted from another device. Export the history first if that
possibility matters.

Safari requires iOS/Safari 15.4+ for this MV3 package; the macOS target is 15.6.
See [the implementation and verification plan](../docs/sync-implementation-plan.md)
for lifecycle guarantees, reset limitations, and device acceptance checks.
