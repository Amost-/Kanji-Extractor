# Revisione codice — 5 settembre 2026

> **7 settembre 2026:** i due problemi di concorrenza descritti sotto sono stati
> affrontati nel nuovo coordinatore persistente e nella barriera nativa del reset.
> Le regressioni JavaScript ora passano e le build macOS/iOS riescono. Il testo
> seguente resta una fotografia storica; per stato, garanzie e limiti attuali,
> vedere [il piano di implementazione](sync-implementation-plan.md).

> Aggiornamento successivo: correzioni e versione app **1.3.1**, build **22**,
> committate nel repository Safari come `b701387`. Pacchetti browser **1.3.22**.
> Il testo sotto descrive la revisione precedente al commit. L'app Safari attiva
> non è stata ricompilata per queste modifiche e i due problemi P1 restano aperti.

La revisione ha individuato e corretto difetti nell'estrazione, nel salvataggio,
nell'importazione della cronologia e nella sincronizzazione CloudKit. Rimangono
**due problemi P1 di concorrenza**, riprodotti con test deterministici: perdita di
termini durante scritture simultanee e ripristino della cronologia dopo Cancella.
Sono la priorità prima di una nuova distribuzione.

Le modifiche sono nei sorgenti e nelle tre cartelle dei pacchetti browser,
rigenerate con `./build.sh`. Questa revisione non ha aumentato la versione,
pubblicato pacchetti o ricompilato/reinstallato l'app Safari attiva. La build
Safari installata nella precedente indagine Hangul rimane distinta da queste
nuove modifiche. Il codice Swift modificato è stato compilato per i test offline.

## Problemi ancora aperti

### P1 — Una sincronizzazione può sovrascrivere un salvataggio locale

In `src/sync-core.js`, `pullAndMergePaged` legge `seenKanji` e scrive in seguito
l'intero oggetto aggiornato. Tra queste due operazioni, `commitTerms` o Importa
nel popup possono salvare nuovi termini. La successiva scrittura della vecchia
copia elimina quei termini dalla cronologia. Rileggere immediatamente prima di
scrivere riduce la finestra ma non rende atomiche le due operazioni.

Riproduzione: il pull legge una cronologia vuota; il popup salva `学校`; il pull
aggiunge `日本` alla sua copia e la scrive. Risultato effettivo: solo `日本`.
Risultato richiesto: entrambi. Il lock attuale coordina alcuni processi di sync,
ma non tutte le scritture locali e non offre un'operazione atomica di acquisizione.

### P1 — Cancella può essere annullato da un pull/push già in corso

Il gestore Cancella in `src/popup.js` non è serializzato con `runSync` o
`backgroundSync`. Una pagina remota richiesta prima del reset può arrivare dopo
la cancellazione e ripristinare termini e cursore della zona precedente.

Riproduzione: avviare un pull, completare la cancellazione locale dopo il reset,
poi consegnare al pull la risposta precedente contenente `学校`. La cronologia
torna popolata e il vecchio token viene nuovamente salvato.

Sul lato Swift, un actor protegge l'accesso al proprio stato ma permette
l'interleaving degli `await`: un push sospeso può ricevere `zoneNotFound` dopo
un reset e ricreare la zona. Inoltre, il timeout JavaScript non cancella il Task
nativo già avviato.

**Intervento consigliato:** un unico gestore in background per tutte le mutazioni
della cronologia e della coda, con ordinamento esplicito di sincronizzazione e
reset; le risposte appartenenti a una generazione precedente del reset devono
essere scartate. Anche il coordinamento nativo deve coprire richieste che
sopravvivono ai timeout JavaScript. Una soluzione basata soltanto su Web Locks
non coprirebbe tutti gli iOS attualmente supportati, che partono da 15.0.

I due casi sono conservati separatamente dalla suite delle correzioni:

```sh
python3 tests/test_sync.py --known-races
```

Il comando attualmente **termina con codice 1** e mostra entrambi i difetti.
Usa solo uno storage simulato in memoria: non cancella la cronologia reale né
accede a CloudKit.

## Correzioni implementate

