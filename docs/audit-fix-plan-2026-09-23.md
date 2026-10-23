# Piano di correzione dell'audit — 23 settembre 2026

Piano d'implementazione per i problemi di [code-audit-2026-09-22.md](code-audit-2026-09-22.md).
Punto di partenza: versione 1.4, build 26, 334 controlli verdi. L'avanzamento è
nella tabella «Stato» in fondo.

## Regole valide per tutte le fasi

- Si modifica soltanto `src/` (più Swift e script); le copie nei pacchetti si
  rigenerano con `bash build.sh`, mai a mano.
- **Test prima della correzione:** ogni difetto con repro diventa prima un test
  che fallisce, poi viene corretto. I repro di `tests/repro-2026-09-22/` passano
  quando il difetto c'è: vanno convertiti invertendo l'asserzione.
- Nessuna prova con la cronologia o l'iCloud reali per creare dati sintetici. Le
  prove distruttive (cancellazione zona da Impostazioni, reset) si fanno con un
  Apple ID di prova o in un utente macOS di prova.
- Ogni checkpoint si supera solo con la **suite completa** verde (334 + i nuovi
  casi) e senza warning Swift. Se un checkpoint fallisce si corregge nella stessa
  fase, non si passa alla successiva.
- Dopo la correzione dell'hook (fase 1) un commit nel repo Safari per fase, con
  la build incrementata dall'hook. `src/` e `tests/` restano protetti dallo snapshot
  o dal repository deciso in D1.
- Esecutori, secondo la regola dei livelli: Opus per stato, concorrenza e dati;
  Sonnet per implementazioni con requisiti chiari; Haiku per modifiche meccaniche.
  Claude coordina, rilegge ogni diff ed esegue i test.

### Suite completa (per ogni checkpoint)

```sh
python3 tests/test_sync.py
python3 tests/test_sync.py --known-races
python3 tests/test_popup.py
python3 tests/test_extraction.py
python3 tests/test_native_sync.py
python3 tests/test_safari_storage_bridge.py
node --test tests/background-cases.mjs
bash build.sh
```

Compilazione senza firma (fasi che toccano Swift o il progetto):

```sh
xcodebuild -project "Kanji Extractor Safari - multi/Kanji Extractor.xcodeproj" \
  -scheme "Kanji Extractor Safari (macOS)" -configuration Release \
  -derivedDataPath "$TMPDIR/ke-dd" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project "Kanji Extractor Safari - multi/Kanji Extractor.xcodeproj" \
  -scheme "Kanji Extractor Safari (iOS)" -configuration Release \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$TMPDIR/ke-dd" CODE_SIGNING_ALLOWED=NO build
```

## Decisioni da prendere

D1, D2 e D3 sono state accettate come raccomandate il 23 settembre, D4 e D5 il 24, con
un'aggiunta a D5: finché esiste una quarantena, chiavi legacy e backup restano fino a
una cancellazione confermata. Nemmeno la pulizia di emergenza li libera. D6 e D7 sono
state accettate come raccomandate il 25 settembre.

