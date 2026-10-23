import Foundation
import CloudKit
import SafariServices

private actor NativeTestSignal {
    private var signalled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if signalled { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func signal() {
        signalled = true
        for waiter in waiters { waiter.resume() }
        waiters.removeAll()
    }
}

private actor NativeTestTrace {
    private var events: [String] = []
    func append(_ event: String) { events.append(event) }
    func read() -> [String] { events }
}

// Carries one asynchronous handler reply across the test's delivery thread.
private final class NativeTestReplyBox: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()

    // Stores the JSON bytes before the completion group is released.
    func set(_ data: Data) { lock.lock(); bytes = data; lock.unlock() }

    // Returns the completed response as a property-list-compatible dictionary.
    func read() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ((try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]) ?? [:]
    }
}

// Stands in for Safari's NSExtensionContext so the real handler can be driven
// offline: it carries one request item (message plus optional profile value)
// and hands the reply back as JSON. JSON keeps the reply Sendable across the
// handler's Task and checks that it is serializable, as a reply to JS must be.
private final class NativeTestContext: NSExtensionContext, @unchecked Sendable {
    private let request = NSExtensionItem()
    private let reply: @Sendable (Data) -> Void

    // `profile` nil omits SFExtensionProfileKey, as Safari does for the
    // default profile; any other value is stored exactly as given.
    init(message: [String: Any], profile: Any?, reply: @escaping @Sendable (Data) -> Void) {
        var info: [AnyHashable: Any] = [SFExtensionMessageKey: message]
        if let profile { info[SFExtensionProfileKey] = profile }
        request.userInfo = info
        self.reply = reply
        super.init()
    }

    override var inputItems: [Any] { [request] }

    // An unserializable reply comes back as empty Data, which the caller
    // decodes to an empty dictionary and so fails every check on it.
    override func completeRequest(returningItems items: [Any]?, completionHandler: (@Sendable (Bool) -> Void)? = nil) {
        let payload = (items?.first as? NSExtensionItem)?.userInfo?[SFExtensionMessageKey] ?? [String: Any]()
        reply((try? JSONSerialization.data(withJSONObject: payload)) ?? Data())
    }
}

