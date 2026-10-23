# Kanji Extractor

Safari, Chrome and Firefox extension that picks the kanji words from the web page you are reading and ranks them by frequency, so you can study the words that matter most. Everything runs on your device.

Vibe coded with Codex and Claude Code.

## What it does

- Finds whole words with Japanese word segmentation (`Intl.Segmenter`), not just single characters.
- Ranks them by frequency; two modes: words written entirely in kanji, or any word containing a kanji.
- Remembers what you have already seen ("Only new terms").
- Saves a list as a plain-text file; exports and imports your whole history.
- Safari only: optional sync of your history through your own private iCloud (CloudKit). Chrome and Firefox are local only.
- No accounts, no analytics, no ads, no tracking. See the [privacy policy](Privacy%20Policy).

## Layout

| Path | What |
|---|---|
| `src/` | The single source of truth: popup, background coordinator, sync core, locales (en, it, ja), per-browser manifests |
| `Kanji Extractor Chrome/`, `KanjiFirefox/` | Generated packages for Chrome and Firefox |
| `Kanji Extractor Safari - multi/` | Xcode project (macOS and iOS app with the Safari extension) |
| `tests/` | Test suites (extraction, popup, background, sync, Safari storage bridge) and benchmarks |
| `app-store-assets/` | Scripts that build the localized App Store screenshots and creative assets |

## Build

`./build.sh` stamps `src/` into the Chrome, Firefox and Safari packages (versions come from the Xcode project). Never edit the generated copies by hand. `./build-store-zips.sh` zips the Chrome and Firefox packages for the stores.

To build the Safari app, open `Kanji Extractor Safari - multi/Kanji Extractor.xcodeproj`, select your own development team and bundle identifiers, and enable the iCloud/CloudKit capability with your own container if you want sync.

## Tests

The suites live in `tests/` (Node and Python runners); `src/README.md` lists the commands.

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).