| # | Decisione | Raccomandazione | Blocca |
| --- | --- | --- | --- |
| D1 | Come proteggere `src/`, `tests/`, `docs/` durante il lavoro | Repository Git nella radice con `Kanji Extractor Safari - multi/` in `.gitignore`: nessuna perdita di storia del repo Safari. In alternativa, snapshot a ogni fase. | Fase 0 |
| D2 | Comportamento dopo `userDeletedZone` | Rispettare la scelta dell'utente, come indica Apple: sync disattivata, messaggio dedicato, cronologia locale intatta. Riattivando la sync la zona viene ricreata e la cronologia ricaricata. | Fase 1 |
| D3 | Download mentre è in corso una cancellazione iCloud | Consentire il file ma non aggiornare la cronologia, con un messaggio esplicito. | Fase 2 |
| D4 | Permesso `unlimitedStorage` | Aggiungerlo a Chrome (nessun avviso) e Safari. Su Firefox non serve se `storage.local` non ha quota, ma aggiungerlo mostrerebbe un nuovo avviso di permesso: da confermare prima. | Fase 3 |
| D5 | Conservazione delle copie di recupero | **Scelta: 30 giorni.** Chiavi legacy e backup di riparazione rimossi 30 giorni dopo la prima lettura riuscita con la nuova versione; quarantena solo con «Cancella cronologia» confermata, che rimuove subito tutte e tre le copie. | Fase 3 |
| D6 | Date locali o UTC | **Scelta il 25/09: data locale** per i nuovi salvataggi; quelle esistenti restano. | Fase 5 |
| D7 | Recupero da `staleGeneration` con cronologia locale | **Accettata il 25/09.** Nuovo comando «Mantieni cronologia e risincronizza»: adotta la generazione nativa e rimette in coda tutti i termini (il merge per massimo non perde dati). Limite documentato: può reintrodurre termini cancellati da un altro dispositivo. | Fase 5 |
| D8 | Indirizzo di contatto della privacy policy e dove pubblicarla | **Indirizzo scelto il 28/09:** `tomas.social@gmail.com`, inserito in `docs/privacy-policy.{md,html}`. Dove pubblicare la pagina e l'URL negli store restano da decidere. | Fase 8 |
| D9 | Cartelle obsolete in radice | **Eseguita il 25/09** come raccomandata: archivio in `../KanjiExtractor Archive 2026-09-25/`. | Fase 8 |
| D10 | Numero di versione del rilascio | **Scelta il 28/09: 1.5** (invece della 1.4.1 raccomandata). `MARKETING_VERSION` e i manifest sorgente aggiornati. | Fase 9 |
| D11 | Come salvare il file su Safari macOS (P2-7) | **Scelta il 23/09: salvataggio nativo.** L'handler macOS scrive il `.txt` nella cartella Download e conferma l'esito; i termini diventano noti solo dopo quella conferma. | Fase 2 |

## Fase 0 — Preparazione e misure

Nessuna modifica al codice.

1. Applicare D1 (repository in radice o snapshot `_backup_pre_audit_fix_20260923/`).
2. Rieseguire la suite completa: 334/334.
3. Misure su Safari macOS reale, dall'Inspector del background (manuali, utente):
   - `browser.storage.local.QUOTA_BYTES`;
   - `JSON.stringify(await browser.storage.local.get()).length` e l'elenco delle chiavi presenti (legacy, backup, quarantena);
   - `typeof browser.downloads?.download`;
   - con due profili Safari: se ognuno ha la propria cronologia.
4. Riportare i risultati nella sezione «Misure» in fondo a questo documento.

**Checkpoint C0:** snapshot o commit iniziale presente; suite verde; misure
registrate. La misura della quota decide l'urgenza della fase 3: se l'uso supera
metà della quota di Safari, anticipare la fase 3 subito dopo la 1.

## Fase 1 — Correzioni rapide (P2-3, P2-5, P2-6)

Esecutore: Sonnet, con revisione del diff.

- **Hook** (`.githooks/pre-commit`): togliere `|| true`. Se `build.sh` esiste e
  fallisce, ripristinare `CURRENT_PROJECT_VERSION` al valore precedente e uscire
  con errore; se manca, conservare il salto attuale con un avviso.
- **`userDeletedZone`** (`CloudKitSyncManager.swift`, `SafariWebExtensionHandler.swift`):
  nuovo codice `zoneDeleted`. Azzerare `kanjiZoneCreated` e interrompere pull, push
  e reset senza ricreare la zona. Nel coordinatore è un errore che richiede
  un'azione: disattiva la sync senza toccare la cronologia. Nuova chiave i18n
  `sync_err_zone_deleted` nelle 3 lingue. Riattivare la sync ricrea la zona e
  ricarica tutto (`markDirty` esiste già). Applica D2.
- **`accountTemporarilyUnavailable`**: nuovo codice `accountTemporary`, ritentabile
  con backoff, messaggio `sync_err_account_temporary` («iCloud momentaneamente non
  disponibile; controlla Impostazioni → Apple ID»).
- **Test:** casi Swift per `classify` dei due errori e per l'azzeramento del flag;
  casi JS per `zoneDeleted` (sync off, cronologia intatta) e `accountTemporary`
  (fase `waiting`, prossimo tentativo pianificato); prova dell'hook su una copia
  temporanea del repo con un `build.sh` che fallisce.

**Checkpoint C1:** suite verde e nuovi casi; compilazione macOS/iOS senza warning;
la prova dell'hook annulla il commit e lascia il pbxproj invariato. Primo commit
con l'hook corretto.

## Fase 2 — Popup mai bloccato da un reset in sospeso (P2-2 e clear durante abandon)

Esecutore: Opus (macchina a stati).