// Exercise the production DTO transforms without initializing CKContainer or
// making a CloudKit request. Compiled with CloudKitSyncManager.swift by the runner.
@main
struct NativeSyncCases {
    static func main() async throws {
        // A second executable instance exercises the actual interprocess lock.
        // It uses an isolated temporary directory and never creates CKContainer.
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--hold-native-lock" {
            let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            let coordinator = NativeSyncCoordinator(directory: directory)
            try await coordinator.perform(generation: 0) {
                try Data().write(to: directory.appendingPathComponent("child-ready"))
                let deadline = Date().addingTimeInterval(5)
                while !FileManager.default.fileExists(atPath: directory.appendingPathComponent("child-release").path) {
                    guard Date() < deadline else { throw SyncError.message("child lock test timed out") }
                    try await Task.sleep(nanoseconds: 10_000_000)
                }
            }
            return
        }
        // A third mode drives the real handler under a temporary home; the
        // parent sets CFFIXED_USER_HOME before launching it.
        if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--handler-profiles" {
            try await handlerProfileCases()
            try handlerOrderCases()
            return
        }
        var checks = 0
        func expect(_ condition: Bool, _ message: String) {
            guard condition else {
                print("FAIL: \(message)")
                exit(1)
            }
            checks += 1
        }

        let composed = "火が"
        let decomposed = "火か\u{3099}"
        let messages: [[String: Any]] = [
            ["term": decomposed, "count": 7, "firstSeen": "2026-09-03", "lastSeen": "2026-09-05"],
            ["term": composed, "count": 12, "firstSeen": "2026-08-01", "lastSeen": "2026-09-04"],
            ["term": "水", "count": NSNumber(value: 3), "firstSeen": "", "lastSeen": ""],
        ]
        let coalesced = KanjiTermDTO.coalescedMessages(messages)
        expect(coalesced.count == 2, "canonical aliases produce a single push record")
        let fire = coalesced.first { $0.term == composed }!
        expect(Array(fire.term.unicodeScalars) == Array(composed.unicodeScalars), "wire term uses NFC code points")
        expect(fire.count == 12, "coalescing preserves the largest count")
        expect(fire.firstSeen == "2026-08-01", "coalescing preserves the earliest firstSeen")
        expect(fire.lastSeen == "2026-09-05", "coalescing preserves the latest lastSeen")
        expect(coalesced.first { $0.term == "水" }!.count == 3, "native NSNumber counts survive bridging")

        let reverse = KanjiTermDTO.coalescedMessages(messages.reversed()).first { $0.term == composed }!
        expect(reverse.asMessage as NSDictionary == fire.asMessage as NSDictionary, "coalescing is independent of message order")
        let repeated = KanjiTermDTO.coalescedMessages(messages + messages).first { $0.term == composed }!
        expect(repeated.asMessage as NSDictionary == fire.asMessage as NSDictionary, "retrying duplicate inputs does not inflate counts")

        let invalid: [[String: Any]] = [
            [:], ["term": ""], ["term": 42],
            ["term": "山", "count": -8], ["term": "川", "count": "invalid"],
        ]
        let sanitized = KanjiTermDTO.coalescedMessages(invalid)
        expect(sanitized.count == 2, "missing, empty and nonstring terms are skipped")
        expect(sanitized.allSatisfy { $0.count == 0 }, "invalid and negative counts are clamped")
        expect(sanitized.allSatisfy { $0.firstSeen.isEmpty && $0.lastSeen.isEmpty }, "missing dates remain unknown")

        // A malicious or damaged count must stay within the common JS/native bound.
        let oversized = KanjiTermDTO.coalescedMessages([
            ["term": "大", "count": Int.max, "firstSeen": "2026-09-01", "lastSeen": "2026-09-07"],
            ["term": "大", "count": 5, "firstSeen": "2026-09-02", "lastSeen": "2026-09-08"],
        ]).first!
        expect(oversized.count == 1_000_000, "native message counts clamp to the common ceiling")
        let conflictCount = KanjiTermDTO(term: "大", count: Int.max, firstSeen: "", lastSeen: "")
            .merging(KanjiTermDTO(term: "大", count: 4, firstSeen: "", lastSeen: ""))
        expect(conflictCount.count == 1_000_000, "native conflict merge clamps stored counts")
        let invalidDate = KanjiTermDTO.coalescedMessages([
            ["term": "日", "count": 2, "firstSeen": "2026-02-30", "lastSeen": "zzzz"],
            ["term": "日", "count": 3, "firstSeen": "2026-09-01", "lastSeen": "2026-09-07"],
        ]).first!
        expect(invalidDate.firstSeen == "2026-09-01" && invalidDate.lastSeen == "2026-09-07",
               "invalid native dates do not win conflict comparisons")

        // Simulate both sides of an optimistic CloudKit write conflict using
        // the same merge invoked by saveWithMerge after serverRecordChanged.
        let local = KanjiTermDTO(term: decomposed, count: 7, firstSeen: "2026-09-01", lastSeen: "2026-09-05")
        let server = KanjiTermDTO(term: composed, count: 20, firstSeen: "2026-08-01", lastSeen: "2026-09-03")
        let merged = local.merging(server)
        expect(merged.count == 20, "stale local pushes cannot reduce the server count")
        expect(merged.firstSeen == "2026-08-01", "conflict merge preserves the server's earlier date")
        expect(merged.lastSeen == "2026-09-05", "conflict merge preserves the local later date")
        expect(Array(merged.term.unicodeScalars) == Array(composed.unicodeScalars), "conflict merge normalizes the term")
        expect(server.merging(local).asMessage as NSDictionary == merged.asMessage as NSDictionary, "conflict merge is commutative")
        expect(merged.merging(local).asMessage as NSDictionary == merged.asMessage as NSDictionary, "conflict retries are idempotent")

        let unknown = KanjiTermDTO(term: composed, count: 0, firstSeen: "", lastSeen: "")
        expect(unknown.merging(local).firstSeen == local.firstSeen, "unknown firstSeen does not erase a known date")
        expect(local.merging(unknown).lastSeen == local.lastSeen, "unknown lastSeen does not erase a known date")
        expect(unknown.merging(unknown).firstSeen.isEmpty, "two unknown dates remain unknown")

        // Pure push decisions let an offline fixture simulate partial CloudKit
        // results without requiring credentials or a zone.
        let decisions = NativePushBatchPolicy.classify([
            ("学校", nil), ("日本", CKError(.networkFailure)),
            ("山", CKError(.limitExceeded)), ("川", CKError(.userDeletedZone)),
        ])
        expect(decisions.confirmed == ["学校"], "one record failure does not discard a successful term")
        expect(decisions.limited == ["山"], "a limited record is reserved for splitting")
        let split = NativePushBatchPolicy.retryBatches(after: CKError(.limitExceeded),
                                                       items: [1, 2, 3, 4], depth: 0)
        expect(split == [[1, 2], [3, 4]], "limitExceeded retries two smaller halves")
        expect(NativePushBatchPolicy.retryBatches(after: CKError(.limitExceeded),
                                                  items: [1, 2], depth: NativePushBatchPolicy.maximumSplitDepth).isEmpty,
               "limitExceeded stops at a bounded depth")
        let noWrite = NativeMergeDecision.resolve(local: unknown, server: server)
        expect(!noWrite.needsSave && noWrite.value.asMessage as NSDictionary == server.asMessage as NSDictionary,
               "a merge equal to the server needs no write")
        let write = NativeMergeDecision.resolve(local: local, server: server)
        expect(write.needsSave && write.value.lastSeen == "2026-09-05",
               "a merge with a newer local date needs a write")

        expect(try NativeSyncGeneration.parse(nil) == 0, "legacy reads/writes use generation zero")
        expect(try NativeSyncGeneration.parse(NSNumber(value: 22)) == 22, "integer generations cross native messaging")
        expect(try NativeSyncGeneration.parse(NSNumber(value: NativeSyncGeneration.maximum)) == NativeSyncGeneration.maximum,
               "maximum JavaScript-safe generation is supported")
        for value: Any in [true, -1, 1.5, "1", Double.infinity, Double.nan, 9_007_199_254_740_992.0] {
            do {
                _ = try NativeSyncGeneration.parse(value)
                expect(false, "invalid generation must be rejected: \(value)")
            } catch SyncError.invalidGeneration { expect(true, "invalid generation rejected") }
        }
        do {
            _ = try NativeSyncGeneration.parse(nil, allowLegacy: false)
            expect(false, "reset must identify its generation")
        } catch SyncError.invalidGeneration { expect(true, "legacy destructive reset rejected") }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-control-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinator = NativeSyncCoordinator(directory: directory)
        let trace = NativeTestTrace()
        let state = try await coordinator.state()
        expect(state.generation == 0 && !state.resetPending, "empty native storage begins at generation zero")
        do {
            try await coordinator.reset(generation: 0) { await trace.append("invalid initial reset") }
            expect(false, "a new reset must advance the generation")
        } catch SyncError.invalidGeneration { expect(true, "new reset cannot reuse a normal generation") }

        // A suspended push must finish before reset enters, even though both
        // operations execute on the same reentrant actor. The first request
        // also models a caller that timed out and stopped awaiting its result.
        let entered = NativeTestSignal()
        let resume = NativeTestSignal()
        let push = Task {
            try await coordinator.perform(generation: 0) {
                await trace.append("push entered")
                await entered.signal()
                await resume.wait()
                await trace.append("push completed")
            }
        }
        await entered.wait()
        let reset = Task {
            try await coordinator.reset(generation: 1) { await trace.append("reset completed") }
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let whileSuspended = await trace.read()
        expect(whileSuspended == ["push entered"], "reset cannot interleave while push is suspended")
        await resume.signal()
        try await push.value
        try await reset.value
        let ordered = await trace.read()
        expect(ordered == ["push entered", "push completed", "reset completed"], "complete operations preserve reset ordering")

        // Recreating a coordinator models a fresh handler process. Completed
        // reset replays must not delete vocabulary saved in the new generation.
        let restarted = NativeSyncCoordinator(directory: directory)
        try await restarted.perform(generation: 1) { await trace.append("new vocabulary") }
        try await restarted.reset(generation: 1) { await trace.append("duplicate reset") }
        let replayEvents = await trace.read()
        expect(!replayEvents.contains("duplicate reset"), "completed reset is idempotent after handler restart")
        do {
            try await restarted.perform(generation: 0) { await trace.append("stale push") }
            expect(false, "old push must be rejected after reset")
        } catch SyncError.staleGeneration(let expected) { expect(expected == 1, "stale response includes current generation") }
        do {
            try await restarted.reset(generation: 0) { await trace.append("stale reset") }
            expect(false, "old reset must be rejected")
        } catch SyncError.staleGeneration { expect(true, "old reset rejected") }

        do {
            try await restarted.reset(generation: 2) { throw SyncError.message("offline") }
            expect(false, "reset network failure propagates")
        } catch SyncError.message { expect(true, "reset network failure propagated") }
        let afterFailure = NativeSyncCoordinator(directory: directory)
        let pending = try await afterFailure.state()
        expect(pending.generation == 2 && pending.resetPending, "failed reset fence survives handler restart")
        do {
            try await afterFailure.perform(generation: 2) { await trace.append("blocked push") }
            expect(false, "new generation stays blocked until reset succeeds")
        } catch SyncError.resetPending(let expected) { expect(expected == 2, "pending reset response identifies generation") }
        try await afterFailure.reset(generation: 2) { await trace.append("reset retry succeeded") }
        let recovered = try await afterFailure.state()
        expect(recovered.generation == 2 && !recovered.resetPending, "same generation retries a failed reset")
        try await afterFailure.perform(generation: 2) { await trace.append("push after recovery") }
        expect((await trace.read()).contains("push after recovery"), "writes resume after reset recovery")

        // Independent coordinators have independent actor gates. Only the OS
        // lock prevents their CloudKit sections from overlapping.
        let lockEntered = NativeTestSignal()
        let lockResume = NativeTestSignal()
        let holder = Task {
            try await coordinator.perform(generation: 2) {
                await trace.append("file lock held")
                await lockEntered.signal()
                await lockResume.wait()
                await trace.append("file lock released")
            }
        }
        await lockEntered.wait()
        let other = Task {
            try await restarted.reset(generation: 3) { await trace.append("independent reset") }
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        expect(!(await trace.read()).contains("independent reset"), "independent coordinators share an OS lock")
        await lockResume.signal()
        try await holder.value
        try await other.value
        expect((try await coordinator.state()).generation == 3, "journal is reread after taking the shared lock")

        let processDirectory = directory.appendingPathComponent("process-lock", isDirectory: true)
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        child.arguments = ["--hold-native-lock", processDirectory.path]
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        let childReady = processDirectory.appendingPathComponent("child-ready")
        let childDeadline = Date().addingTimeInterval(3)
        while !FileManager.default.fileExists(atPath: childReady.path), child.isRunning, Date() < childDeadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        expect(FileManager.default.fileExists(atPath: childReady.path), "child process entered the locked operation")
        let processCoordinator = NativeSyncCoordinator(directory: processDirectory)
        let crossProcessReset = Task {
            try await processCoordinator.reset(generation: 1) {
                try Data().write(to: processDirectory.appendingPathComponent("parent-reset"))
            }
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        expect(!FileManager.default.fileExists(atPath: processDirectory.appendingPathComponent("parent-reset").path),
               "reset waits for an operation in a separate native process")
        try Data().write(to: processDirectory.appendingPathComponent("child-release"))
        try await crossProcessReset.value
        child.waitUntilExit()
        expect(child.terminationStatus == 0, "child native operation completed successfully")
        expect((try await processCoordinator.state()).generation == 1, "cross-process reset persisted its generation")

        let throttle = CKError(.requestRateLimited, userInfo: [CKErrorRetryAfterKey: 18.0])
        expect(SafariWebExtensionHandler.retryAfter(throttle) == 18, "CloudKit retry delay survives the bridge")
        let partial = CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: ["term": throttle]])
        expect(SafariWebExtensionHandler.retryAfter(partial) == 18, "partial batch failures retain server retry delays")
        expect(SafariWebExtensionHandler.retryAfter(CKError(.networkFailure)) == nil, "no fabricated retry delay")
        func profileItem(_ value: Any?) -> NSExtensionItem {
            let item = NSExtensionItem()
            if let value { item.userInfo = [SFExtensionProfileKey: value] }
            return item
        }
        let profileID = UUID()
        expect(SafariWebExtensionHandler.profileIdentifier(profileItem(profileID)) == profileID.uuidString,
               "a profile UUID is reported as its string")
        expect(SafariWebExtensionHandler.profileIdentifier(profileItem(profileID as NSUUID)) == profileID.uuidString,
               "an NSUUID profile is reported as its string")
        expect(SafariWebExtensionHandler.profileIdentifier(profileItem("abc")) == "abc",
               "a string profile is reported as-is")
        expect(SafariWebExtensionHandler.profileIdentifier(profileItem(nil)) == nil,
               "no profile key means no profile")
        expect(SafariWebExtensionHandler.profileIdentifier(profileItem(42))?.hasPrefix("type:") == true,
               "an unexpected value reports only its type")
        expect(SafariWebExtensionHandler.classify(CKError(.userDeletedZone)) == "zoneDeleted",
               "a zone the user deleted in Settings gets its own actionable code")
        expect(SafariWebExtensionHandler.classify(CKError(.accountTemporarilyUnavailable)) == "accountTemporary",
               "a transiently unavailable account is distinguished from a signed-out one")
        expect(SafariWebExtensionHandler.classify(CKError(.notAuthenticated)) == "account",
               "a signed-out account keeps its existing code")

        // Safari profiles share the extension container but not storage.local,
        // so each profile needs its own journal. Only a real UUID may select
        // one; anything else falls back to the default profile's journal.
        let profileText = "039325C4-2B41-4B13-AD09-DC064D94ABD2"
        let knownProfile = UUID(uuidString: profileText)!
        let lowercaseProfile = SafariWebExtensionHandler.profileUUID(profileItem(profileText.lowercased()))
        expect(SafariWebExtensionHandler.profileUUID(profileItem(nil)) == nil, "no profile key selects the default profile")
        expect(SafariWebExtensionHandler.profileUUID(profileItem(knownProfile)) == knownProfile, "a UUID profile is used as-is")
        expect(SafariWebExtensionHandler.profileUUID(profileItem(knownProfile as NSUUID)) == knownProfile,
               "an NSUUID profile is bridged")
        expect(SafariWebExtensionHandler.profileUUID(profileItem(profileText)) == knownProfile, "a UUID string is parsed")
        expect(lowercaseProfile == knownProfile, "letter case does not create a second profile")
        for invalid: Any in ["type:Int", "../evil", "", " \(profileText)", "\(profileText)/..", 42] {
            expect(SafariWebExtensionHandler.profileUUID(profileItem(invalid)) == nil,
                   "a value that is not a UUID selects the default profile: \(invalid)")
        }

        // The default profile keeps the journal it always had (no migration);
        // other profiles get a directory named only by their canonical UUID.
        let profilesBase = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-profile-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: profilesBase) }
        let defaultJournal = NativeSyncCoordinator.journalDirectory(base: profilesBase, profile: nil)
        let profileJournal = NativeSyncCoordinator.journalDirectory(base: profilesBase, profile: knownProfile)
        expect(defaultJournal.path == profilesBase.appendingPathComponent("KanjiExtractorSync").path,
               "the default profile keeps the existing journal directory")
        expect(profileJournal.path == profilesBase.appendingPathComponent("KanjiExtractorSync/profiles/\(profileText)").path,
               "another profile's journal lives under profiles/<UUID>")
        expect(NativeSyncCoordinator.journalDirectory(base: profilesBase, profile: lowercaseProfile).path == profileJournal.path,
               "lowercase and uppercase forms of one UUID share a journal")
        expect(CloudKitSyncManager.zoneCreatedKey(for: nil) == "kanjiZoneCreated", "the default profile keeps its zone flag")
        expect(CloudKitSyncManager.zoneCreatedKey(for: knownProfile) == "kanjiZoneCreated.\(profileText)",
               "another profile has its own zone flag")
        expect(CloudKitSyncManager.zoneCreatedKey(for: lowercaseProfile) == "kanjiZoneCreated.\(profileText)",
               "the zone flag key uses the canonical UUID")

        // Converted from tests/repro-2026-09-22/native_profiles_repro.swift.
        // Profile A (the default) clears its history; profile B, still at
        // generation 0 with history, keeps syncing and later clears its own.
        let profileA = NativeSyncCoordinator(directory: defaultJournal)
        let profileB = NativeSyncCoordinator(directory: profileJournal)
        try await profileA.reset(generation: 1) { await trace.append("A deleted zone") }
        do {
            try await profileB.perform(generation: 0) { await trace.append("B push at generation 0") }
        } catch {
            expect(false, "another profile's reset must not fence this profile: \(error)")
        }
        expect((await trace.read()).contains("B push at generation 0"), "profile B syncs after profile A's reset")
        try await profileA.perform(generation: 1) { await trace.append("A push at generation 1") }
        try await profileB.reset(generation: 1) { await trace.append("B deleted zone") }
        expect((await trace.read()).contains("B deleted zone"),
               "profile B's first reset really runs instead of replaying profile A's")
        for journal in [defaultJournal, profileJournal] {
            let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: journal.appendingPathComponent("control.json"))) as? [String: Any]
            expect(saved?["generation"] as? Int == 1 && saved?["resetCompleted"] as? Bool == true,
                   "each profile records its reset in its own journal: \(journal.lastPathComponent)")
            expect(FileManager.default.fileExists(atPath: journal.appendingPathComponent("control.lock").path),
                   "each profile has its own lock file: \(journal.lastPathComponent)")
        }

        // Profiles do not wait for each other: B completes a whole operation
        // while A is suspended inside its own (a CloudKit await in production).
        let heldEntered = NativeTestSignal()
        let heldResume = NativeTestSignal()
        let heldByA = Task {
            try await profileA.perform(generation: 1) {
                await trace.append("A holds its journal")
                await heldEntered.signal()
                await heldResume.wait()
            }
        }
        await heldEntered.wait()
        let whileAHeld = Task {
            try await profileB.perform(generation: 1) { await trace.append("B ran while A held") }
        }
        let crossProfileDeadline = Date().addingTimeInterval(2)
        while !(await trace.read()).contains("B ran while A held"), Date() < crossProfileDeadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        expect((await trace.read()).contains("B ran while A held"), "an operation in one profile does not wait for another profile")
        await heldResume.signal()
        try await heldByA.value
        try await whileAHeld.value

        // End to end through beginRequest: every sync action must reach the
        // requesting profile's journal. The child process gets a temporary
        // home because the handler resolves journals from Application Support.
        let handlerHome = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-handler-home-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: handlerHome) }
        try FileManager.default.createDirectory(at: handlerHome, withIntermediateDirectories: true)
        let handlerChild = Process()
        handlerChild.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        handlerChild.arguments = ["--handler-profiles"]
        var handlerEnvironment = ProcessInfo.processInfo.environment
        handlerEnvironment["CFFIXED_USER_HOME"] = handlerHome.path
        handlerChild.environment = handlerEnvironment
        try handlerChild.run()
        // A hung request would otherwise hang the whole suite.
        let handlerDeadline = Date().addingTimeInterval(30)
        while handlerChild.isRunning, Date() < handlerDeadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        if handlerChild.isRunning { handlerChild.terminate() }
        handlerChild.waitUntilExit()
        expect(handlerChild.terminationStatus == 0, "the handler routes every sync action to the requesting profile")

        // isZoneGone backs deleteZone's reset path: a reset must treat a zone
        // the user deleted in Settings exactly like one already absent.
        expect(CloudKitSyncManager.isZoneGone(CKError(.zoneNotFound)), "zoneNotFound means the zone is gone")
        expect(CloudKitSyncManager.isZoneGone(CKError(.userDeletedZone)), "userDeletedZone means the zone is gone")
        expect(!CloudKitSyncManager.isZoneGone(CKError(.networkFailure)), "an unrelated CKError is not treated as zone-gone")
        let allGonePartial = CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: [
            "a": CKError(.zoneNotFound), "b": CKError(.userDeletedZone),
        ]])
        expect(CloudKitSyncManager.isZoneGone(allGonePartial), "a partial failure made only of zone-gone errors is zone-gone")
        let mixedPartial = CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: [
            "a": CKError(.zoneNotFound), "b": CKError(.networkFailure),
        ]])
        expect(!CloudKitSyncManager.isZoneGone(mixedPartial), "one non-zone-gone item keeps a partial failure from being treated as zone-gone")

        expect(SafariWebExtensionHandler.classify(SyncError.journalDamaged) == "journal",
               "a damaged journal gets its own actionable code")
        expect(SafariWebExtensionHandler.classify(SyncError.message("offline")) == "generic",
               "ordinary failures stay generic")
        expect(String(describing: SyncError.journalDamaged).contains("invalid native sync journal"),
               "log readers still recognize the journal failure")

        // Disabling sync must be able to drop a reset intent that cannot
        // succeed (iCloud unavailable), without moving the generation fence.
        let abandonDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-abandon-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: abandonDirectory) }
        let abandoning = NativeSyncCoordinator(directory: abandonDirectory)
        do {
            try await abandoning.reset(generation: 4) { throw SyncError.message("offline") }
            expect(false, "the abandon fixture needs a failed reset")
        } catch SyncError.message { expect(true, "abandon fixture left a reset intent behind") }
        expect((try await abandoning.state()).resetPending, "abandon fixture starts from a pending reset")
        do {
            _ = try await abandoning.abandonReset(generation: 3)
            expect(false, "an older request cannot abandon the current reset")
        } catch SyncError.staleGeneration(let expected) { expect(expected == 4, "stale abandon reports the current generation") }
        let abandonedPending = try await abandoning.abandonReset(generation: 4)
        expect(abandonedPending.generation == 4 && !abandonedPending.completed, "abandoning a pending reset reports it unfinished")
        let clearedFence = try await abandoning.state()
        expect(clearedFence.generation == 4 && !clearedFence.resetPending, "abandoning clears the pending fence")
        try await abandoning.perform(generation: 4) { await trace.append("push after abandon") }
        expect((await trace.read()).contains("push after abandon"), "writes resume once the reset intent is abandoned")
        do {
            try await abandoning.perform(generation: 3) { await trace.append("stale push after abandon") }
            expect(false, "abandoning must not rewind the generation")
        } catch SyncError.staleGeneration(let expected) { expect(expected == 4, "requests older than the abandoned reset stay rejected") }
        let abandonedIdle = try await abandoning.abandonReset(generation: 4)
        expect(abandonedIdle.generation == 4 && !abandonedIdle.completed, "abandoning without a reset intent changes nothing")
        let abandonedAhead = try await abandoning.abandonReset(generation: 9)
        expect(abandonedAhead.generation == 9 && !abandonedAhead.completed, "a newer abandoned generation is recorded")
        expect((try await abandoning.state()).generation == 9, "abandon fences a delayed reset")
        do {
            try await abandoning.reset(generation: 9) { await trace.append("late reset") }
            expect(false, "the delayed reset must be refused")
        } catch SyncError.invalidGeneration { expect(true, "the delayed reset was refused") }
        // A reset that did finish must still wipe the local history.
        try await abandoning.reset(generation: 10) { await trace.append("reset before abandon") }
        let abandonedCompleted = try await abandoning.abandonReset(generation: 10)
        expect(abandonedCompleted.generation == 10 && abandonedCompleted.completed, "a finished reset is reported as completed")
        let afterCompleted = try await abandoning.state()
        expect(afterCompleted.generation == 10 && !afterCompleted.resetPending, "abandoning a completed reset leaves the journal untouched")

        // An unreadable journal keeps failing closed everywhere except reset,
        // which rebuilds it so the user is not stuck retrying forever.
        let damagedDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-damaged-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: damagedDirectory) }
        try FileManager.default.createDirectory(at: damagedDirectory, withIntermediateDirectories: true)
        let damagedControl = damagedDirectory.appendingPathComponent("control.json")
        try Data("{not json".utf8).write(to: damagedControl)
        let damaged = NativeSyncCoordinator(directory: damagedDirectory)
        do {
            _ = try await damaged.state()
            expect(false, "a damaged journal has no reportable state")
        } catch SyncError.journalDamaged { expect(true, "state reports a damaged journal") }
        do {
            try await damaged.perform(generation: 0) { await trace.append("damaged push") }
            expect(false, "a damaged journal must not reopen generation zero")
        } catch SyncError.journalDamaged { expect(true, "reads and writes fail closed on a damaged journal") }
        do {
            _ = try await damaged.abandonReset(generation: 0)
            expect(false, "abandoning must not clear a damaged journal")
        } catch SyncError.journalDamaged { expect(true, "abandoning fails closed on a damaged journal") }
        expect(!(await trace.read()).contains("damaged push"), "nothing ran behind a damaged journal")
        do {
            try await damaged.reset(generation: 0) { await trace.append("invalid damaged reset") }
            expect(false, "invalid reconstruction must fail")
        } catch SyncError.invalidGeneration { expect(true, "invalid reconstruction failed") }
        expect((try? Data(contentsOf: damagedControl)) == Data("{not json".utf8),
               "failed reconstruction retains the original damaged journal")
        do {
            _ = try await damaged.state()
            expect(false, "failed reconstruction must not reopen generation zero")
        } catch SyncError.journalDamaged { expect(true, "failed reconstruction remains fenced") }
        let failedReplace = NativeSyncCoordinator(directory: damagedDirectory, beforeJournalReplace: {
            throw SyncError.message("simulated journal replacement failure")
        })
        do {
            try await failedReplace.reset(generation: 7) { await trace.append("failed replacement ran") }
            expect(false, "failed atomic replacement must propagate")
        } catch SyncError.message { expect(true, "failed atomic replacement propagated") }
        expect((try? Data(contentsOf: damagedControl)) == Data("{not json".utf8),
               "replacement failure preserves the original damaged journal")
        do {
            _ = try await failedReplace.state()
            expect(false, "replacement failure must not reopen generation zero")
        } catch SyncError.journalDamaged { expect(true, "replacement failure remains fenced") }
        try await damaged.reset(generation: 7) { await trace.append("damaged reset ran") }
        expect((await trace.read()).contains("damaged reset ran"), "reset rebuilds the journal and deletes the zone")
        let quarantined = damagedDirectory.appendingPathComponent("control.json.damaged")
        expect(FileManager.default.fileExists(atPath: quarantined.path), "the damaged journal is kept beside the rebuilt one")
        let rebuilt = try JSONSerialization.jsonObject(with: Data(contentsOf: damagedControl)) as? [String: Any]
        expect(rebuilt?["generation"] as? Int == 7, "the rebuilt journal adopts the requested generation")
        expect(rebuilt?["resetCompleted"] as? Bool == true, "the rebuilt journal records the completed reset")
        expect(rebuilt?["resetPending"] as? Bool == false, "the rebuilt journal clears the reset intent")
        expect((try await damaged.state()).generation == 7, "operations resume after the journal is rebuilt")
        // A second failure must not be blocked by the file kept from the first.
        try Data("{not json".utf8).write(to: damagedControl)
        try await damaged.reset(generation: 8) { await trace.append("second damaged reset ran") }
        expect((try await damaged.state()).generation == 8, "quarantining replaces a previously damaged journal")

        try Data("damaged journal".utf8).write(to: directory.appendingPathComponent("control.json"))
        do {
            _ = try await coordinator.state()
            expect(false, "corrupted journal must not reopen generation zero")
        } catch { expect(true, "corrupted journal fails closed") }

        // Safari on macOS has no downloads API, so the handler writes exports
        // itself. Only ever into a temporary folder here, never the real Downloads.
        let downloads = FileManager.default.temporaryDirectory
            .appendingPathComponent("kanji-native-download-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: downloads) }
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        expect(NativeDownloadWriter.sanitizedName("../../etc/x.txt") == "x.txt", "only the last path component is kept")
        expect(NativeDownloadWriter.sanitizedName("a:b/c.txt") == "c.txt", "a colon before a separator is dropped with the directory")
        expect(NativeDownloadWriter.sanitizedName("a:b\\c.txt") == "abc.txt", "colons and backslashes are removed")
        expect(NativeDownloadWriter.sanitizedName("..\\..\\x.txt") == "x.txt", "backslash traversal leaves no leading dots")
        expect(NativeDownloadWriter.sanitizedName(".hidden") == "hidden.txt", "a hidden name is made visible and gets .txt")
        expect(NativeDownloadWriter.sanitizedName("a\nb\u{7}\u{202E}c.txt") == "abc.txt", "control and bidi format characters are removed")
        expect(NativeDownloadWriter.sanitizedName("notes") == "notes.txt", "a missing extension becomes .txt")
        expect(NativeDownloadWriter.sanitizedName("run.command") == "run.command.txt", "any other extension is neutralized")
        expect(NativeDownloadWriter.sanitizedName("LIST.TXT") == "LIST.TXT", ".txt is kept in any letter case")
        expect(NativeDownloadWriter.sanitizedName("kanji_history_2026-09-23.json") == "kanji_history_2026-09-23.json",
               "history exports keep .json so the import picker still accepts them")
        expect(NativeDownloadWriter.sanitizedName("  name. ") == "name.txt", "surrounding spaces and trailing dots are trimmed")
        for empty in ["", "   ", "/", "../..", "...", "\u{0}\u{7}", "dir/.."] {
            expect(NativeDownloadWriter.sanitizedName(empty) == nil, "an empty name is rejected: \(empty.debugDescription)")
        }
        expect(NativeDownloadWriter.sanitizedName(String(repeating: "漢", count: 100) + ".txt")
               == String(repeating: "漢", count: 65) + ".txt",
               "a long name is cut to 200 UTF-8 bytes on a character boundary, keeping .txt")
        let longASCII = NativeDownloadWriter.sanitizedName(String(repeating: "a", count: 300))
        expect(longASCII?.utf8.count == NativeDownloadWriter.maximumNameBytes && longASCII?.hasSuffix(".txt") == true,
               "an added .txt counts toward the 200-byte cap")

        let exported = "Source: https://example.jp/\n日本語\n𠮷野家\n"
        let first = NativeDownloadWriter.save(filename: "../kanji_example.txt", text: exported, in: downloads)
        expect(first["ok"] as? Bool == true && first["filename"] as? String == "kanji_example.txt",
               "a valid export is written under its sanitized name")
        let firstFile = downloads.appendingPathComponent("kanji_example.txt")
        expect(try Data(contentsOf: firstFile) == Data(exported.utf8), "the file holds exactly the UTF-8 bytes sent")
        expect(!FileManager.default.fileExists(atPath: downloads.deletingLastPathComponent()
            .appendingPathComponent("kanji_example.txt").path), "traversal cannot write outside the directory")
        let second = NativeDownloadWriter.save(filename: "kanji_example.txt", text: "second", in: downloads)
        expect(second["ok"] as? Bool == true && second["filename"] as? String == "kanji_example (2).txt",
               "a name collision picks the next free name and reports it")
        expect(try Data(contentsOf: firstFile) == Data(exported.utf8), "an existing file is never overwritten")
        expect(try String(contentsOf: downloads.appendingPathComponent("kanji_example (2).txt"), encoding: .utf8) == "second",
               "the renamed file holds the new contents")
        let third = NativeDownloadWriter.save(filename: "kanji_example.txt", text: "third", in: downloads)
        expect(third["filename"] as? String == "kanji_example (3).txt", "collisions keep counting")
        let limit = NativeDownloadWriter.save(filename: "limit.txt",
                                              text: String(repeating: "a", count: NativeDownloadWriter.maximumTextBytes), in: downloads)
        expect(limit["ok"] as? Bool == true, "text of exactly 5 MB is accepted")

        let beforeRejections = try FileManager.default.contentsOfDirectory(atPath: downloads.path).sorted()
        let rejected: [(Any?, Any?, String)] = [
            ("big.txt", String(repeating: "a", count: NativeDownloadWriter.maximumTextBytes + 1), "text over 5 MB"),
            ("wide.txt", String(repeating: "漢", count: NativeDownloadWriter.maximumTextBytes / 3 + 1), "text over 5 MB of UTF-8"),
            ("", "x", "empty name"), ("...", "x", "name of dots"), (42, "x", "nonstring name"),
            ("ok.txt", nil, "missing text"), ("ok.txt", 7, "nonstring text"),
        ]
        for (filename, text, label) in rejected {
            let reply = NativeDownloadWriter.save(filename: filename, text: text, in: downloads)
            expect(reply["ok"] as? Bool == false && reply["code"] as? String == "invalidFile", "rejected as invalidFile: \(label)")
        }
        expect(try FileManager.default.contentsOfDirectory(atPath: downloads.path).sorted() == beforeRejections,
               "rejected requests write nothing")

        let missing = NativeDownloadWriter.save(filename: "x.txt", text: "x",
                                                in: downloads.appendingPathComponent("missing", isDirectory: true))
        expect(missing["ok"] as? Bool == false && missing["code"] as? String == "file", "a write error is reported as a file failure")
        expect(NativeDownloadWriter.save(filename: "x.txt", text: "x", in: nil)["code"] as? String == "file",
               "an unavailable Downloads folder is a file failure")
        let crowded = downloads.appendingPathComponent("crowded", isDirectory: true)
        try FileManager.default.createDirectory(at: crowded, withIntermediateDirectories: true)
        for index in 1...99 {
            try Data("kept".utf8).write(to: crowded.appendingPathComponent(index == 1 ? "full.txt" : "full (\(index)).txt"))
        }
        let exhausted = NativeDownloadWriter.save(filename: "full.txt", text: "new", in: crowded)
        expect(exhausted["ok"] as? Bool == false && exhausted["code"] as? String == "file", "running out of free names is a file failure")
        expect(try String(contentsOf: crowded.appendingPathComponent("full (99).txt"), encoding: .utf8) == "kept",
               "nothing is overwritten when names run out")

        print("PASS: \(checks) native sync checks (offline)")
    }

    // Child process: drive the real handler for every sync action, with and
    // without a Safari profile. Refuses to run unless Application Support lies
    // inside the temporary home the parent passed in CFFIXED_USER_HOME, so the
    // user's own journal is never touched. No request reaches CloudKit: each
    // names a generation the journals reject first, so a request routed to the
    // wrong profile shows up as that profile's generation, not as a network
    // call. Exits 1 on the first failed check, 2 when the home is not isolated.
    static func handlerProfileCases() async throws {
        var checks = 0
        func expect(_ condition: Bool, _ message: String) {
            guard condition else {
                print("FAIL (handler child): \(message)")
                exit(1)
            }
            checks += 1
        }
        let fakeHome = ProcessInfo.processInfo.environment["CFFIXED_USER_HOME"] ?? ""
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let resolved = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
        guard !fakeHome.isEmpty, resolved(NSHomeDirectory()) == resolved(fakeHome),
              support.path.hasPrefix(NSHomeDirectory() + "/") else {
            print("FAIL (handler child): refusing to touch \(support.path) without a temporary CFFIXED_USER_HOME")
            exit(2)
        }

        // Literal paths on purpose: this pins the on-disk layout independently
        // of NativeSyncCoordinator.journalDirectory. The default journal sits at
        // generation 5 after a completed reset, the profile's at 3 with a reset
        // still pending, so every reply identifies the journal that served it.
        let profileText = "039325C4-2B41-4B13-AD09-DC064D94ABD2"
        let profile = UUID(uuidString: profileText)!
        let root = support.appendingPathComponent("KanjiExtractorSync", isDirectory: true)
        let profileRoot = root.appendingPathComponent("profiles/\(profileText)", isDirectory: true)
        let defaultControl = root.appendingPathComponent("control.json")
        try FileManager.default.createDirectory(at: profileRoot, withIntermediateDirectories: true)
        try Data(#"{"generation":5,"resetPending":false,"resetCompleted":true}"#.utf8).write(to: defaultControl)
        try Data(#"{"generation":3,"resetPending":true,"resetCompleted":false}"#.utf8)
            .write(to: profileRoot.appendingPathComponent("control.json"))
        let defaultBytes = try Data(contentsOf: defaultControl)

        // One request through beginRequest; `profile` nil omits the key.
        func send(_ message: [String: Any], profile: Any? = nil) async -> [String: Any] {
            let data = await withCheckedContinuation { (done: CheckedContinuation<Data, Never>) in
                SafariWebExtensionHandler().beginRequest(with: NativeTestContext(message: message, profile: profile) {
                    done.resume(returning: $0)
                })
            }
            return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any]) ?? [:]
        }
        func fencedBy(_ reply: [String: Any], _ generation: Int) -> Bool {
            reply["ok"] as? Bool == false && reply["code"] as? String == "staleGeneration"
                && reply["currentGeneration"] as? Int == generation
        }

        var reply = await send(["action": "syncState"])
        expect(reply["ok"] as? Bool == true && reply["generation"] as? Int == 5 && reply["resetPending"] as? Bool == false,
               "the default profile reads the journal at the existing path")
        expect(reply["profile"] is NSNull, "the diagnostic reports a missing profile key as null")
        reply = await send(["action": "syncState"], profile: profileText.lowercased())
        expect(reply["ok"] as? Bool == true && reply["generation"] as? Int == 3 && reply["resetPending"] as? Bool == true,
               "a profile reads its own journal whatever the letter case")
        expect(reply["profile"] as? String == profileText.lowercased(), "the diagnostic still reports what Safari sent")
        reply = await send(["action": "syncState"], profile: profile)
        expect(reply["generation"] as? Int == 3, "a UUID profile value selects the same journal")
        reply = await send(["action": "syncState"], profile: "../evil")
        expect(reply["generation"] as? Int == 5, "an invalid profile value falls back to the default journal")

        for action in ["pull", "push"] {
            let request: [String: Any] = action == "push"
                ? ["action": action, "generation": NSNumber(value: 0), "terms": []]
                : ["action": action, "generation": NSNumber(value: 0)]
            expect(fencedBy(await send(request, profile: profile), 3),
                   "\(action) is fenced by the profile's journal")
            expect(fencedBy(await send(request), 5),
                   "\(action) without a profile is fenced by the default journal")
        }
        expect(fencedBy(await send(["action": "reset", "generation": NSNumber(value: 1)], profile: profile), 3),
               "reset is fenced by the profile's journal")
        expect(fencedBy(await send(["action": "reset", "generation": NSNumber(value: 1)]), 5),
               "reset without a profile is fenced by the default journal")
        reply = await send(["action": "abandonReset", "generation": NSNumber(value: 3)], profile: profile)
        expect(reply["ok"] as? Bool == true && reply["generation"] as? Int == 3 && reply["completed"] as? Bool == false,
               "abandonReset clears the profile's own pending reset")
        reply = await send(["action": "syncState"], profile: profile)
        expect(reply["generation"] as? Int == 3 && reply["resetPending"] as? Bool == false,
               "the profile's journal records the abandoned reset")
        reply = await send(["action": "unknownNativeAction"])
        expect(reply["ok"] as? Bool == false && reply["code"] as? String == "protocol",
               "unknown actions return a protocol error")
        for malformed: Any in ["bad", ["bad"], [["term": 42]]] {
            reply = await send(["action": "push", "terms": malformed])
            expect(reply["ok"] as? Bool == false && reply["code"] as? String == "protocol",
                   "malformed terms return a protocol error")
        }
        reply = await send(["action": "push", "terms": [["term": String(repeating: "語", count: 65)]]])
        expect(reply["ok"] as? Bool == false && reply["code"] as? String == "protocol",
               "native decoding rejects overlong terms")
        expect((try? Data(contentsOf: defaultControl)) == defaultBytes, "no profile request changed the default journal")
        print("PASS: \(checks) handler profile checks (child process)")
    }

    // Replays the audited arrival order against the real handler with an
    // isolated home; the second reply must observe the first request's write.
    static func handlerOrderCases() throws {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let control = support.appendingPathComponent("KanjiExtractorSync/control.json")
        var inversions = 0
        for _ in 0..<5000 {
            try Data(#"{"generation":5,"resetPending":true,"resetCompleted":false}"#.utf8)
                .write(to: control, options: .atomic)
            let group = DispatchGroup()
            let second = NativeTestReplyBox()
            group.enter()
            SafariWebExtensionHandler().beginRequest(with: NativeTestContext(
                message: ["action": "abandonReset", "generation": 5], profile: nil) { _ in group.leave() })
            group.enter()
            SafariWebExtensionHandler().beginRequest(with: NativeTestContext(
                message: ["action": "syncState"], profile: nil) { data in second.set(data); group.leave() })
            group.wait()
            if second.read()["resetPending"] as? Bool == true { inversions += 1 }
        }
        guard inversions == 0 else {
            print("FAIL (handler child): \(inversions)/5000 requests inverted")
            exit(1)
        }
        print("PASS: 0/5000 handler order inversions (child process)")
    }
}
