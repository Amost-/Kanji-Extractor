# Kanji Extractor Safari — iOS e macOS

Safari Web Extension che estrae termini contenenti kanji dalla pagina attiva e
li esporta come `.txt`. La modalità predefinita seleziona parole di almeno due
kanji; quella alternativa ammette parole con un solo kanji e kana. L'Hangul viene
escluso. Gli ideogrammi CJK condivisi non permettono, da soli, di identificare con
certezza la lingua del testo.

Il progetto contiene quattro target con codice e risorse condivisi:

```text
Kanji Extractor Safari - multi/
├── Kanji Extractor.xcodeproj/
├── Shared (App)/
│   ├── KanjiExtractorApp.swift       app SwiftUI e attivazione dell'estensione
│   ├── Assets.xcassets/
│   ├── PrivacyInfo.xcprivacy
│   └── Resources/                   icona e localizzazioni en/it/ja
├── Shared (Extension)/
│   ├── SafariWebExtensionHandler.swift   protocollo di sincronizzazione
│   ├── CloudKitSyncManager.swift         CloudKit, lock e generazioni
│   ├── PrivacyInfo.xcprivacy
│   └── Resources/                   manifest, popup, background, coordinatore
├── iOS (App)/                       Info.plist ed entitlement
├── iOS (Extension)/                 Info.plist ed entitlement
├── macOS (App)/                     Info.plist ed entitlement
└── macOS (Extension)/               Info.plist ed entitlement
```

## Target e requisiti

| Target | Bundle ID | Tipo | SDK |
|---|---|---|---|
| Kanji Extractor Safari (iOS) | it.tomas.Kanji-Extractor-Safari | App | iphoneos |
| Kanji Extractor Safari (macOS) | it.tomas.Kanji-Extractor-Safari | App | macosx |
| Kanji Extractor Safari Extension (iOS) | it.tomas.Kanji-Extractor-Safari.Extension | Estensione | iphoneos |
| Kanji Extractor Safari Extension (macOS) | it.tomas.Kanji-Extractor-Safari.Extension | Estensione | macosx |

Versioni minime: **iOS 15.4**, **macOS 15.6**. Il manifest usa Manifest V3 con
service worker e dichiara Safari 15.4 come minimo. Usare un Xcode recente con
Swift 6.2 o successivo: i sorgenti esplicitano l'isolamento dei tipi condivisi e
il progetto usa gruppi di cartelle sincronizzati.

## Sorgenti e compilazione

I sorgenti web canonici sono in `../src/`. Eseguire `../build.sh` dalla cartella
del progetto per aggiornare `Shared (Extension)/Resources` e i pacchetti
Chrome/Firefox. Le modifiche dirette alle copie generate vengono sovrascritte
alla generazione successiva. Ogni pacchetto viene preparato in una cartella
temporanea e sostituito dopo la generazione; i file fuori dall'elenco previsto
vengono rimossi, mentre `icons/` e l'eventuale `README.md` vengono conservati.

In ogni clone di questo repository eseguire `git config core.hooksPath .githooks`
prima del primo commit. L'hook incrementa la build e richiede che `../build.sh`
riesca; il repository della radice contiene gli script e i sorgenti web.

1. Aprire `Kanji Extractor.xcodeproj` in Xcode.
2. In **Signing & Capabilities**, scegliere il proprio team Apple Developer per
   tutti i target. Il team configurato nel progetto è `J3K89M5546`.
3. Verificare iCloud → CloudKit sui due target estensione e il container
   `iCloud.it.tomas.Kanji-Extractor-Safari`. I file `.entitlements` sono già
   collegati. Per provisioning, ambienti e schema Production, consultare
   [la guida CloudKit](../docs/icloud-sync-setup.md).
4. Compilare ed eseguire lo schema app macOS o iOS, poi abilitare l'estensione
   nelle impostazioni di Safari. Su iOS il percorso varia con la versione del
   sistema: Safari → Estensioni, oppure App → Safari → Estensioni.