- `popup.js`: con `resetPending` il toggle della sync è sempre attivo e
  disattivarlo avvia l'abbandono; il pulsante Cancella resta attivo.
- `popup.js` e coordinatore: con `resetPending` il Download salva il file e salta
  `commitTerms`, con il messaggio `saved_history_paused`. Importa resta bloccato.
  Applica D3.
- Coordinatore, `clearHistory`: con `stage === "abandon"` rilanciare la
  cancellazione con una generazione nuova, come già avviene in fase `error` (R5).
- Durante un reset in `waiting`, il popup mostra il motivo dell'ultimo errore (es. rete).
- **Download su Safari macOS (P2-7).** `downloads.download` non esiste, quindi
  ogni file passa dal click `<a download>` iniettato nella pagina: il sito può
  bloccarlo, oppure Safari può chiedere il consenso ai download per quel sito, e
  i termini vengono comunque segnati come noti. Provare prima il click
  `<a download>` nel documento del popup, dove la pagina non arriva. Se Safari lo
  consente, usarlo come fallback. Altrimenti revocare il blob dopo 40 s e, sulle
  pagine con il fallback, chiedere conferma («Il file è stato salvato?») prima di
  `commitTerms`.
  **Esito del 23/09:** nel popup il click non scarica; Safari apre una scheda sul
  `blob:` e fallisce (`WebKitBlobResource 1`). Decisione D11: salvataggio nativo.
  Nuova azione `saveDownload` nell'handler macOS: nome file ripulito, testo ≤ 5 MB,
  nessuna sovrascrittura (`nome (2).txt`…), risposta con il nome finale. Il
  background inoltra il comando `saveFile` e deduplica per id il secondo tentativo
  del popup. Il fallback `<a download>` nella pagina, con revoca a 40 s, resta solo
  dove l'handler nativo manca.
- **Test:** R3 e R5 convertiti; casi popup per toggle abilitato, download senza
  commit e messaggio; caso popup per il fallback (nessun commit senza conferma,
  se si adotta la conferma).

**Checkpoint C2:** suite verde; prova manuale su Mac con rete disattivata:
Cancella con sync attiva, poi sync off → abbandono completato offline, cronologia
intatta, download possibile. Su Safari macOS il download da un sito mai
autorizzato salva il file; se il download viene rifiutato, nessun termine
viene segnato come noto.

## Fase 3 — Storage: quota e copie di recupero (P2-1)

Esecutore: Opus (cancellazione di dati di recupero).

- Manifest: `unlimitedStorage` secondo D4.
- Nuovo codice `storageQuota` quando `storageSet` fallisce per quota: errore che
  richiede un'azione, niente nuovi tentativi automatici né riscaricamento della
  stessa pagina, messaggio `storage_err_quota` che invita a esportare la cronologia.
- `background.js:98` e popup: gli errori di storage non vengono più presentati
  come «Sync failed» (vale anche per Chrome e Firefox).
- Pulizia secondo D5: campo `legacyRetainedSince` scritto alla prima lettura;
  chiavi legacy rimosse dopo 14 giorni in un passo serializzato; `Cancella
  cronologia` confermata rimuove anche backup e quarantena. Un errore di rimozione
  non deve mai bloccare i comandi.
- Facoltativo, da valutare dopo le misure: limitare `firstUrl` (es. 512 caratteri).
- **Test:** R2 convertito (quota → `storageQuota`, cursore invariato, nessun
  nuovo tentativo automatico); pulizia legacy prima e dopo i 14 giorni;
  Cancella rimuove backup e quarantena; una rimozione fallita non blocca.

**Checkpoint C3:** suite verde; su Safari reale la dimensione misurata in C0
diminuisce dopo la pulizia; nessun termine perso (conteggio prima/dopo).

## Fase 4 — Un journal per profilo Safari (P2-4)

Esecutore: Opus. Prerequisito: misura sui profili della fase 0.

- `SafariWebExtensionHandler.swift`: leggere `SFExtensionProfileKey` (con
  `#available(macOS 14, iOS 17, *)`), accettarlo solo come UUID valido e passarlo
  al coordinatore nativo.
- `CloudKitSyncManager.swift`: journal in `KanjiExtractorSync/profiles/<uuid>/`;
  profilo predefinito (chiave assente) sul percorso attuale, così i dati esistenti
  non migrano. La zona CloudKit resta condivisa (stesso account): documentare
  che un reset in un profilo equivale a un reset da un altro dispositivo.
