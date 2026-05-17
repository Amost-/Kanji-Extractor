# Kanji Extractor Safari — iOS + macOS Multiplatform

Safari Web Extension che estrae termini kanji (2+ ideogrammi CJK) dalla pagina web attiva e li salva come `.txt`.

Questo progetto è strutturato seguendo lo stesso modello del template multipiattaforma "Safari Extension App" di Apple. Contiene 4 target che condividono codice e risorse:

```
Kanji Extractor Safari/
├── Kanji Extractor.xcodeproj/
├── Shared (App)/              ← codice e risorse comuni alle 2 app
│   ├── KanjiExtractorApp.swift   (SwiftUI App, multiplatform via #if os(…))
│   ├── Assets.xcassets/
│   └── Resources/
│       ├── AppIcon/ (set HikuIcon esistente)
│       ├── en.lproj/Localizable.strings
│       ├── it.lproj/Localizable.strings
│       └── ja.lproj/Localizable.strings
├── Shared (Extension)/        ← codice e risorse comuni alle 2 estensioni
│   ├── SafariWebExtensionHandler.swift   (con UIActivityViewController su iOS, NSSavePanel su macOS)
│   └── Resources/             (manifest, popup, background, icons, _locales)
├── iOS (App)/                 (Info.plist + entitlements)
├── iOS (Extension)/           (Info.plist + entitlements)
├── macOS (App)/               (Info.plist + entitlements)
└── macOS (Extension)/         (Info.plist + entitlements)
```

## Target / Bundle ID

| Target                                       | Bundle ID                                         | Product type   | SDK     |
|----------------------------------------------|---------------------------------------------------|----------------|---------|
| Kanji Extractor Safari (iOS)                 | it.tomas.Kanji-Extractor-Safari                   | Application    | iphoneos|
| Kanji Extractor Safari (macOS)               | it.tomas.Kanji-Extractor-Safari                   | Application    | macosx  |
| Kanji Extractor Safari Extension (iOS)       | it.tomas.Kanji-Extractor-Safari.Extension         | App Extension  | iphoneos|
| Kanji Extractor Safari Extension (macOS)     | it.tomas.Kanji-Extractor-Safari.Extension         | App Extension  | macosx  |

Deployment targets: iOS 15.0 (richiesto per Safari Web Extensions su iOS), macOS 11.0.

## Differenze rispetto al progetto macOS-only originale

1. **Architettura multiplatform**: separazione `Shared (App|Extension)` + cartelle per-piattaforma, secondo il template ufficiale Apple `xcrun safari-web-extension-converter --rebuild-project`.
2. **Manifest v3**: aggiunti `persistent: false` (richiesto per iOS) e permesso `nativeMessaging` (per il fallback iOS sotto).
3. **Fix download su iOS**: su iOS Safari il pattern `<a download>` non scarica nulla. Il popup ora usa la **Web Share API** (`navigator.share({ files })`) come canale primario. Se la Web Share API non è disponibile, ripiega su `runtime.sendNativeMessage` verso `SafariWebExtensionHandler`, che presenta una `UIActivityViewController` (Share Sheet). Su macOS resta il flusso esistente (anchor click), che funziona nativamente.
4. **App SwiftUI multiplatform**: lo stesso `KanjiExtractorApp.swift` usa `#if os(macOS)` / `#elseif os(iOS)` per le differenze (apertura preferenze Safari su macOS vs apertura Settings su iOS).
5. **Stringhe di localizzazione**: aggiunte le chiavi `share_button`, `shared_file`, `share_failed` in en / it / ja.

## Apertura in Xcode — passi al primo avvio

1. Apri `Kanji Extractor.xcodeproj` in **Xcode 16 o successivo** (richiesto per le `PBXFileSystemSynchronizedRootGroup`).
2. Su ogni target, vai in **Signing & Capabilities**:
   - Seleziona il tuo *Team* Apple Developer (di default è già impostato su `J3K89M5546`, modificalo se diverso).
   - I file `.entitlements` sono già collegati via `CODE_SIGN_ENTITLEMENTS` di ciascuna build configuration.
3. Compila il target macOS o iOS App. La prima esecuzione installa l'extension. Poi:
   - **macOS**: Safari → Settings → Extensions → abilita "Kanji Extractor Safari".
   - **iOS**: Settings → Apps → Safari → Extensions → abilita "Kanji Extractor Safari".

I 4 target sono già configurati per includere automaticamente le cartelle condivise:
- `Shared (App)` è linkata nei `fileSystemSynchronizedGroups` di entrambi i target App.
- `Shared (Extension)` è linkata nei `fileSystemSynchronizedGroups` di entrambi i target Extension.
- Gli `Info.plist` e i `.entitlements` per-piattaforma sono esclusi dai build resources tramite `PBXFileSystemSynchronizedBuildFileExceptionSet`.

## Fallback "ufficiale" — Safari Web Extension Converter

Se questa cartella non si apre pulita per qualunque motivo, Apple raccomanda di rigenerarla dal progetto macOS originale con:

```sh
xcrun safari-web-extension-converter --rebuild-project /path/to/originale/Kanji\ Extractor.xcodeproj
```

Il converter produce un nuovo Xcode project con i 4 target già configurati. Il tool funziona solo su macOS con Xcode installato. Documentazione: Apple Developer → *Safari Extensions* → *Creating a Safari Web Extension*.

## Limiti noti

- L'icona dell'app (`AppIcon.appiconset`) è stata creata come placeholder vuoto. Per la sottomissione App Store occorre aggiungere le immagini PNG ai vari slot iOS/macOS (l'icona `HikuIcon` originale è ancora nell'asset catalog ma in formato `dataset`, che non funziona come AppIcon).
- Su iOS, la fallback nativa con `UIActivityViewController` da un Safari Web Extension Handler non è documentata da Apple. Funziona quando l'app contenitore è in foreground; altrimenti la Web Share API resta la strada principale.
- Permission `nativeMessaging` nel manifest: Safari Web Extension la accetta. È stata aggiunta perché il fallback iOS usa `runtime.sendNativeMessage`.

## Privacy

L'estensione processa la pagina web localmente in Safari solo dopo che l'utente clicca "Extract". Nessun dato di navigazione, testo estratto o file viene raccolto, conservato, tracciato, venduto o caricato.