I gruppi `Shared (App)` e `Shared (Extension)` sono associati automaticamente ai
rispettivi target iOS/macOS. `sync-coordinator.js` viene incluso come risorsa
senza aggiungere un riferimento manuale al progetto. Dopo una modifica web
occorre sia rigenerare le risorse sia ricompilare l'app: la sola generazione
non aggiorna l'estensione installata in Safari.
L'estensione macOS conserva l'accesso in scrittura a Download per `saveDownload`;
non richiede l'entitlement per i file scelti dall'utente.

## Estrazione e salvataggio

L'analisi parte soltanto dopo **Estrai**. I risultati restano nel popup finché
un comando di salvataggio della cronologia non viene accettato dal background.

- **Safari macOS:** l'handler `saveDownload` scrive in Download e conferma il
  risultato prima che i termini siano registrati. L'entitlement Download resta
  necessaria.
- **iOS:** il popup usa `navigator.share({files})` e la Web Share API. Se l'utente
  annulla, i termini non vengono registrati. Non esiste un fallback nativo con
  `UIActivityViewController` o `NSSavePanel` nell'handler dell'estensione.

Il comando registra i termini visualizzati al momento del salvataggio. Chiudere
il popup durante una condivisione ancora aperta non equivale ad aver registrato
i termini.

## Sincronizzazione indipendente dal popup

```text
popup: comandi e visualizzazione
    → background + sync-coordinator
        ↔ storage.local.kanjiState
    → handler Swift → coordinatore nativo → CloudKit privato
```

Il background è l'unico componente che modifica cronologia e stato del lavoro.
`kanjiState`, schema 2, contiene cronologia, preferenze, coda, cursore, revisioni,
generazione e avanzamento. Le vecchie chiavi vengono migrate una volta sola.
Il popup osserva questo stato e può chiudersi senza cancellare un comando già
accettato.

Il coordinatore riceve una pagina alla volta e invia gruppi di massimo 400
termini. Salva ogni pagina con il cursore e rimuove dalla coda soltanto le
revisioni confermate. Conserva fase, prossimo tentativo, errore e ultima
conclusione; gli allarmi e gli eventi di avvio riprendono il lavoro. **Completata**
indica ricezione conclusa e coda locale vuota: non certifica la ricezione su ogni
altro dispositivo. Safari può sospendere il background o ritardarne i risvegli.

La sincronizzazione cloud è disponibile soltanto in Safari. L'app contenitore
serve per installare e attivare l'estensione; non esegue il ciclo di sync.
Non sono necessari App Groups e non vengono usati `CKSyncEngine` o operazioni
CloudKit long lived. Apple consente messaggi nativi anche da pagine UI
dell'estensione; questo progetto li centralizza nel background per renderlo
indipendente dal popup.

Per dettagli, decisioni e verifiche vedere
[il piano di implementazione](../docs/sync-implementation-plan.md).

## Cancellazione e limiti di ripresa

Con sincronizzazione attiva, **Cancella** salva un intento di reset CloudKit con
nuova generazione; mantiene la cronologia locale precedente fino alla conferma
e impedisce nuovi salvataggi mentre il reset è pendente. Con sincronizzazione
disattivata cancella soltanto i dati locali.

Il coordinatore Swift serializza le operazioni anche durante gli `await`. Nel
container dell'estensione usa
`Library/Application Support/KanjiExtractorSync/control.json` per la generazione
e il reset, più `control.lock` per coordinare processi distinti. Il journal non
contiene vocaboli o URL. Le richieste precedenti al reset vengono respinte; un
reset completato è idempotente, mentre uno fallito resta ritentabile.

Questa barriera è locale al container, non un protocollo di cancellazione fra
dispositivi. Il lock non annulla richieste già consegnate al servizio CloudKit se
il processo muore; un arresto fra cancellazione remota e conferma locale può
richiedere la ripetizione del reset. Le cancellazioni individuali remote non
vengono propagate alla mappa locale e altri dispositivi possono mantenere dati
precedenti. Le pagine `file://` restano bloccate dal controllo dell'estensione.

## Privacy

L'estensione analizza le pagine localmente dopo **Estrai**. I termini registrati
restano nella cronologia del dispositivo; la sincronizzazione facoltativa invia
termini, conteggi e date al database iCloud privato dell'utente. Gli URL delle
pagine rimangono sul dispositivo. I manifest privacy sono presenti nei bundle
app ed estensione; i dettagli di configurazione sono nella guida CloudKit.
