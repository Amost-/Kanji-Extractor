# iCloud / CloudKit sync — setup

Cross-device history sync is available in Safari. Chrome and Firefox use the
same command dispatcher and local history format, with cloud sync disabled.
Deployment targets: **iOS 15.4** and **macOS 15.6**. The Manifest V3 also declares
Safari 15.4 as its minimum.

## How it fits together

```text
popup.js: commands and persisted progress
    → background.js: browser events and native messaging
    → sync-coordinator.js: one writer, resumable job
        ↔ storage.local.kanjiState
    → SafariWebExtensionHandler.swift
    → NativeSyncCoordinator: operation lock and generation journal
    → CloudKitSyncManager.swift → CloudKit private database
```

Canonical web sources live in `src/`; `build.sh` copies them into the browser
packages. The popup sends commands for history and preference changes. The
background acknowledges a command after saving it, then performs sync
independently of the popup. Recent command receipts prevent transport retries
from repeating an already accepted mutation.

`kanjiState` (schema 2) stores history, preferences, pending term revisions, read
cursor, reset generation and job status as one value. The background is its only
writer. Legacy keys are migrated once and retained as a recovery backup; they
are not merged again. One value avoids partial writes across separate keys, but
is not a filesystem durability or distributed transaction guarantee.

The worker pulls one page and pushes at most 400 terms per native request. Each
page is saved with its cursor; a push acknowledgement removes only revisions
that were actually sent. Phase, queue, errors, next retry and last successful
completion persist. Recovery alarms, browser startup and the periodic alarm
resume pending work; retry delays respect CloudKit's `retryAfter`. Safari may
suspend the worker and delay alarms, so completion has no fixed deadline. See
[the implementation plan and validation limits](sync-implementation-plan.md).

## Data model (private database)

- Record type: **`KanjiTerm`**.
- Custom zone: **`KanjiZone`**.
- `recordName` = **SHA-256(term in NFC)**, providing a stable identity across
  devices and retries.

| Field | Type |
|---|---|
| `term` | String |
| `count` | Int(64) |
| `firstSeen` | String (YYYY-MM-DD) |
| `lastSeen` | String (YYYY-MM-DD) |

URLs remain in local history and are excluded from native/cloud messages.
`count` is the maximum occurrence count in one scan, not a running sum. Conflict
merges preserve the maximum count, earliest known first date and latest known
last date. Repeated uploads therefore do not inflate counts.

## Xcode steps

1. **Check both extension targets.** `CloudKitSyncManager.swift` and
   `SafariWebExtensionHandler.swift` belong to the iOS and macOS extension
   targets. The synchronized `Shared (Extension)` group also includes generated
   resources, including `sync-coordinator.js`.
2. **Enable iCloud → CloudKit** in Signing & Capabilities for both extension
   targets and select `iCloud.it.tomas.Kanji-Extractor-Safari`.
3. **No App Group is required.** Native control state belongs to the extension's
   own container. The containing app does not run the worker or share its data.
   This implementation uses neither `CKSyncEngine` nor long-lived operations.
4. **Keep identifiers aligned.** The Swift identifier and both extension
   `.entitlements` already use `iCloud.it.tomas.Kanji-Extractor-Safari`. If changing
   it, update all of them and enable CloudKit for the matching App ID.
   `icloud-container-environment` is deliberately not pinned in these files;
   Xcode and the provisioning profile determine the environment.
5. **Refresh provisioning.** Automatic signing handles this after iCloud is
   enabled for the App ID. Select the appropriate Apple Developer team.
6. **Deploy the schema to Production.** Development can create the `KanjiTerm`
   record type during a run; Production cannot create a new type this way. In
   CloudKit Console, select the container and **Deploy Schema Changes** to
   promote Development to Production before testing a release build.

Development and Production are separate databases. For a cross-device check,
use the **same iCloud account and CloudKit environment** on both devices. After
changing shared JavaScript, run `build.sh` **and rebuild in Xcode**; regenerating
resource folders alone does not replace the installed extension.

## Native messaging and protocol

`nativeMessaging` is declared only in the Safari manifest. Apple supports native
messages from background scripts and extension UI pages. This project chooses
the background so the popup never owns the sync loop.
`sendNativeMessage("application.id", message)` reaches the bundled handler;
a separate native-host manifest is not needed.

| JS → native | Successful native → JS |
|---|---|
| `{action:"syncState"}` | `{ok:true, generation, resetPending}` |
| `{action:"pull", since:token?, generation}` | `{ok:true, generation, records, deletions, token, more, reset}` |
| `{action:"push", terms:[…], generation}` | `{ok:true, generation}` |
| `{action:"reset", generation}` | `{ok:true, generation}` |

`generation` is a nonnegative JavaScript-safe integer. Legacy reads and writes
without it use zero; resets must supply it. `syncState` reads native control
state without contacting iCloud. Failures return `{ok:false,error,code}`, with
`currentGeneration` for generation/reset conflicts and `retryAfter` in seconds
when CloudKit supplies a delay. The opaque base64 `CKServerChangeToken` belongs
to `kanjiState.syncToken`, not `UserDefaults`.

## Reset journal and limits

The native extension stores control metadata at
`Library/Application Support/KanjiExtractorSync/control.json`, relative to its
sandbox container. `control.lock` in the same directory is an OS lock; do not
remove it while a handler is running. The journal contains no vocabulary or
URLs. `UserDefaults.standard` retains only the cached zone-created flag.

An async FIFO gate and file lock serialize complete operations across network
awaits, including separate handler processes using the same container. A reset
first persists its generation and pending flag, then deletes the CloudKit zone.
A completed reset replay is a no-op; a failed reset remains pending and can be
retried. Old requests are rejected and new work remains blocked until reset
completion.

With sync enabled, **Clear history** persists a cloud-reset intent and retains
the old local history until confirmation. With sync disabled, it clears local
history only. Neither is a distributed deletion protocol: other devices may
retain their history, and individual remote deletions are not applied to the
local term map. The history merge remains additive.

The lock cannot cancel requests already handed to CloudKit's daemon if the
handler process dies. A crash after remote deletion but before the local
completion record can cause a reset retry. There is no atomic transaction
between the journal and CloudKit, or lock across devices.

## Privacy

- Extraction runs locally after **Extract**. Accepted download/share and import
  commands persist local history; optional sync sends terms, counts and dates
  to the user's private CloudKit database. URLs stay on the device.
- `Shared (Extension)/PrivacyInfo.xcprivacy` declares no tracking or collected
  data, and `NSPrivacyAccessedAPICategoryUserDefaults` reason `CA92.1` for the
  extension's own defaults (the zone-created flag).
- `Shared (App)/PrivacyInfo.xcprivacy` declares no tracking, collected data or
  required-reason APIs. Confirm both manifests in the built bundles and the
  Organizer Privacy Report. Keep App Store Connect disclosures consistent with
  actual behavior.
- Sync uses the system iCloud account; there is no custom sign-in flow.

## Quick test

1. Build and run the app, enable the Safari extension and sign into iCloud.
   Enable synchronization in the popup.
2. Extract a page and save its terms: desktop uses the downloads API, iOS uses
   Web Share. Desktop acknowledgement confirms download initiation, not a
   completed file write; cancelling iOS sharing does not commit terms.
3. Close the popup after the history command is accepted. Reopen it to inspect
   pending terms, phase, errors/retry and last successful completion.
4. Repeat with temporary loss of network and browser restart. Pending work must
   remain saved and resume when the system permits.
5. On another device using the same account/environment, sync and export history
   to compare term sets. A locally empty queue and successful completion do not
   prove the other device has already received everything.