- Emerso nella fase 1: anche il flag `kanjiZoneCreated` in `UserDefaults` è unico per
  tutti i profili. Dopo un `zoneDeleted` nel profilo A, un profilo B con la sync
  attiva ricrea la zona al suo pull successivo. Decidere se il flag va per profilo
  o se il comportamento è accettabile, dato che la zona è comunque condivisa.
- **Test:** `native_profiles_repro.swift` convertito (B non riceve
  `staleGeneration` dopo il reset di A); UUID non valido rifiutato; profilo
  predefinito sul percorso attuale.

**Checkpoint C4:** suite verde; compilazioni pulite; prova su Mac con due profili:
Cancella in A non blocca B.

## Fase 5 — Robustezza della sync JavaScript (P3)

Esecutori: Sonnet per i primi quattro punti, Opus per D7.

- Quarantena: `revision` = vecchia revisione + 1 invece di 1 (R4).
- `nextAttemptAt` oltre `now + SYNC_MAX_BACKOFF_MS` considerato scaduto (R1).
- Merge: date accettate solo come `YYYY-MM-DD` valido, conteggi limitati
  (es. 1.000.000) anche in Swift; valori non validi ignorati campo per campo (R6).
- Date locali per i nuovi salvataggi (D6).
- `staleGeneration` con cronologia: comando `adoptNativeGeneration` e relativo
  pulsante nel popup (D7, R7).
- **Test:** R1, R4, R6, R7 convertiti; casi per le date locali.

**Checkpoint C5:** suite verde; i 7 repro JS originali ora falliscono tutti
(difetti chiusi), i test convertiti passano.

## Fase 6 — Robustezza del layer nativo (P3)

Esecutore: Opus (concorrenza).

- Ordine delle richieste: numero di sequenza assegnato in modo sincrono in
  `beginRequest` e consumatore unico; `abandonReset(g)` con `g` maggiore del
  journal registra `g`, così un `reset(g)` tardivo viene rifiutato.
- Push: risultati per termine; errori non di conflitto non interrompono il batch;
  `limitExceeded` divide il batch a metà (profondità limitata). Il JS rimuove dalla
  coda solo i termini confermati; senza il nuovo campo nella risposta, comportamento
  attuale (compatibilità). Limite di lunghezza dei termini in import e commit.
