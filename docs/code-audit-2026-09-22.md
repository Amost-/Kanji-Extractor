# Audit del codice — 22 settembre 2026

Stato esaminato: versione **1.4**, build **26** (manifest `1.4.26`), commit Safari
`d3fc77f`, più `src/`, `tests/`, `build.sh` e la configurazione Xcode fuori Git.
Ambito: popup ed estrazione, coordinatore di sincronizzazione JavaScript, layer
nativo Swift/CloudKit, app contenitore, script di build, manifest, entitlement,
privacy manifest, privacy policy.

Metodo: cinque revisioni parallele (sync JS e Swift con Opus, popup e build/config
con Sonnet, controlli meccanici con Haiku), poi verifica diretta sul codice delle
segnalazioni principali. Quindici difetti sono dimostrati da repro eseguiti,
conservati in [`tests/repro-2026-09-22/`](../tests/repro-2026-09-22/README.md).
Correzioni pianificate in [`audit-fix-plan-2026-09-23.md`](audit-fix-plan-2026-09-23.md).

## Esito

- **Nessun difetto P0** (perdita di dati, sicurezza) **né P1 nel codice.**
- Tutte le suite passano: **334 controlli su 334** (58 coordinatore, 5 concorrenza,
  60 popup, 6 background, 106 estrazione, 79 Swift, 20 bridge), eseguiti il 22 settembre.
- 1 punto di rilascio (P1, documentazione), **7 P2** (il settimo promosso dopo le
  misure su Safari del 23 settembre), circa 30 P3.
- Il gate FIFO nativo, il lock fra processi, la scrittura atomica del journal, la
  serializzazione delle mutazioni JS, la migrazione e la gestione di `retryAfter`
  hanno retto anche agli stress test dei revisori.

Gravità: **P1** bug probabile o bloccante per il rilascio; **P2** caso limite reale
con effetto visibile; **P3** robustezza, manutenzione, accessibilità.

### Stato delle correzioni (25 settembre 2026)

Le descrizioni sotto restano riferite al codice esaminato il 22 settembre. Lo
stato indica la correzione nei sorgenti; le prove firmate e su dispositivo sono
ancora previste nella fase 9 del piano.

| Riferimento | Stato |
| --- | --- |
| P1 privacy policy | Aperto: D8, pubblicazione e verifica URL |
| P2-1 storage | Corretto nella fase 3; misura reale dopo 30 giorni ancora aperta |
| P2-2 reset offline | Corretto nella fase 2; prova reale con account di test ancora aperta |
| P2-3 zona eliminata | Corretto nella fase 1; prova distruttiva ancora aperta |
| P2-4 profili Safari | Corretto nella fase 4; prova di cancellazione fra profili ancora aperta |
| P2-5 hook | Corretto nella fase 1 |
| P2-6 account indisponibile | Corretto nella fase 1 |
| P2-7 download macOS | Corretto nella fase 2; salvataggio reale verificato |

## Da sistemare prima di un rilascio

### P1 — Privacy policy con indirizzo segnaposto

`docs/privacy-policy.html:98,149,200` e `docs/privacy-policy.md` contengono ancora
`REPLACE_WITH_YOUR_EMAIL` nel link `mailto:`; nella checklist di pubblicazione la
voce «Privacy policy hosted» non è spuntata. Verificare anche la pagina già
pubblicata, se esiste, e l'URL indicato negli store.

## P2

### 1. Storage senza limite di crescita né pulizia

- **Dove:** `src/sync-coordinator.js:6-8,120-160`, `src/manifests/*.json`.
- **Problema:** nessun manifest richiede `unlimitedStorage`. Le chiavi legacy
  (conservate dopo la migrazione), `kanjiStateRepairBackup` e `kanjiStateQuarantine`
  non vengono mai cancellate, nemmeno da «Cancella cronologia». Circa 155 byte per
  termine, soprattutto per `firstUrl`.
- **Scenario:** Chrome e Safari hanno entrambi 10 MB. Su Chrome bastano per circa
  64.000 termini, oppure la metà se restano le chiavi legacy. A quota piena ogni
  salvataggio che fa crescere l'envelope fallisce. Il popup mostra «Sync failed»
  anche su Chrome e una pagina di pull viene riscaricata a ogni risveglio (repro R2).