| Priorità | Difetto e conseguenza | Correzione |
| --- | --- | --- |
| P1 | `.changedKeys` ignorava il confronto delle versioni CloudKit: un dispositivo poteva sostituire count=10 con count=7 e far regredire le date. | `.ifServerRecordUnchanged` attiva il merge e i retry già previsti. Il merge conserva massimo conteggio, prima data minima e ultima massima. |
| P1 | Il pull nativo ignorava gli errori dei singoli record e restituiva comunque il token successivo, saltando i record mancanti. | Propaga l'errore prima di restituire pagina e token. |
| P2 | A quota 1.000 pagine il pull JavaScript terminava con successo anche con `more=true`, consentendo push e messaggio di successo su un pull incompleto. | Errore `pageLimit`, con cursore già persistito per riprendere al prossimo tentativo. |
| P2 | Una nuova scansione o un cambio modalità durante il salvataggio potevano registrare termini diversi dal file esportato, oppure perdere l'aggiornamento della cronologia. | Copia stabile dei termini e dell'URL al click; blocco dei doppi salvataggi e aggiornamento coerente della lista dei termini nuovi. Gli errori di lettura della cronologia vengono propagati. |
| P2 | Importa non metteva i termini nella coda iCloud e non univa le date degli elementi già presenti. | Storia e coda persistite insieme; avvio sync, merge delle date e conservazione dell'URL locale. Date assenti non alterano incontri già registrati. |
| P2 | Forme Unicode composte/decomposte potevano duplicare la cronologia e inviare due record con lo stesso ID CloudKit. | Importa normalizza NFC e consolida gli alias già esistenti; il push nativo normalizza e deduplica anche i dati provenienti da vecchie cronologie. |
| P2 | La pulizia della coda poteva rimuovere una modifica di `firstSeen` avvenuta durante il push. | Controllo condiviso di conteggio, prima data e ultima data nel popup e nel background. |
| P2 | I confini dei nodi DOM interrompevano parole come `日<span>本</span>語`; i ruby potevano troncare `食べる`. | Ricomposizione delle sequenze inline, esclusione di `rt/rp`, rispetto dei confini di blocchi, BR e testo nascosto. |
| P2 | Un BODY nascosto veniva considerato visibile; non erano gestiti correttamente alcuni override CSS di `visibility`. | Verifica dello stile del BODY, dei discendenti e di `collapse`, con attraversamento iterativo. |
| P2 | Il merge remoto accettava tipi di termine non stringa, aggirando per coercizione il controllo delle chiavi riservate. | Validazione del tipo e accesso alle sole proprietà proprie dell'oggetto cronologia. |
| P2 | L'informativa breve dell'app negava la conservazione e l'invio dei termini, pur offrendo cronologia e iCloud. | Testo coerente con cronologia locale e sync iCloud facoltativo, aggiornato in italiano, inglese e giapponese. |

La semantica delle due API CloudKit è stata verificata nelle fonti Apple:
[savePolicy](https://developer.apple.com/documentation/cloudkit/ckmodifyrecordsoperation/savepolicy)
e [recordZoneChanges](https://developer.apple.com/documentation/cloudkit/ckdatabase/recordzonechanges(inzonewith:since:desiredkeys:resultslimit:)).

## Verifiche

- **106 casi di estrazione** in JavaScriptCore, con entrambe le modalità e i motori.
- **56 verifiche DOM reali** in Chrome: markup inline, ruby, confini CSS, elementi
  nascosti, override di visibilità e Hangul. Finestra ospite e server di prova chiusi.
- **9 casi del popup**, eseguendo i veri gestori con storage e salvataggio simulati:
  cambio scan durante il salvataggio, annullamento, importazione, code e alias NFC.
- **11 casi di sync JavaScript**: paginazione, ripresa, errori, merge e coda.
- **20 controlli Swift offline**; compilazione del vero `CloudKitSyncManager.swift`
  con SDK macOS, trasformazioni dei dati e normalizzazione. Nessuna richiesta iCloud.
- Le suite asincrone richiedono un segnale esplicito di successo; un errore non
  può passare inosservato a causa del comportamento di `quit(1)` nei Promise di JSC.

**Totale: 202 controlli superati.** I due test noti di concorrenza restano
intenzionalmente fallenti e sono indicati separatamente sopra. Non è stata
eseguita una prova CloudKit su due dispositivi: le correzioni del protocollo
richiedono ancora tale validazione prima della pubblicazione.

```sh
python3 tests/test_extraction.py
python3 tests/test_popup.py
python3 tests/test_sync.py
python3 tests/test_native_sync.py
```

Per ripetere le verifiche nel browser:

```sh
python3 tests/serve_browser_extraction.py --port 18754
```

Aprire l'URL stampato. Il server espone soltanto la pagina di prova e il vero
estrattore estratto dal sorgente, in una directory temporanea.

## Miglioramenti successivi

1. Completare la gestione unica delle scritture e del reset descritta sopra.
2. Definire come trattare i selettori di variante ideografica: forme come
   `葛\u{E0100}飾` possono ancora essere segmentate in modo indesiderato.
3. Versionare anche `src/`, script, test e documentazione: attualmente il
   repository Git copre soltanto il progetto Safari.
4. Mostrare versione/build nel popup e verificare il contenuto dell'app compilata
   nel processo di rilascio, per evitare il disallineamento 1.3.19/1.3.21 già trovato.

Il sospetto sui callback dello storage Firefox è stato scartato: le
[definizioni Firefox](https://searchfox.org/firefox-main/source/toolkit/components/extensions/schemas/storage.json)
e i binding supportano callback e Promise. I wrapper non sono stati cambiati.
