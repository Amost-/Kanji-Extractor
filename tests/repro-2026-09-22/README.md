# Repro dell'audit del 22 settembre 2026

Questi file **non sono test di regressione**: ogni caso *passa quando il difetto
è presente*. Servono a dimostrare i problemi descritti in
[`docs/code-audit-2026-09-22.md`](../../docs/code-audit-2026-09-22.md) e vanno
convertiti, fase per fase, in test normali con l'asserzione invertita
(vedi [`docs/audit-fix-plan-2026-09-23.md`](../../docs/audit-fix-plan-2026-09-23.md)).
Nessuno script di `tests/` li esegue automaticamente.

| File | Casi | Difetti |
| --- | --- | --- |
| `sync-repro-cases.js` | R1–R7 | orologio corretto all'indietro, quota, reset bloccato offline, revisione dopo quarantena, clear durante abandon, merge senza validazione, `staleGeneration` con cronologia locale |
| `native_gate_order_repro.swift` | REPRO1, REPRO2 | REPRO1 è un controllo positivo del gate (deve dare `maxInside=1`); REPRO2 mostra richieste servite fuori ordine |
| `native_profiles_repro.swift` | — | due profili Safari che condividono un solo journal nativo |

## Esecuzione

Dalla radice del progetto. `$TMP` deve essere una cartella temporanea.

```sh
# JavaScript (JavaScriptCore di sistema)
cat src/sync-core.js src/sync-coordinator.js tests/sync-fixture.js \
    tests/repro-2026-09-22/sync-repro-cases.js > "$TMP/repro.js"
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc "$TMP/repro.js"

# Swift: ordine delle richieste. CFFIXED_USER_HOME è obbligatorio: il repro usa
# il vero handler, che scrive il journal nella Application Support predefinita,
# e senza una home fittizia si rifiuta di partire.
EXT="Kanji Extractor Safari - multi/Shared (Extension)"
SDK="$(xcrun --sdk macosx --show-sdk-path)"
xcrun swiftc -O -sdk "$SDK" -application-extension \
    "$EXT/CloudKitSyncManager.swift" "$EXT/SafariWebExtensionHandler.swift" \
    tests/repro-2026-09-22/native_gate_order_repro.swift -o "$TMP/gate"
mkdir -p "$TMP/home" && CFFIXED_USER_HOME="$TMP/home" "$TMP/gate" "$TMP/gate-dir" 5000

# Swift: profili (usa soltanto la cartella passata come argomento)
xcrun swiftc -O -sdk "$SDK" -application-extension \
    "$EXT/CloudKitSyncManager.swift" "$EXT/SafariWebExtensionHandler.swift" \
    tests/repro-2026-09-22/native_profiles_repro.swift -o "$TMP/profiles"
"$TMP/profiles" "$TMP/profiles-dir"
```

Esiti del 22–23 settembre 2026 sulla build 26: 7/7 casi JS riprodotti; REPRO2
con 14–27 inversioni su 5000; nel repro dei profili B riceve
`stale generation (current 1)` e il suo `reset(1)` risponde ok senza cancellare.