- Conflitti: nessun nuovo salvataggio se il merge coincide con il record del server.
- Azioni sconosciute e `terms` malformati: risposta `ok: false`, codice `protocol`
  (verificare prima che nessun chiamante si affidi all'ack attuale).
- Journal danneggiato: copia a parte, poi sovrascrittura atomica di `control.json`.
- `resultsLimit` sulle pagine di pull.
- App macOS: chiusura solo se l'apertura delle preferenze riesce, altrimenti avviso.
- **Test:** REPRO2 convertito in un test deterministico (0 inversioni su 5000);
  decisione del merge estratta come funzione pura e testata offline; risposte di
  protocollo; errore simulato durante la ricostruzione del journal.

**Checkpoint C6:** suite verde; compilazioni pulite in Swift 5 e 6; REPRO1 ancora
con `maxInside=1`.

## Fase 7 — Popup, estrazione e i18n (P3)

Esecutore: Sonnet. Viene dopo la fase 2, che tocca gli stessi file.

- `#status`: `role="status" aria-live="polite"`.
- Pagine riservate: aggiungere `chrome-extension:`, `view-source:`, `devtools:`
  e gli host di Chrome Web Store, AMO ed Edge Add-ons; tradurre in
  `restricted_page` gli errori di permesso di `executeScript`.
- Selettori di variante rimossi prima della classificazione; aggiornare la
  regola in `src/README.md`.
- Shadow DOM aperti attraversati. Iframe: spostati nella roadmap v2 (servono
  `allFrames` e unione dei risultati, con i limiti di `activeTab`).
- Plurale: `saved_added_one` e `import_done_one` nelle 3 lingue.
- `body { width: min(380px, 100vw) }`; nome file senza `[`, `]`, `:`.
- Chiavi inutilizzate `sync_synced`, `syncing`, `syncing_page` rimosse (Haiku).
- **Test:** casi di estrazione per IVS e shadow DOM (estendere la fixture se
  serve); casi popup per host riservati e singolare.

**Checkpoint C7:** suite verde; parità i18n verificata di nuovo; controllo visivo
del popup su simulatore iPhone SE (375 pt) e su Mac in chiaro e scuro.

## Fase 8 — Build, configurazione e pulizia

Esecutori: Sonnet per `build.sh`, Haiku per i passi meccanici.

- `build.sh`: copia in una cartella temporanea e poi scambio per ogni pacchetto;
  rimozione dei file non previsti (elenco esplicito: file web, `_locales`,
  `manifest.json`, `icons/`, `README.md`).
- Estensione macOS: `ENABLE_USER_SELECTED_FILES` disattivato (verificare prima che
  nessun codice nativo lo usi); `ENABLE_FILE_ACCESS_DOWNLOADS_FOLDER` **resta**,
  perché serve al salvataggio nativo (D11). Controllare con
  `codesign -d --entitlements -` sul prodotto.
- `xcuserdata` fuori da Git (`git rm --cached` più `.gitignore`).
- Privacy policy: indirizzo reale (D8), pubblicazione, URL verificato negli store.
- Pulizia della radice secondo D9.
- Aggiornare `HANDOFF.md`, `src/README.md` e la colonna di stato dell'audit.

**Checkpoint C8:** `build.sh` due volte di seguito dà pacchetti identici
(idempotenza); le entitlement firmate contengono il diritto su Download ma non quello sui file scelti dall'utente;
nessun `REPLACE_WITH_YOUR_EMAIL` nel progetto.

## Fase 9 — Rilascio e accettazione su dispositivo

- Versione secondo D10; `bash build.sh`; suite completa; build Release macOS e iOS.
- Nei bundle compilati: `MinimumOSVersion` di app ed estensione iOS = 15.4,
  `LSMinimumSystemVersion` macOS = 15.6; entitlement iCloud presenti.
- Nessun nuovo campo CloudKit: lo schema Production non cambia (da confermare
  alla fine delle fasi 1–6).
- Build Debug firmata e registrata in Safari; prove su dispositivo (account di
  prova per quelle distruttive):
  1. reset offline, poi sync off, poi ripresa online;
  2. eliminazione dei dati da Impostazioni iCloud → messaggio dedicato → riattivazione;
  3. due profili Safari;
  4. quota e pulizia (misura prima/dopo);
  5. popup su iPhone da 375 pt;
  6. prove ancora aperte dall'handoff: sospensione e riavvio, perdita di rete,
     chiusura durante pull/push, secondo dispositivo.
- Pacchetti store con `build-store-zips.sh`; caricamento a cura dell'utente.

**Checkpoint C9:** tutte le prove superate; `HANDOFF.md` aggiornato con esiti e build.

## Ordine e parallelismo

```text
C0 → F1 → F2 → F3 → F5 → F7 → F8 → F9
          └→ F4 → F6 ┘   (ramo Swift, in parallelo al ramo JS dopo C1)
```

Le fasi 2, 3, 5 e 7 toccano `sync-coordinator.js` e `popup.js` e vanno in
sequenza. Le fasi 4 e 6 toccano solo Swift e possono procedere in parallelo, ma
le nuove chiavi i18n di tutte le fasi si aggiungono da un unico punto per
evitare conflitti nei tre `messages.json`. Le fasi 1–4 chiudono tutti i P2.

## Stato

| Fase | Stato | Checkpoint | Note |
| --- | --- | --- | --- |
| 0 | **completata** | C0 ✓ 23/09 | D1 applicata: repository in radice `156765c`; suite di riferimento 334/334; misure qui sotto |
| 1 | **completata** | C1 ✓ 23/09 | Safari `2becc3d` (build 27). 348 controlli verdi (+14); il nuovo test JS fallisce sul codice precedente; build Release macOS e iOS Simulator senza warning; hook provato su un clone (fallisce → commit annullato e pbxproj identico; riesce → 26→27; manca → avviso) |
| 2 | **completata** | C2 ✓ 23/09 | Safari `9c2dac5` + `bf3545b` (build 29), radice `285cb7d` + `61908aa`; 429 controlli. P2-7 con salvataggio nativo (D11), provato su Safari reale nel profilo di prova: file UTF-8 scritto in ~/Downloads dall'estensione (quarantena «Kanji Extractor Safari Extension»), popup «Salvato in Download… aggiunti 184 termini». La prova reale del reset offline è rinviata alla fase 9 con un Apple ID di prova: sulla cronologia reale sarebbe distruttiva se la rete tornasse |
| 3 | **completata** | C3 ✓ offline 24/09 | Safari `f30643f` (build 30); 465 controlli. Quota: una pulizia di emergenza e un nuovo tentativo, poi `storageQuota` (sync ferma, niente pagine riscaricate); altri errori `storage`. La verifica reale della riduzione di spazio arriva dopo 30 giorni (D5): per ora si controlla che `recoveryRetainedSince` compaia dopo il riavvio di Safari |
| 4 | **completata** | C4 ✓ 24/09 (parte non distruttiva) | Safari `8359929` (build 31), radice `a7aa5ef`; 505 controlli. Profilo predefinito sul journal di sempre, altri profili in `profiles/<UUID>`; flag della zona per profilo. Su Safari reale (build 31) `syncState` risponde `ok` in entrambi i profili (principale: `profile` null, generazione 0; prova: UUID, generazione 0, journal separato creato nella sandbox). La prova «Cancella in A non blocca B» cancellerebbe la zona iCloud condivisa: coperta dai test offline, da ripetere in fase 9 con un Apple ID di prova |
| 5 | **completata** | C5 ✓ 25/09 | Safari `d46b755` (build 32); 92 sync, 8 race, 50 popup, 106 estrazione, 15+160 nativi, 20 bridge, 16 background. Implementata da Codex (GPT-6 Sol, effort high) con revisione del diff e due ritocchi (revisione della quarantena = massimo fra memoria ed envelope; conteggio importato non valido → 1). Repro R1, R4, R6 chiusi. R3 e R7 restano verdi per costruzione: R3 osserva il blocco di `commitTerms` con reset in sospeso, voluto da D3; R7 invoca esplicitamente Cancella, che azzera la zona per scelta, mentre il recupero D7 è opt-in (`adoptNativeGeneration`) ed è coperto dai nuovi test. Compilazioni Release macOS e iOS Simulator senza warning Swift. Aprendo il popup in errore `staleGeneration` non viene più inviato il `syncNow` automatico, così il pulsante di recupero resta visibile |
| 6 | **completata** | C6 ✓ 25/09 | Safari `d8e78e7` (build 33); 97 sync, 8 race, 51 popup, 106 estrazione, 173 nativi + 0/5000 inversioni, 20 bridge, 16 background. Implementata da Codex (GPT-6 Sol, effort high) con revisione del diff e due ritocchi: il piano di push scarta dalla coda i termini oltre i 64 code point (una cronologia precedente potrebbe contenerne: il nuovo handler risponderebbe `protocol` a ogni push), e un errore di zona cancellata per singolo record nel push torna a propagarsi come quello dell'intera operazione. REPRO1 ancora `maxInside=1`; REPRO2 0/5000. Typecheck Swift 5 e 6 senza warning (Codex), build Release macOS e iOS Simulator riuscite fuori dalla sandbox. Scelte: 64 code point per termine, 400 record per pagina di pull, profondità massima di divisione 4 |
| 7 | **completata** | C7 ✓ 25/09 (parte automatica) | Safari `efa132c` (build 34); 97 sync, 8 race, 66 popup, 118 estrazione, 173 nativi, 20 bridge, 16 background; fixture su DOM reale 64/64 (IVS e shadow root inclusi) eseguita nel browser integrato. Implementata da Codex (GPT-6 Sol, effort medium), diff riletto senza ritocchi. Parità i18n: 86 chiavi per lingua; aggiunta anche `saved_downloads_added_one` per il salvataggio nativo. Scansione con budget di 1,5 s e nota «pagina scansionata parzialmente». Iframe rinviati alla roadmap v2. Il controllo visivo del popup su iPhone SE (375 pt) e su Mac chiaro/scuro è rinviato alle prove su dispositivo della fase 9 |
| 8 | **completata** (D8 chiusa il 28/09) | C8 ✓ 25/09 | Safari `a00ac3f` (build 35). `build.sh` prepara ogni pacchetto in una cartella temporanea e lo sostituisce in blocco, rimuove i file fuori elenco (tolti solo i `.DS_Store`); due esecuzioni consecutive danno pacchetti identici (`diff -r`). Entitlement dell'appex macOS firmato (build Debug): `files.downloads.read-write` e iCloud presenti, `files.user-selected` assente. `xcuserdata` fuori da Git, `core.hooksPath` documentato nel README Safari. Stato dell'audit aggiornato in `code-audit-2026-09-22.md`. D9 eseguita: `Nuova cartella con elementi/`, `_backup_pre_consolidation_20260609/`, i due zip in radice e gli zip 1.3.x di `dist/` sono in `../KanjiExtractor Archive 2026-09-25/`. **Aperto D8:** `REPLACE_WITH_YOUR_EMAIL` resta in `docs/privacy-policy.{md,html}` finché non c'è l'indirizzo reale; pubblicazione e URL negli store da fare dopo. Parte automatica di Codex (GPT-6 Sol, medium), diff riletto senza ritocchi |
| 9 | **in corso** (parte automatica fatta il 28/09) | C9 — | Safari `bbebd2d` (build 36), manifest 1.5.36. Suite completa verde; build Release macOS e iOS senza warning Swift. Nei bundle: `LSMinimumSystemVersion` 15.6 (app ed estensione macOS), `MinimumOSVersion` 15.4 (app ed estensione iOS), versione 1.5; entitlement iCloud presenti nelle due estensioni. Nessun nuovo campo o tipo di record CloudKit nelle fasi 1–8 (`term`, `count`, `firstSeen`, `lastSeen` invariati). Pacchetti store generati con `build-store-zips.sh` in `dist/`. **Aperte:** le sei prove su dispositivo con Apple ID di prova, la pubblicazione della privacy policy e il caricamento negli store |

## Misure

Da compilare nella fase 0.

Misure prese dall'Inspector del popup di Safari macOS con uno snippet che legge
solo dimensioni e contatori (nessun vocabolario). Safari eseguiva ancora il
manifest `1.4.24`, anche se l'appex registrato è la build 26 (ricompilato il 23
settembre alle 22:10): serve riavviare Safari per caricare la build corrente.
Lo storage misurato non dipende dalla versione in esecuzione.

