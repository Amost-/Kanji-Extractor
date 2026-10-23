//
//  CloudKitSyncManager.swift
//  Shared (Extension)
//
//  Phase 2b — native iCloud/CloudKit backend for cross-device history sync.
//
//  The web extension background worker speaks JSON to SafariWebExtensionHandler
//  via native messaging. The handler forwards pull/push/reset/abandonReset and
//  the read-only syncState action here. All CloudKit work is native.
//
//  Data model (private database):
//    record type "KanjiTerm", custom zone "KanjiZone"
//    recordName = SHA-256(term in NFC)   // CloudKit recordNames must be ASCII
//    fields: term (String), count (Int64), firstSeen (String), lastSeen (String)
//  URLs are intentionally NOT synced (privacy + size).
//
//  Pull is PAGINATED: each call returns ONE server-bounded page (records + a
//  resumable change token + `more`); JS loops until `more == false`. The change
//  token is owned by JS (storage.local.syncToken) — this manager keeps NO token
//  of its own, so a dropped/oversized response can never advance a cursor past
//  records JS has not durably merged.
//
//  Safari profiles: each profile runs its own copy of the web extension (own
//  storage.local, own generation) but all share this extension container. The
//  handler passes the calling profile, and each profile gets its own journal
//  directory and zone-created flag; the CloudKit zone stays shared.
//
//  SETUP (in Xcode — see docs/icloud-sync-setup.md):
//    • Add this file to BOTH extension targets (iOS + macOS).
//    • Enable iCloud > CloudKit + the container below on the extension targets.
//    • Deploy the CloudKit schema to Production.
//
//  Requires iOS 15 / macOS 12+ (async CloudKit). CKSyncEngine (iOS 17+) is not an
//  option at this deployment target, so the manual recordZoneChanges loop is the
//  correct approach.
//

import CloudKit
import CryptoKit
import Foundation
import CoreFoundation
import Darwin
import os.log

enum SyncError: Error, Sendable {
    case message(String)
    case protocolViolation
    case invalidGeneration
    case staleGeneration(expected: Int)
    case resetPending(expected: Int)
    // Unreadable control journal: distinct from a generic failure because only
    // a reset can clear it, and the popup has to tell the user how.
    case journalDamaged
}

// The handler logs String(describing:), which ignores LocalizedError. Spell the
// cases out so the unified log stays readable — control state only, never
// vocabulary.
extension SyncError: CustomStringConvertible {
    var description: String {
        switch self {
        case .message(let text): return text
        case .protocolViolation: return "invalid native sync message"
        case .invalidGeneration: return "invalid generation"
        case .staleGeneration(let expected): return "stale generation (current \(expected))"
        case .resetPending(let expected): return "reset pending (generation \(expected))"
        case .journalDamaged: return "invalid native sync journal"
        }
    }
}

// JSON numbers must remain exact in JavaScript. In particular, NSNumber(true)
// must not silently become generation 1 through Foundation bridging.
nonisolated enum NativeSyncGeneration {
    static let maximum = 9_007_199_254_740_991

    static func parse(_ value: Any?, allowLegacy: Bool = true) throws -> Int {
        guard let value else {
            if allowLegacy { return 0 }
            throw SyncError.invalidGeneration
        }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw SyncError.invalidGeneration
        }
        let raw = number.doubleValue
        guard raw.isFinite, raw >= 0, raw <= Double(maximum), raw.rounded() == raw else {
            throw SyncError.invalidGeneration
        }
        return Int(raw)
    }
}

// This journal contains only control state, never vocabulary or page URLs. A
// failed reset leaves its fence on disk: old requests must stay rejected even
// if Safari restarts the handler before the reset can be retried.
nonisolated private struct NativeSyncJournal: Codable {
    var generation = 0
    var resetPending = false
    var resetCompleted = false
}

struct NativeSyncState: Sendable {
    let generation: Int
    let resetPending: Bool
}

