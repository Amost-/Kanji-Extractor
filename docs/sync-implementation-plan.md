# Sincronizzazione indipendente dal popup

Piano di implementazione e verifica — 7 settembre 2026.

Aggiornamento successivo alla prima build: [correzione e recupero dell’alias fra
coda e ricevute nello storage Safari](storage-recovery-2026-09-07.md), con
verifica del recupero sul Mac e della sincronizzazione della coda reale.

## Doppio controllo dell’analisi

La direzione è confermata: un unico coordinatore nel background, con stato persistente e ripresa a eventi. Correzione rispetto alla prima analisi: `storage.local.set` con più chiavi non è una transazione. WebKit può applicare solo alcune chiavi; cronologia, coda e cursore saranno un unico valore versionato. Non si promette esecuzione continua durante la sospensione di Safari né durabilità fisica contro perdita di alimentazione.

Fonti primarie verificate:

- [Apple: background non persistente, Storage, Alarms e versioni minime](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari).
- [Apple WWDC21: ciclo di vita a eventi](https://developer.apple.com/videos/play/wwdc2021/10027/).
- [Apple WWDC22: Safari 15.4, Manifest V3 e service worker](https://developer.apple.com/videos/play/wwdc2022/10099/).
- [WebKit: scrittura separata delle chiavi nello storage](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Extensions/WebExtensionStorageSQLiteStore.cpp).
- [MDN: un allarme omonimo sostituisce quello precedente](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms/create).

## Passi

1. **Stato e migrazione.** Introdurre `kanjiState` schema 2: cronologia, preferenze, revisioni dei termini da inviare, cursore, generazione della cronologia e stato del lavoro. Migrare una sola volta le vecchie chiavi; non riutilizzarle se l’envelope esiste, neanche dopo una cancellazione. Preservare dati con schema sconosciuto restituendo un errore.
2. **Coordinatore unico.** Spostare tutte le mutazioni in un dispatcher nel background. Serializzare lettura/modifica/scrittura, senza bloccare nuovi salvataggi durante la rete. Confermare i comandi solo dopo la scrittura; riconoscere i recenti identificativi già elaborati per evitare doppie azioni dopo una risposta persa.
3. **Lavoro riprendibile.** Ricevere una pagina e inviare al massimo 400 termini per richiesta. Salvare ogni pagina insieme al cursore; rimuovere ogni gruppo confermato solo se le revisioni sono ancora quelle inviate. Conservare la fase per continuare dopo un riavvio.
4. **Risvegli e nuovi tentativi.** Mantenere stabile l’allarme periodico; salvare il prossimo tentativo e ripristinare l’allarme di recupero all’avvio. Registrare gli errori, rispettare `retryAfter`, limitare il lavoro per risveglio. Gli errori che richiedono intervento restano visibili e consentono un tentativo manuale.
5. **Popup come interfaccia.** Usare messaggi per salvare/importare/cancellare e osservare lo stato persistente. Mostrare coda pendente, ricezione/invio, errore e ultima conclusione. Scartare risposte UI più vecchie usando la revisione globale. Non affidare lavoro all’evento di chiusura.
6. **Cancellazione ordinata.** Salvare prima una richiesta di reset con nuova generazione. Bloccare nuove modifiche alla storia durante il reset; mantenere la storia precedente fino alla conferma. Nel bridge nativo serializzare davvero le operazioni attraverso gli `await`, persistere la barriera e rendere idempotente il reset ripetuto.
7. **Compatibilità e distribuzione.** Aggiungere il coordinatore agli asset condivisi e al background Firefox; allineare il minimo iOS/Safari a 15.4, coerente con il Manifest V3 esistente. Mantenere macOS 15.6 e le versioni di rilascio attuali.
8. **Verifica.** Eseguire regressioni JavaScriptCore su migrazione, scritture fallite, risposta persa, paginazione, conferme per gruppo, riavvio, errori, concorrenza e reset. Verificare UI, estrazione e Swift. Rigenerare i tre pacchetti e compilare gli schemi Safari disponibili senza pubblicare o modificare i dati iCloud dell’utente.

## Garanzie e limiti

- La chiusura del popup non elimina un comando già accettato dal background. Il salvataggio/condivisione del file deve prima arrivare al passaggio di registrazione dei termini; chiudere durante una condivisione ancora aperta non equivale a un comando accettato.
- “Completata” significa ricezione conclusa e coda attuale vuota, non conferma che ogni altro dispositivo abbia già ricevuto i dati.
- I reinvii dall’esito incerto usano gli identificatori CloudKit deterministici e il merge già presenti.
- La barriera locale del reset non è un protocollo di cancellazione globale fra dispositivi. Operazioni già consegnate al servizio di sistema prima della morte del processo richiedono prove runtime; non si promette un annullamento retroattivo lato server.
- Prove finali su Safari Mac/iPhone, con Inspector chiuso: chiudere popup durante pull/push, interrompere rete e browser, poi verificare ripresa e coda. I test con backend simulato non sono una prova di trasferimento sull’account iCloud reale.

## Esito dell’implementazione

Passi 1–7 completati. Il passo 8 è completato per verifiche automatiche e build;
le prove sull’account iCloud reale e sui dispositivi restano distinte.

- 28 regressioni del coordinatore e 5 casi di concorrenza in JavaScriptCore.
- 44 casi del popup, con firme API Promise e callback controllate separatamente.
- 6 prove dell’entry point background, comprese sparizione del destinatario dopo
  il commit, conservazione dell’allarme e ricostruzione della scadenza al riavvio.
- 106 regressioni dell’estrattore; funzione di estrazione invariata.
- 53 verifiche Swift offline, comprese attese fra processi distinti, journal e
  reset ripetuto. Nessun accesso a CloudKit durante queste prove.
- Build complete Debug macOS e iOS riuscite, senza firma/installazione. I bundle
  contengono il nuovo coordinatore e gli asset sono identici a `src/` e ai tre
  pacchetti rigenerati. I soli avvisi delle build riguardano metadati AppIntents
  saltati perché il progetto non usa quel framework.

Totale: **242 controlli automatici superati**. Versione app 1.3.1/build 22 e
manifest 1.3.22 conservati; minimi effettivi iOS 15.4 e macOS 15.6 verificati nei
bundle. Le copie di verifica sono in `/tmp/kanji-sync-build-macos` e
`/tmp/kanji-sync-build-ios`, separate dall’app Safari usata dall’utente.

Due casi emersi dalla seconda review sono coperti: recupero tramite Riprova di
un reset che precede il journal nativo dopo un ripristino dello storage; rifiuto
dell’overflow della generazione senza rendere illeggibile la cronologia. Un
reset locale a sincronizzazione disattivata invalida il ciclo JavaScript, ma
non inventa una nuova generazione CloudKit.