- **Misura del 23 settembre (Safari macOS):** `QUOTA_BYTES` = 10 MB; in uso
  3,57 MB (35 %). `kanjiState` occupa 1,43 MB per 11.929 termini. Le copie di
  recupero, cioè `seenKanji` legacy (1,10 MB) e `kanjiStateRepairBackup`
  (1,25 MB), valgono il 64 % dello spazio usato. Restano circa 50.000 termini di
  margine: il problema non è urgente, ma la crescita è senza limite.
- **Verifica:** repro R2 e misura reale.

### 2. Reset iCloud in sospeso e rete assente bloccano il popup

- **Dove:** `src/sync-coordinator.js:527-528`, `src/popup.js:241-256`.
- **Problema:** gli errori ritentabili di un reset (rete, timeout di 30 s, `generic`)
  lasciano la fase `waiting` e non arrivano mai a `error`. Il popup abilita
  sync-off e Cancella solo in `error`, e disabilita Download e Importa finché un
  reset è in sospeso.
- **Scenario:** l'utente cancella la cronologia con la sync attiva mentre è
  offline. Dopo 12 tentativi la fase è ancora `waiting`. Non può scaricare le
  estrazioni né disattivare la sync, anche se l'abbandono tocca solo il journal
  locale e funzionerebbe offline.
- **Verifica:** repro R3.

### 3. `userDeletedZone` non viene mai recuperato

- **Dove:** `CloudKitSyncManager.swift:375,399,425-443` e
  `SafariWebExtensionHandler.swift:140`.
- **Problema:** solo `.zoneNotFound` azzera il flag `kanjiZoneCreated` e ricrea la
  zona. `.userDeletedZone` viene classificato `generic` e `ensureZone` non ricrea
  mai la zona.
- **Scenario:** l'utente elimina i dati dell'app da Impostazioni → iCloud → Gestisci
  spazio. Da quel momento pull e push falliscono per sempre, con un nuovo tentativo
  al massimo ogni 30 minuti.
- **Verifica:** lettura del codice.

### 4. Tutti i profili Safari condividono un journal nativo

- **Dove:** `CloudKitSyncManager.swift:113-115`, `SafariWebExtensionHandler.swift:18-29`.
- **Problema:** ogni profilo Safari (macOS 14+, iOS 17+) ha il proprio
  `storage.local` e la propria generazione, ma un solo contenitore dell'estensione,
  quindi un solo `control.json`. `SFExtensionProfileKey` è ignorato.
- **Scenario:** il profilo A cancella la cronologia e il journal passa alla
  generazione 1. Il profilo B, con cronologia, riceve `staleGeneration` a ogni
  sync. Se B cancella prima di sincronizzare, il suo `reset(1)` coincide con
  quello di A e risponde ok senza cancellare nulla.
- **Verifica:** repro `native_profiles_repro.swift` per il lato nativo; il 23
  settembre su Safari reale un profilo nuovo aveva uno `storage.local` separato
  (0 termini), quindi il problema è confermato su entrambi i lati.

### 5. L'hook `pre-commit` ignora i fallimenti di `build.sh`

- **Dove:** `Kanji Extractor Safari - multi/.githooks/pre-commit:22`
  (`"$EXT_ROOT/build.sh" >/dev/null || true`).
- **Scenario:** se `build.sh` fallisce, il commit parte con la build incrementata e
  le risorse Safari non rigenerate, contro quanto promette il commento dell'hook.
- **Verifica:** lettura del codice.

### 6. `accountTemporarilyUnavailable` trattato come «Accedi a iCloud»

- **Dove:** `SafariWebExtensionHandler.swift:130`, `src/sync-coordinator.js:527`.
- **Scenario:** con l'account momentaneamente indisponibile (credenziali da
  riconfermare, account non pronto all'avvio) il codice `account` richiede un
  intervento. La sync non riparte da sola e il messaggio dice a un utente già
  connesso di accedere.
- **Verifica:** lettura del codice.

### 7. Su Safari macOS ogni file si salva da dentro la pagina