| Misura | Valore | Data |
| --- | --- | --- |
| `storage.local.QUOTA_BYTES` Safari | 10.485.760 (10 MB) | 23/09 |
| Byte usati (`getBytesInUse`) | 3.659,5 KB, **35 % della quota** | 23/09 |
| `kanjiState` (11.929 termini, coda vuota, sync `idle`) | 1.430,2 KB, circa 120 B per termine | 23/09 |
| Chiave legacy `seenKanji` | 1.102,7 KB | 23/09 |
| `kanjiStateRepairBackup` | 1.251,2 KB | 23/09 |
| Altre chiavi legacy (`syncToken`, `syncLock`, preferenze) | < 1 KB | 23/09 |
| `kanjiStateQuarantine` | assente | 23/09 |
| `unlimitedStorage` | assente | 23/09 |
| `browser.downloads.download` in Safari macOS | **`undefined`**: il salvataggio passa sempre dal fallback `<a download>` iniettato nella pagina | 23/09 |
| Storage separato per profilo | **Sì**: in un profilo nuovo lo stesso snippet dà 0 termini, solo `kanjiState` (0,4 KB) e sync disattivata; quel profilo esegue già la build 26 (manifest `1.4.26`) | 23/09 |
| `SFExtensionProfileKey` (build 30, `syncState`) | Profilo predefinito: **assente** (`profile: null`); profilo di prova: UUID `039325C4-…`. Entrambi i journal alla generazione 0 | 24/09 |
| Build 30 nel profilo principale | `unlimitedStorage` attivo; `recoveryRetainedSince` = 2026-09-23T22:09Z, quindi la rimozione di chiavi legacy e backup (2,35 MB) avverrà dal 23 ottobre circa | 24/09 |

Conclusioni:
- Le copie di recupero occupano 2,35 MB, il 64 % dello spazio usato. Con la
  crescita osservata (da 9.189 termini il 7 settembre a 11.929 il 23: circa
  1.200 a settimana) i 6,4 MB liberi bastano per circa 50.000 termini. L'uso è
  sotto metà quota, quindi la fase 3 resta nell'ordine previsto.
- Il fallback di download è il percorso reale su Safari macOS: il problema è
  promosso a P2 (P2-7) e la correzione entra nella fase 2.
- Ogni profilo ha il proprio `storage.local`, mentre il journal nativo resta
  unico: P2-4 è confermato su entrambi i lati. Il valore di
  `SFExtensionProfileKey` per il profilo predefinito si verifica nel codice
  durante la fase 4.