// Actor isolation alone does not serialize an entire async operation. The FIFO
// gate stays owned through every network await, including conflict retries.
// flock additionally coordinates handler processes using this SAME journal
// directory (one per Safari profile, see journalDirectory). It cannot
// coordinate other profiles' directories, separate containers or other devices.
// If a process dies, the OS releases the lock; requests already handed to
// CloudKit's daemon are not thereby cancelled. Generation fences protect
// request ordering, not an atomic transaction between local disk and the
// CloudKit server.
actor NativeSyncCoordinator {
    private let directory: URL
    private let beforeJournalReplace: (@Sendable () throws -> Void)?
    private var occupied = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    // `directory` holds control.json and control.lock and is created on first
    // use. The optional replacement hook lets offline tests fail after the
    // temporary file is written but before the original fence is replaced.
    init(directory: URL = NativeSyncCoordinator.journalDirectory(
        base: NativeSyncCoordinator.applicationSupportDirectory, profile: nil),
        beforeJournalReplace: (@Sendable () throws -> Void)? = nil) {
        self.directory = directory
        self.beforeJournalReplace = beforeJournalReplace
    }

    // Base of every journal directory: this container's Application Support.
    static var applicationSupportDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    // Where the journal of one Safari profile lives under `base`. Profiles
    // share the extension container but not their JS state, so each needs its
    // own generation fence: with one journal, a reset in one profile would fence
    // every other profile, and a later reset there would be mistaken for a
    // replay of the first one and skip its deletion. The default profile
    // (profile nil: Safari sends no key) keeps the top-level directory, where
    // existing journals already live, so it needs no migration; any other
    // profile gets profiles/<UUID>. Pure, so tests can check the layout.
    // `profile` is an already parsed UUID: no path component is ever taken
    // from the raw request value.
    static func journalDirectory(base: URL, profile: UUID?) -> URL {
        let root = base.appendingPathComponent("KanjiExtractorSync", isDirectory: true)
        guard let profile else { return root }
        // uuidString is uppercase on Apple platforms; uppercasing again pins
        // the name, so no rendering of one UUID can split its journal in two.
        return root.appendingPathComponent("profiles", isDirectory: true)
            .appendingPathComponent(profile.uuidString.uppercased(), isDirectory: true)
    }

    func state() async throws -> NativeSyncState {
        try await exclusively {
            let state = try self.readJournal()
            return NativeSyncState(generation: state.generation, resetPending: state.resetPending)
        }
    }

    func perform<Value: Sendable>(generation: Int,
                                  operation: @Sendable () async throws -> Value) async throws -> Value {
        try await exclusively {
            let state = try self.readJournal()
            guard generation == state.generation else {
                throw SyncError.staleGeneration(expected: state.generation)
            }
            guard !state.resetPending else { throw SyncError.resetPending(expected: state.generation) }
            return try await operation()
        }
    }

    // Clear a reset intent the user gave up on (sync disabled while the zone
    // deletion keeps failing). A newer abandoned generation is persisted so
    // a delayed reset for it cannot delete newer vocabulary.
    func abandonReset(generation: Int) async throws -> (generation: Int, completed: Bool) {
        try await exclusively {
            var state = try self.readJournal()
            guard generation <= NativeSyncGeneration.maximum else { throw SyncError.invalidGeneration }
            guard generation >= state.generation else {
                throw SyncError.staleGeneration(expected: state.generation)
            }
            if generation > state.generation {
                state.generation = generation
                state.resetPending = false
                state.resetCompleted = false
                try self.writeJournal(state)
                return (generation: state.generation, completed: false)
            }
            guard state.resetPending else {
                // The zone was really deleted: JS still has to wipe locally.
                return (generation: state.generation, completed: state.resetCompleted)
            }
            state.resetPending = false
            state.resetCompleted = false
            try self.writeJournal(state)
            return (generation: state.generation, completed: false)
        }
    }

    func reset(generation: Int, operation: @Sendable () async throws -> Void) async throws {
        try await exclusively {
            // Reset is the only way out of a damaged journal: rebuild the fence
            // from scratch instead of failing closed forever. Reads, writes and
            // abandonment must still refuse to reopen it.
            var state: NativeSyncJournal
            do {
                state = try self.readJournal()
            } catch SyncError.journalDamaged {
                try self.quarantineJournal()
                state = NativeSyncJournal()
            }
            guard generation >= state.generation, generation <= NativeSyncGeneration.maximum else {
                throw SyncError.staleGeneration(expected: state.generation)
            }
            if generation == state.generation, state.resetCompleted, !state.resetPending { return }
            guard generation > state.generation || state.resetPending else {
                throw SyncError.invalidGeneration
            }
            state.generation = generation
            state.resetPending = true
            state.resetCompleted = false
            try self.writeJournal(state)
            // A transport timeout in JavaScript does not cancel this work. A
            // retry waits for it and then observes the completed generation.
            try await operation()
            state.resetPending = false
            state.resetCompleted = true
            try self.writeJournal(state)
        }
    }

    private func exclusively<Value: Sendable>(
        _ operation: () async throws -> Value
    ) async throws -> Value {
        await acquire()
        defer { release() }
        try Task.checkCancellation()
        let descriptor = try await acquireFileLock()
        defer {
            _ = flock(descriptor, LOCK_UN)
            close(descriptor)
        }
        return try await operation()
    }

    private func acquire() async {
        if !occupied { occupied = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { occupied = false }
        else { waiters.removeFirst().resume() }
    }

    private func acquireFileLock() async throws -> Int32 {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Never unlink this file: replacing its inode would allow two processes
        // to hold unrelated locks. Nonblocking retries do not occupy a thread.
        let descriptor = open(directory.appendingPathComponent("control.lock").path, O_CREAT | O_RDWR, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        do {
            while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
                let code = errno
                guard code == EWOULDBLOCK || code == EAGAIN || code == EINTR else {
                    throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            return descriptor
        } catch {
            close(descriptor)
            throw error
        }
    }

    private func readJournal() throws -> NativeSyncJournal {
        let url = directory.appendingPathComponent("control.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return NativeSyncJournal() }
        // A read error is transient (the file is still whatever it was), so it
        // propagates as itself; only unusable contents are "damaged".
        let data = try Data(contentsOf: url)
        // Decode failures fail closed; silently returning generation 0 would
        // reopen the fence after a damaged or partially restored local store.
        // Only reset may clear this, after preserving a copy of the file.
        guard let state = try? JSONDecoder().decode(NativeSyncJournal.self, from: data) else {
            throw SyncError.journalDamaged
        }
        guard state.generation >= 0, state.generation <= NativeSyncGeneration.maximum,
              !(state.resetPending && state.resetCompleted) else {
            throw SyncError.journalDamaged
        }
        return state
    }

    // Keep a copy for diagnostics while the original remains the fence until
    // an atomic replacement succeeds. Never log its arbitrary contents.
    private func quarantineJournal() throws {
        let damaged = directory.appendingPathComponent("control.json.damaged")
        try? FileManager.default.removeItem(at: damaged)
        try FileManager.default.copyItem(at: directory.appendingPathComponent("control.json"), to: damaged)
        os_log(.error, "Native sync journal unreadable; copied aside for rebuild")
    }

    private func writeJournal(_ state: NativeSyncJournal) throws {
        let target = directory.appendingPathComponent("control.json")
        let temporary = directory.appendingPathComponent("control.\(UUID().uuidString).tmp")
        defer { try? FileManager.default.removeItem(at: temporary) }
        try JSONEncoder().encode(state).write(to: temporary, options: .withoutOverwriting)
        try beforeJournalReplace?()
        guard rename(temporary.path, target.path) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }
}

// Shared wire limits keep imported messages, conflict merges and decoded
// CloudKit records within the same count and date domain as JavaScript.
nonisolated enum NativeTermField {
    static let maximumCount = 1_000_000
    static let maximumCodePoints = 64

    // Keep count arithmetic bounded before it enters a message or CKRecord.
    static func count(_ value: Int) -> Int {
        min(max(0, value), maximumCount)
    }

    // Lexical date merging is valid only for real, zero-padded calendar days.
    // Invalid wire values are unknown; callers merge the other fields normally.
    static func date(_ value: String) -> String {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              [0, 1, 2, 3, 5, 6, 8, 9].allSatisfy({ bytes[$0] >= 48 && bytes[$0] <= 57 }),
              let year = Int(value.prefix(4)),
              let month = Int(value.dropFirst(5).prefix(2)),
              let day = Int(value.suffix(2)), year >= 1 else { return "" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? calendar.timeZone
        guard let parsed = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return "" }
        let fields = calendar.dateComponents([.year, .month, .day], from: parsed)
        return fields.year == year && fields.month == month && fields.day == day ? value : ""
    }
}

// One term as exchanged with JS. A value type so it crosses the actor boundary
// cleanly (Sendable) — CKRecord/CKError never escape the actor.
nonisolated struct KanjiTermDTO: Sendable {
    let term: String
    let count: Int
    let firstSeen: String
    let lastSeen: String

    var asMessage: [String: Any] {
        ["term": term, "count": NativeTermField.count(count),
         "firstSeen": NativeTermField.date(firstSeen), "lastSeen": NativeTermField.date(lastSeen)]
    }

    // Normalize before grouping, not just before hashing the record ID. Older
    // imports can contain both composed and decomposed spellings of one term.
    // Sending both records in one CloudKit batch would duplicate its record ID.
    static func coalescedMessages(_ messages: [[String: Any]]) -> [KanjiTermDTO] {
        var byTerm: [String: KanjiTermDTO] = [:]
        for message in messages {
            guard let rawTerm = message["term"] as? String, !rawTerm.isEmpty,
                  rawTerm.unicodeScalars.count <= NativeTermField.maximumCodePoints else { continue }
            let term = rawTerm.precomposedStringWithCanonicalMapping
            let incoming = KanjiTermDTO(
                term: term,
                count: NativeTermField.count((message["count"] as? Int) ?? 0),
                firstSeen: NativeTermField.date((message["firstSeen"] as? String) ?? ""),
                lastSeen: NativeTermField.date((message["lastSeen"] as? String) ?? "")
            )
            byTerm[term] = byTerm[term].map { $0.merging(incoming) } ?? incoming
        }
        return Array(byTerm.values)
    }

    // Shared by duplicate-input coalescing and CloudKit conflict resolution.
    // Empty dates mean unknown and must not replace a known first/last date.
    func merging(_ other: KanjiTermDTO) -> KanjiTermDTO {
        let firstDates = [firstSeen, other.firstSeen].map(NativeTermField.date).filter { !$0.isEmpty }
        let lastDates = [lastSeen, other.lastSeen].map(NativeTermField.date).filter { !$0.isEmpty }
        return KanjiTermDTO(
            term: term.precomposedStringWithCanonicalMapping,
            count: max(NativeTermField.count(count), NativeTermField.count(other.count)),
            firstSeen: firstDates.min() ?? "",
            lastSeen: lastDates.max() ?? ""
        )
    }
}

// Pure conflict resolution tells the CloudKit path whether the server already
// contains the maximum merge, avoiding a redundant save and change event.
nonisolated enum NativeMergeDecision {
    // Returns the merged value and whether it differs from the server value.
    static func resolve(local: KanjiTermDTO, server: KanjiTermDTO) -> (value: KanjiTermDTO, needsSave: Bool) {
        let merged = local.merging(server)
        let needsSave = merged.term != server.term || merged.count != server.count ||
            merged.firstSeen != server.firstSeen || merged.lastSeen != server.lastSeen
        return (merged, needsSave)
    }
}

// Pure per-item policy keeps successful terms independent of failures and
// bounds retries for CloudKit's size-limit response.
nonisolated enum NativePushBatchPolicy {
    static let maximumSplitDepth = 4

    // Returns confirmed terms and the terms whose size errors need smaller batches.
    static func classify(_ outcomes: [(String, Error?)]) -> (confirmed: [String], limited: [String]) {
        var confirmed: [String] = []
        var limited: [String] = []
        for (term, error) in outcomes {
            if let error {
                if let ck = error as? CKError, ck.code == .limitExceeded { limited.append(term) }
            } else { confirmed.append(term) }
        }
        return (confirmed, limited)
    }

    // Returns two retry halves only for limitExceeded below the depth cap;
    // single records and exhausted batches remain unconfirmed for a later push.
    static func retryBatches<T>(after error: Error, items: [T], depth: Int) -> [[T]] {
        guard let ck = error as? CKError, ck.code == .limitExceeded,
              items.count > 1, depth < maximumSplitDepth else { return [] }
        let middle = items.count / 2
        return [Array(items[..<middle]), Array(items[middle...])]
    }
}

// One page of zone changes returned to JS.
//   token : base64 CKServerChangeToken for THIS page (the resume cursor)
//   more  : call pull again with `token` to get the next page
//   reset : the manager had to restart from scratch (expired token / missing
//           zone) — JS should adopt `token` as a fresh lineage and re-merge.
struct ZoneChangesPage: Sendable {
    let terms: [KanjiTermDTO]
    let deletions: [String]
    let token: String?
    let more: Bool
    let reset: Bool
}

// Each Safari profile has its own coordinator, which serializes that profile's
// full operations. Operations of different profiles are independent and may
// interleave here at network awaits; this actor protects the manager's
// properties (per-profile coordinators and zone flags) while they do.
//
// The CloudKit zone itself is shared by all profiles (same iCloud account), so
// for the zone each profile behaves like another device: a reset in one profile
// deletes the zone the others sync, exactly as a reset on another device does.
// Only the local bookkeeping (journal, zone-created flag) is per profile.
actor CloudKitSyncManager {
    static let shared = CloudKitSyncManager()
    // One native pull reply stays within the same 400-record page budget as JS.
    static let pullResultsLimit = 400

    // Must match the iCloud container enabled on the extension targets (and
    // created in the Apple Developer portal). Keep identical in the entitlements
    // files and docs/icloud-sync-setup.md.
    private let containerID = "iCloud.it.tomas.Kanji-Extractor-Safari"

    private let recordType = "KanjiTerm"
    private let zoneID = CKRecordZone.ID(zoneName: "KanjiZone", ownerName: CKCurrentUserDefaultName)

    private lazy var container = CKContainer(identifier: containerID)
    private var db: CKDatabase { container.privateCloudDatabase }
    // Only the zone-created flags are cached here; the change token lives on the
    // JS side. No App Group needed (avoids the macOS team-prefix rules).
    private let defaults = UserDefaults.standard

    // Profiles (nil = default profile) whose zone is known to exist in this
    // process; the persisted counterpart is zoneCreatedKey(for:).
    private var zoneEnsured: Set<UUID?> = []
    // One coordinator per profile, created on first use (see coordinator(for:)).
    private var coordinators: [UUID?: NativeSyncCoordinator] = [:]

    private init() {}

    // MARK: - Public API (called from the handler)
    //
    // `profile` is the Safari profile the request came from, nil for the
    // default profile. It selects the journal and the zone-created flag only.

    func syncState(profile: UUID? = nil) async throws -> NativeSyncState {
        try await coordinator(for: profile).state()
    }

    // Fetch ONE bounded page of changes for the token JS provides (nil = full
    // pull). On an expired token or a missing zone, recover by restarting from
    // nil and flag `reset` so JS adopts the fresh lineage.
    func pull(sinceBase64: String?, generation: Int = 0, profile: UUID? = nil) async throws -> ZoneChangesPage {
        try await coordinator(for: profile).perform(generation: generation) {
            try await self.pullPage(sinceBase64: sinceBase64, profile: profile)
        }
    }

    private func pullPage(sinceBase64: String?, profile: UUID?) async throws -> ZoneChangesPage {
        try await ensureZone(for: profile)
        do {
            return try await fetchPage(token: unarchiveToken(sinceBase64), reset: false)
        } catch let e as CKError where e.code == .userDeletedZone {
            // The user deleted this app's iCloud data in Settings. Apple's
            // guidance is to respect that deletion, not silently recreate the
            // zone — clear this profile's flag and rethrow so JS turns sync off
            // instead of retrying forever against a zone that stays gone.
            // Other profiles keep their own flag, so they skip the zone save and
            // meet this same error themselves rather than recreating the zone.
            markZoneMissing(for: profile)
            throw e
        } catch let e as CKError where e.code == .zoneNotFound {
            // Zone deleted out-of-band (another device or Safari profile
            // cleared history).
            markZoneMissing(for: profile)
            try await ensureZone(for: profile)
            return try await fetchPage(token: nil, reset: true)
        } catch let e as CKError where e.code == .changeTokenExpired {
            // Token too old: CloudKit requires a full refetch from nil.
            return try await fetchPage(token: nil, reset: true)
        }
    }

    func push(_ terms: [[String: Any]], generation: Int = 0, profile: UUID? = nil) async throws -> [String] {
        let values = KanjiTermDTO.coalescedMessages(terms)
        return try await coordinator(for: profile).perform(generation: generation) {
            try await self.pushValues(values, profile: profile)
        }
    }

    private func pushValues(_ terms: [KanjiTermDTO], profile: UUID?) async throws -> [String] {
        try await ensureZone(for: profile)
        let records = terms.map(buildRecord)
        guard !records.isEmpty else { return [] }
        do {
            return Array(try await saveWithMerge(records, attempt: 0, splitDepth: 0)).sorted()
        } catch let e as CKError where e.code == .userDeletedZone {
            // Same respect-the-deletion rule as pullPage. saveWithMerge
            // surfaces a whole-operation zone deletion here.
            markZoneMissing(for: profile)
            throw e
        } catch let e as CKError where e.code == .zoneNotFound {
            // Zone removed out-of-band: recreate it and retry once.
            markZoneMissing(for: profile)
            try await ensureZone(for: profile)
            return Array(try await saveWithMerge(records, attempt: 0, splitDepth: 0)).sorted()
        }
    }

    func reset(generation: Int, profile: UUID? = nil) async throws {
        try await coordinator(for: profile).reset(generation: generation) {
            try await self.deleteZone(for: profile)
        }
    }

    // Control state only — no CloudKit call, so the user can still disable sync
    // while iCloud is the very thing that is unavailable.
    func abandonReset(generation: Int, profile: UUID? = nil) async throws -> (generation: Int, completed: Bool) {
        try await coordinator(for: profile).abandonReset(generation: generation)
    }

    // The coordinator of `profile`, created on first use and then kept for the
    // life of this handler process. Synchronous on purpose: with no suspension
    // between lookup and insert, concurrent requests from one profile always
    // get the same coordinator, hence one FIFO gate per profile in a process
    // (the lock file in the profile's directory covers other processes).
    private func coordinator(for profile: UUID?) -> NativeSyncCoordinator {
        if let existing = coordinators[profile] { return existing }
        let created = NativeSyncCoordinator(directory: NativeSyncCoordinator.journalDirectory(
            base: NativeSyncCoordinator.applicationSupportDirectory, profile: profile))
        coordinators[profile] = created
        return created
    }

    // UserDefaults key of the zone-created flag of `profile`. The default
    // profile keeps the plain key it already has on disk; other profiles append
    // their canonical UUID. Pure, so tests can check it without CloudKit.
    static func zoneCreatedKey(for profile: UUID?) -> String {
        guard let profile else { return "kanjiZoneCreated" }
        return "kanjiZoneCreated.\(profile.uuidString.uppercased())"
    }

    // Deletes the shared zone for a reset requested by `profile`, and clears
    // that profile's flag only: other profiles learn of the deletion the way
    // other devices do, through zoneNotFound on their next pull or push.
    private func deleteZone(for profile: UUID?) async throws {
        do {
            let res = try await db.modifyRecordZones(saving: [], deleting: [zoneID])
            // Per-zone failures come back in deleteResults, not as a thrown
            // error — surface them, or a failed wipe would report ok and let
            // the cleared history resurrect from the cloud on the next pull.
            if case .failure(let err)? = res.deleteResults[zoneID], !Self.isZoneGone(err) {
                throw err
            }
        } catch let e as CKError where Self.isZoneGone(e) {
            // Zone already absent — whether it was already deleted here or the
            // user deleted this app's iCloud data in Settings — so the reset
            // has nothing left to remove; treat it as success.
        }
        // Any other error (notAuthenticated, networkUnavailable, …) propagates so
        // the handler reports {ok:false}; JS keeps its syncToken intact.
        markZoneMissing(for: profile)
    }

    // True when `error` means the zone is already gone: directly (zoneNotFound
    // or userDeletedZone) or as a partialFailure whose per-item errors are all
    // one of those two. Pure and offline-testable on purpose — deleteZone is
    // the only caller, but reset must not treat any other CKError (network,
    // auth, quota, …) as "nothing to do".
    static func isZoneGone(_ error: Error) -> Bool {
        guard let ck = error as? CKError else { return false }
        if ck.code == .zoneNotFound || ck.code == .userDeletedZone { return true }
        guard ck.code == .partialFailure,
              let perItem = ck.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: Error] else {
            return false
        }
        return !perItem.isEmpty && perItem.values.allSatisfy { isZoneGone($0) }
    }

    // MARK: - CloudKit helpers

    // Makes sure the shared zone exists before `profile` reads or writes it.
    // The flags are per profile, like per device: each profile creates the
    // zone once, then trusts its own flag until it sees the zone missing.
    private func ensureZone(for profile: UUID?) async throws {
        if zoneEnsured.contains(profile) { return }
        let key = Self.zoneCreatedKey(for: profile)
        // Skip the network round-trip if the zone was already created in a prior
        // (short-lived) handler process — persisted, since the singleton resets
        // when the extension process is torn down between native messages.
        if defaults.bool(forKey: key) { zoneEnsured.insert(profile); return }
        // Saving an existing zone is idempotent; a real error (network, auth)
        // propagates and leaves the flags unset so we retry next time.
        _ = try await db.save(CKRecordZone(zoneID: zoneID))
        defaults.set(true, forKey: key)
        zoneEnsured.insert(profile)
    }

    // Forgets that the zone exists for `profile` only, in memory and on disk.
    private func markZoneMissing(for profile: UUID?) {
        zoneEnsured.remove(profile)
        defaults.removeObject(forKey: Self.zoneCreatedKey(for: profile))
    }

    // ONE server batch per call. recordZoneChanges returns a server-bounded page
    // plus moreComing + a resumable changeToken; we surface both to JS instead of
    // looping here, so each native message stays small.
    private func fetchPage(token: CKServerChangeToken?, reset: Bool) async throws -> ZoneChangesPage {
        let res = try await db.recordZoneChanges(inZoneWith: zoneID, since: token,
                                                 resultsLimit: Self.pullResultsLimit)
        var terms: [KanjiTermDTO] = []
        for (_, result) in res.modificationResultsByID {
            // A successful request can still contain individual record errors.
            // Do not return the newer cursor until every record was fetched;
            // otherwise JS would persist it and permanently skip the failures.
            let modification = try result.get()
            terms.append(dto(modification.record))
        }
        let deletions = res.deletions.map { $0.recordID.recordName }
        return ZoneChangesPage(
            terms: terms,
            deletions: deletions,
            token: archiveToken(res.changeToken),
            more: res.moreComing,
            reset: reset
        )
    }

    // Save with bounded conflict and size retries. Only proven saves (including
    // server-equal merges) enter the returned set; per-record errors keep the
    // other records' successes and leave failed terms queued in JavaScript.
    private func saveWithMerge(_ records: [CKRecord], attempt: Int,
                               splitDepth: Int) async throws -> Set<String> {
        let saveResults: [CKRecord.ID: Result<CKRecord, Error>]
        do {
            let result = try await db.modifyRecords(
                saving: records, deleting: [],
                savePolicy: .ifServerRecordUnchanged, atomically: false
            )
            saveResults = result.saveResults
        } catch {
            let halves = NativePushBatchPolicy.retryBatches(after: error, items: records, depth: splitDepth)
            if halves.isEmpty {
                // The caller retains an unsplittable term for a later attempt.
                if let ck = error as? CKError, ck.code == .limitExceeded { return [] }
                throw error
            }
            var confirmed = Set<String>()
            for half in halves {
                do {
                    confirmed.formUnion(try await saveWithMerge(half, attempt: attempt, splitDepth: splitDepth + 1))
                } catch let ck as CKError where ck.code == .userDeletedZone || ck.code == .zoneNotFound {
                    throw ck
                } catch {
                    // A failed half cannot undo confirmations from its sibling.
                    continue
                }
            }
            return confirmed
        }
        var confirmed = Set<String>()
        var conflicts: [CKRecord] = []
        var outcomes: [(String, Error?)] = []
        for record in records {
            let term = dto(record).term
            guard let outcome = saveResults[record.recordID] else { continue }
            switch outcome {
            case .success:
                outcomes.append((term, nil))
            case .failure(let error):
                guard let ck = error as? CKError else { continue }
                // A per-record zone loss means the whole zone is gone: surface
                // it so pushValues clears the zone flag, as for a whole-operation error.
                if ck.code == .userDeletedZone || ck.code == .zoneNotFound { throw ck }
                guard ck.code == .serverRecordChanged,
                      let server = ck.userInfo[CKRecordChangedErrorServerRecordKey] as? CKRecord else {
                    outcomes.append((term, error))
                    continue
                }
                let decision = NativeMergeDecision.resolve(local: dto(record), server: dto(server))
                if !decision.needsSave {
                    outcomes.append((term, nil))
                    continue
                }
                server["term"] = decision.value.term as CKRecordValue
                server["count"] = Int64(decision.value.count) as CKRecordValue
                server["firstSeen"] = decision.value.firstSeen as CKRecordValue
                server["lastSeen"] = decision.value.lastSeen as CKRecordValue
                conflicts.append(server)
            }
        }
        let classified = NativePushBatchPolicy.classify(outcomes)
        confirmed.formUnion(classified.confirmed)
        let limitedTerms = Set(classified.limited)
        let limited = records.filter { limitedTerms.contains(dto($0).term) }
        if !limited.isEmpty {
            let halves = NativePushBatchPolicy.retryBatches(after: CKError(.limitExceeded),
                                                              items: limited, depth: splitDepth)
            for half in halves {
                do {
                    confirmed.formUnion(try await saveWithMerge(half, attempt: attempt, splitDepth: splitDepth + 1))
                } catch let ck as CKError where ck.code == .userDeletedZone || ck.code == .zoneNotFound {
                    throw ck
                } catch {
                    // Keep other terms' confirmations when this retry fails.
                    continue
                }
            }
        }
        if !conflicts.isEmpty && attempt < 3 {
            confirmed.formUnion(try await saveWithMerge(conflicts, attempt: attempt + 1,
                                                        splitDepth: splitDepth))
        }
        return confirmed
    }

    private func buildRecord(from term: KanjiTermDTO) -> CKRecord {
        let rid = CKRecord.ID(recordName: recordName(for: term.term), zoneID: zoneID)
        let rec = CKRecord(recordType: recordType, recordID: rid)
        rec["term"] = term.term as CKRecordValue
        rec["count"] = Int64(term.count) as CKRecordValue
        rec["firstSeen"] = term.firstSeen as CKRecordValue
        rec["lastSeen"] = term.lastSeen as CKRecordValue
        return rec
    }

    private func dto(_ r: CKRecord) -> KanjiTermDTO {
        // CKRecord int values come back as NSNumber; read defensively as Int64
        // then narrow, so the count never silently becomes 0 via a failed cast.
        // Bound corrupt or hand-crafted records before they reach local history.
        let count = NativeTermField.count((r["count"] as? Int64).map(Int.init) ?? (r["count"] as? Int) ?? 0)
        return KanjiTermDTO(
            term: (r["term"] as? String) ?? "",
            count: count,
            firstSeen: NativeTermField.date((r["firstSeen"] as? String) ?? ""),
            lastSeen: NativeTermField.date((r["lastSeen"] as? String) ?? "")
        )
    }

    private func recordName(for term: String) -> String {
        let nfc = term.precomposedStringWithCanonicalMapping
        let digest = SHA256.hash(data: Data(nfc.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Change-token wire encoding (opaque base64, round-tripped via JS)

    private func archiveToken(_ token: CKServerChangeToken?) -> String? {
        guard let token,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true) else {
            return nil
        }
        return data.base64EncodedString()
    }

    private func unarchiveToken(_ base64: String?) -> CKServerChangeToken? {
        guard let base64, let data = Data(base64Encoded: base64) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }

}