- **Dove:** `src/popup.js:590-606`.
- **Problema:** in Safari macOS `browser.downloads.download` è `undefined`
  (misurato il 23 settembre), quindi ogni export usa il fallback: un click
  `<a download>` iniettato nella pagina, con il blob revocato subito dopo.
  `saveTextFile` risponde «downloaded» appena il click parte, e il popup segna
  i termini come noti.
- **Scenario:** Safari chiede il consenso ai download per il sito, oppure il
  sito intercetta il click (`preventDefault`) o lo blocca. Il file non viene
  salvato, ma i termini risultano noti e spariscono dai successivi export
  «solo nuovi». Uno script della pagina può anche leggere il contenuto
  dell'export, cioè quali termini della pagina sono nuovi per l'utente.
- **Verifica:** assenza dell'API misurata; comportamento del consenso per sito
  da provare su Safari reale.

## P3

### Sincronizzazione JavaScript (tutti con repro)

| Riferimento | Problema | Stato |
| --- | --- | --- |
| `sync-coordinator.js:234` | La quarantena riparte da `revision: 1`: i numeri di ciclo si ripetono e una pagina di pull ancora in volo viene accettata nel nuovo envelope (R4). | Corretta F5 |
| `sync-coordinator.js:535,542,190` | Un fallimento registrato con l'orologio avanti, poi corretto all'indietro, sposta il retry di quanto era l'anticipo; solo «Riprova» sblocca (R1). | Corretta F5 |
| `sync-coordinator.js:327-333` | «Cancella» durante un abandon non in errore risponde ok ma la cronologia resta (R5; raggiungibile solo da un secondo popup). | Corretta F2 |
| `sync-core.js:43-64` | Il merge accetta qualunque stringa data e qualunque conteggio finito (`1e308`, `"zzzz"`) che vincono min/max per sempre e si propagano (R6). | Corretta F5 |
| `sync-coordinator.js:271` | Le date sono in UTC: in Giappone un salvataggio prima delle 9 riceve la data del giorno prima. | Corretta F5 |
| `sync-coordinator.js:510-520` | Con cronologia locale, un journal nativo più avanti (`staleGeneration`) lascia solo la via distruttiva di cancellare la zona (R7). | Corretta F5 |
| `background.js:98` | Ogni errore diventa `generic`: su Chrome/Firefox un errore di storage appare come «Sync failed». | Corretta F1 |

### Layer nativo Swift

| Riferimento | Problema | Stato |
| --- | --- | --- |
| `SafariWebExtensionHandler.swift:52` | Ogni richiesta avvia un proprio `Task`: il gate è FIFO solo dall'arrivo all'actor; 14–27 inversioni su 5000 (REPRO2). Un `reset(g)` tardivo può essere superato da `abandonReset(g)`. | Corretta F6 |
| `CloudKitSyncManager.swift:497-503` | Il primo errore per record diverso da un conflitto interrompe l'intero batch; `limitExceeded` non viene diviso. | Corretta F6 |
| `CloudKitSyncManager.swift:504-509` | Ogni conflitto riscrive il record del server anche quando il merge non cambia nulla: doppia richiesta e download inutili sugli altri dispositivi. | Corretta F6 |
| `SafariWebExtensionHandler.swift:45-47,82` | Azioni sconosciute e `terms` malformati ricevono `ok: true` (il JS attuale non li produce). | Corretta F6 |
| `CloudKitSyncManager.swift:171-174,242` | Se la ricostruzione del journal fallisce dopo lo spostamento del file danneggiato, `control.json` manca e la generazione torna a 0. | Corretta F6 |
| `KanjiExtractorApp.swift:165-171` | L'app macOS si chiude anche quando l'apertura delle preferenze fallisce, senza messaggio. | Corretta F6 |
| `CloudKitSyncManager.swift` | Le pagine di pull non impostano `resultsLimit` (minore). | Corretta F6 |

### Popup ed estrazione

| Riferimento | Problema | Stato |
| --- | --- | --- |
| `popup.html:44` | `#status`, canale principale dei messaggi, non ha `role="status"`/`aria-live`. | Corretta F7 |
| `popup.js:425` | Il filtro delle pagine riservate non copre Chrome Web Store, AMO, `chrome-extension:`, `view-source:`: l'errore del browser arriva grezzo. | Corretta F7 |
| `popup.js:785-814` | I selettori di variante (U+FE00–FE0F, U+E0100–E01EF) fanno scartare i kanji IVS in modalità «solo kanji». | Corretta F7 |
| `popup.js:432,902` | Non vengono scansionati iframe né shadow DOM aperti (limite funzionale). | Shadow DOM corretto F7; iframe aperti (v2) |
| `_locales/*/messages.json` | `saved_added` e `import_done` hanno il plurale fisso («added 1 terms»). | Corretta F7 |
| `popup.css:46` | `body { width: 380px }` senza regola per schermi da 375 pt (iPhone SE/mini): da provare. | CSS corretto F7; prova visiva aperta F9 |
| `popup.js:752` | Un host IPv6 finisce nel nome file con `[`, `]`, `:` (minore). | Corretta F7 |
| `popup.js:891` | `getComputedStyle` per ogni elemento senza limite di tempo sulle pagine enormi. | Corretta F7 |

### Build, configurazione e pulizia

| Riferimento | Problema | Stato |
| --- | --- | --- |
| `build.sh:46-48` | `rm -rf _locales` prima della copia; nessun rollback e nessuna rimozione dei file orfani. | Corretta F8 |
| `project.pbxproj:625,636` | L'estensione macOS firmata ha `files.downloads.read-write` e `files.user-selected.read-write`, non usati dal codice al 22/09. Dal 23/09 il primo serve al salvataggio nativo scelto per il P2-7; resta superfluo il secondo. | Configurazione corretta F8; verifica firmata aperta |
| Git Safari | `xcuserdata/.../xcschememanagement.plist` è tracciato. | Corretta F8 |
| `_locales` | Chiavi inutilizzate: `sync_synced`, `syncing`, `syncing_page`. | Corretta F7 |
| Radice | `Nuova cartella con elementi/` (vecchio progetto con la sua `.git`), zip in radice con `__MACOSX`/`.DS_Store`, `dist/` fermo alla 1.3.x, `tmp/`. | Aperta D9 |
| Radice | `src/`, `tests/`, `docs/`, script fuori Git (punto aperto 6 dell'handoff). | Corretta F0 (D1) |
| `.githooks` | `core.hooksPath` va configurato a mano a ogni clone. | Corretta F8 |

## Segnalazioni scartate

- **«CloudKit bloccato dalla sandbox macOS: manca `com.apple.security.network.client`»**
  (proposto come P0). L'impostazione `ENABLE_OUTGOING_NETWORK_CONNECTIONS = NO` è
  presente dal commit iniziale e il 7 settembre il Mac ha inviato la coda a CloudKit
  con le stesse entitlement ([storage-recovery-2026-09-07.md](storage-recovery-2026-09-07.md)):
  la rete di CloudKit passa da `cloudd`.
- **«Safari 15.4 non supporta il service worker MV3».** Safari 15.4 è la versione
  che ha introdotto MV3; il minimo resta corretto.
- `extracting` ed `extension_description` segnalate come chiavi inutilizzate: usate
  da `popup.js:429` e dai manifest.

## Da misurare o provare su dispositivo

1. ~~Quota di Safari~~: misurata il 23 settembre, 10 MB (vedi P2-1).
2. ~~`downloads.download` in Safari macOS~~: `undefined` (vedi P2-7).
3. ~~Isolamento di `storage.local` fra profili Safari~~: confermato il 23 settembre
   (vedi P2-4). Resta da leggere il contenuto di `SFExtensionProfileKey`.
4. Larghezza del popup su iPhone da 375 pt.

## Aree trovate corrette

Nessun `innerHTML` con dati della pagina; iniezione nel mondo ISOLATED; funzione
iniettata autosufficiente; parità i18n en/it/ja; permessi dei manifest minimi e
coerenti con le API usate; `PrivacyInfo.xcprivacy` coerente (solo `UserDefaults`,
`CA92.1`); campi CloudKit (`term`, `count`, `firstSeen`, `lastSeen`) coerenti con la
privacy policy, nessun URL sincronizzato; nessun crash risk (`try!`, force unwrap,
`fatalError`) nel codice di produzione; nessun vocabolario nei log.
