//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Bridges native Safari calls to the Web Extension.
//
//  The popup shares files itself on iOS (Web Share). Safari on macOS has no
//  downloads API, so "saveDownload" writes the export into Downloads here and
//  reports the name actually used. This handler also routes the cross-device
//  sync actions to CloudKitSyncManager: "pull", "push", "reset", "abandonReset"
//  and the read-only "syncState", each for the Safari profile that sent it.
//

import SafariServices
import CloudKit
import os.log

// Carries one Safari request across the queue's Task boundary. The extension
// context and Foundation message are immutable after synchronous receipt.
private final class NativeQueuedRequest: @unchecked Sendable {
    let action: String
    let message: [String: Any]?
    let item: NSExtensionItem?
    let context: NSExtensionContext

    // Keeps the original context and decoded action for exactly one reply.
    init(action: String, message: [String: Any]?, item: NSExtensionItem?, context: NSExtensionContext) {
        self.action = action
        self.message = message
        self.item = item
        self.context = context
    }
}

// Assigns arrival sequence numbers before any Task can be scheduled. A single
// consumer awaits each full request, including its native journal operation.
private final class NativeRequestDispatcher: @unchecked Sendable {
    private let lock = NSLock()
    private var nextSequence = 0
    private var lastServedSequence = -1
    private var pending: [(sequence: Int, request: NativeQueuedRequest)] = []
    private var running = false

    // Enqueues synchronously and starts the sole consumer if it was idle.
    func enqueue(_ request: NativeQueuedRequest) {
        lock.lock()
        let sequence = nextSequence
        nextSequence += 1
        pending.append((sequence, request))
        let shouldStart = !running
        if shouldStart { running = true }
        lock.unlock()
        if shouldStart { Task { await drain() } }
    }

    // Pops under the same lock that assigns sequence numbers, preserving FIFO.
    private func takeNext() -> NativeQueuedRequest? {
        lock.lock()
        defer { lock.unlock() }
        guard !pending.isEmpty else { running = false; return nil }
        let next = pending.removeFirst()
        precondition(next.sequence == lastServedSequence + 1)
        lastServedSequence = next.sequence
        return next.request
    }

    // Serves each request to completion before allowing the next to run.
    private func drain() async {
        while let request = takeNext() {
            await SafariWebExtensionHandler().process(request)
        }
    }
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let dispatcher = NativeRequestDispatcher()

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let dict = message as? [String: Any]
        let action = dict?["action"] as? String ?? ""
        Self.dispatcher.enqueue(NativeQueuedRequest(action: action, message: dict,
                                                    item: request, context: context))
    }

    // Routes one already sequenced request and completes its original context.
    fileprivate func process(_ request: NativeQueuedRequest) async {
        let action = request.action
        let dict = request.message
        let context = request.context
        // Log only the action — never the payload, which contains the user's
        // extracted vocabulary (privacy: avoid writing it to the unified log).
        os_log(.debug, "Received web extension message: action=%{public}@", action)

        switch action {
        case "pull", "push", "reset", "syncState", "abandonReset":
            await handleSync(action: action, message: dict, profile: Self.profileUUID(request.item),
                             reportedProfile: Self.profileIdentifier(request.item), context: context)

        case "saveDownload":
            #if os(macOS)
            let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            Self.completeRequest(context: context, with: NativeDownloadWriter.save(
                filename: dict?["filename"], text: dict?["text"], in: downloads))
            #else
            // iOS shares through the Share Sheet; the popup falls back on this code.
            Self.completeRequest(context: context, with: [
                "ok": false,
                "code": "unsupported",
                "error": "Saving to Downloads is not available on this device."
            ])
            #endif

        case "share":
            Self.completeRequest(context: context, with: [
                "ok": false,
                "error": "Native sharing is not available from the Safari extension."
            ])

        default:
            Self.completeRequest(context: context, with: [
                "ok": false, "code": "protocol", "error": "Unknown native action."
            ])
        }
    }

    // Runs one sync action and completes the request with its reply. `profile`
    // (nil = default profile) selects the journal and zone flag every manager
    // call uses; `reportedProfile` is what Safari sent, echoed by syncState for
    // on-device diagnosis only, and never selects anything.
    private func handleSync(action: String, message: [String: Any]?, profile: UUID?,
                            reportedProfile: String?, context: NSExtensionContext) async {
        var payload: [String: Any]
        do {
            // Legacy reads/writes belong to generation 0. A destructive
            // reset must always identify its generation so retries cannot
            // accidentally delete terms added after an earlier reset — and
            // abandoning that reset addresses the same fence.
            let identified = action == "reset" || action == "abandonReset"
            let generation = try NativeSyncGeneration.parse(message?["generation"], allowLegacy: !identified)
            let manager = CloudKitSyncManager.shared
            switch action {
            case "syncState":
                let state = try await manager.syncState(profile: profile)
                payload = ["ok": true, "generation": state.generation, "resetPending": state.resetPending]
                // Diagnostic: which Safari profile sent this (nil = key absent).
                payload["profile"] = reportedProfile ?? NSNull()
            case "pull":
                let since = message?["since"] as? String
                let page = try await manager.pull(sinceBase64: since, generation: generation, profile: profile)
                payload = [
                    "ok": true,
                    "records": page.terms.map { $0.asMessage },
                    "deletions": page.deletions,
                    // "" (not NSNull) when absent: Optional-in-Any bridges
                    // to NSNull, which isn't a plist type — fragile through
                    // the message serializer. JS treats "" as no-token.
                    "token": page.token ?? "",
                    "more": page.more,
                    "reset": page.reset,
                    "generation": generation,
                ]
            case "push":
                guard let terms = message?["terms"] as? [[String: Any]],
                      terms.allSatisfy({ item in
                          guard let term = item["term"] as? String else { return false }
                          return !term.isEmpty && term.unicodeScalars.count <= NativeTermField.maximumCodePoints
                      }) else { throw SyncError.protocolViolation }
                let confirmed = try await manager.push(terms, generation: generation, profile: profile)
                payload = ["ok": true, "generation": generation, "confirmed": confirmed]
            case "reset":
                try await manager.reset(generation: generation, profile: profile)
                payload = ["ok": true, "generation": generation]
            case "abandonReset":
                // The journal keeps its own generation here, so report that
                // one rather than the requested one.
                let outcome = try await manager.abandonReset(generation: generation, profile: profile)
                payload = ["ok": true, "generation": outcome.generation, "completed": outcome.completed]
            default:
                payload = ["ok": false, "code": "protocol", "error": "Unknown native action."]
            }
        } catch {
            // CKError descriptions may contain records and terms: log only
            // the action and classified code, never a vocabulary payload.
            os_log(.error, "Sync action %{public}@ failed: %{public}@", action, Self.classify(error))
            payload = ["ok": false, "error": "sync failed", "code": Self.classify(error)]
            if case SyncError.protocolViolation = error {
                payload["error"] = "Invalid native sync terms."
            }
            if case SyncError.staleGeneration(let expected) = error {
                payload["generation"] = expected
                payload["currentGeneration"] = expected
            }
            if case SyncError.resetPending(let expected) = error {
                payload["generation"] = expected
                payload["currentGeneration"] = expected
            }
            if let retryAfter = Self.retryAfter(error) { payload["retryAfter"] = retryAfter }
        }
        Self.completeRequest(context: context, with: payload)
    }

    // The Safari profile a request came from (Safari 17+ / iOS 17+): a UUID
    // string, nil when the key is absent, or "type:<name>" for an unexpected
    // value, so an on-device check shows what Safari actually sends. Diagnostic
    // only: profileUUID decides which journal a request uses.
    static func profileIdentifier(_ item: NSExtensionItem?) -> String? {
        guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
        guard let value = item?.userInfo?[SFExtensionProfileKey] else { return nil }
        if let uuid = value as? UUID { return uuid.uuidString }
        if let uuid = value as? NSUUID { return uuid.uuidString }
        if let string = value as? String { return string }
        return "type:\(type(of: value))"
    }

    // The Safari profile whose sync journal and zone flag a request uses.
    // nil means the default profile: Safari sends no profile key for it (and
    // older systems have no profiles). A UUID, NSUUID or UUID string yields that
    // UUID; a string goes through UUID(uuidString:), so letter case cannot turn
    // one profile into two. Any other value also maps to the default profile,
    // with a warning that names no value: it is never used to build a path.
    static func profileUUID(_ item: NSExtensionItem?) -> UUID? {
        guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
        guard let value = item?.userInfo?[SFExtensionProfileKey] else { return nil }
        if let uuid = value as? UUID { return uuid }
        if let uuid = value as? NSUUID { return uuid as UUID }
        if let string = value as? String, let uuid = UUID(uuidString: string) { return uuid }
        os_log(.error, "Safari profile identifier is not a UUID; using the default profile's sync journal")
        return nil
    }

    // Map a CloudKit failure to a short, actionable code the popup localizes.
    static func classify(_ error: Error) -> String {
        if let sync = error as? SyncError {
            switch sync {
            case .invalidGeneration: return "invalidGeneration"
            case .staleGeneration: return "staleGeneration"
            case .resetPending: return "resetPending"
            // Retrying cannot fix an unreadable journal: the popup tells the
            // user to export the history and then clear it.
            case .journalDamaged: return "journal"
            case .protocolViolation: return "protocol"
            case .message: return "generic"
            }
        }
        guard let ck = error as? CKError else { return "generic" }
        switch ck.code {
        case .notAuthenticated:
            return "account"
        case .accountTemporarilyUnavailable:
            return "accountTemporary"   // transient; retryable, unlike .notAuthenticated
        case .networkUnavailable, .networkFailure, .serviceUnavailable, .requestRateLimited:
            return "network"
        case .quotaExceeded:
            return "quota"
        case .invalidArguments, .serverRejectedRequest, .badContainer, .missingEntitlement:
            return "schema"   // e.g. record type not deployed to the Production schema
        case .changeTokenExpired:
            return "expiredToken"   // pull recovers internally; defensive if surfaced
        case .zoneNotFound:
            return "zoneGone"
        case .userDeletedZone:
            return "zoneDeleted"   // user deleted this app's iCloud data in Settings
        default:
            return "generic"
        }
    }

    // A batch can fail partially. Respect the longest server-requested delay
    // among its records, instead of immediately retrying a throttled request.
    static func retryAfter(_ error: Error) -> Double? {
        guard let ck = error as? CKError else { return nil }
        var delays: [Double] = []
        if let delay = ck.retryAfterSeconds, delay.isFinite, delay > 0 { delays.append(delay) }
        if let failures = ck.partialErrorsByItemID {
            delays.append(contentsOf: failures.values.compactMap { retryAfter($0) })
        }
        return delays.max()
    }

    private static func completeRequest(context: NSExtensionContext, with payload: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: payload]
        } else {
            response.userInfo = ["message": payload]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}

// Writes an export into a folder (Downloads in production; the sandbox grants
// it through com.apple.security.files.downloads.read-write) and reports the
// name it actually wrote. An existing file is never replaced. The folder is a
// parameter so the offline tests write into a temporary directory.
enum NativeDownloadWriter {
    static let maximumTextBytes = 5 * 1024 * 1024
    static let maximumNameBytes = 200
    // The popup's own exports: word lists, and history backups that the import
    // picker only accepts as .json. Anything else gets ".txt" appended.
    private static let keptExtensions = [".txt", ".json"]
    private static let removed = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/:\\"))

    static func save(filename: Any?, text: Any?, in directory: URL?) -> [String: Any] {
        guard let raw = filename as? String, let name = sanitizedName(raw),
              let text = text as? String, text.utf8.count <= maximumTextBytes else {
            return ["ok": false, "code": "invalidFile", "error": "The file name or contents are invalid."]
        }
        let failure: [String: Any] = ["ok": false, "code": "file", "error": "The file could not be written to Downloads."]
        guard let directory else { return failure }
        let data = Data(text.utf8)
        let extLength = keptExtension(of: name)?.count ?? 0
        let stem = name.dropLast(extLength), ext = name.suffix(extLength)
        for attempt in 1...99 {
            let candidate = attempt == 1 ? name : "\(stem) (\(attempt))\(ext)"
            do {
                // Fails instead of replacing a file that already has this name.
                try data.write(to: directory.appendingPathComponent(candidate, isDirectory: false), options: .withoutOverwriting)
                return ["ok": true, "filename": candidate]
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                continue
            } catch {
                // The error description contains the path: log its code only.
                os_log(.error, "saveDownload failed: code=%{public}ld", (error as NSError).code)
                return failure
            }
        }
        return failure
    }

    // One visible file name inside the target folder, or nil when nothing usable is left.
    static func sanitizedName(_ raw: String) -> String? {
        let last = raw.split(separator: "/").last ?? ""
        var name = Substring(String(last.unicodeScalars.filter { !removed.contains($0) }))
        while let head = name.first, head == "." || head.isWhitespace { name.removeFirst() }
        while let tail = name.last, tail == "." || tail.isWhitespace { name.removeLast() }
        guard !name.isEmpty else { return nil }
        let kept = keptExtension(of: name)
        let ext = kept.map { String(name.suffix($0.count)) } ?? ".txt"
        var stem = name.dropLast(kept?.count ?? 0)
        // Drop whole characters so the cut never splits a UTF-8 sequence.
        while !stem.isEmpty, stem.utf8.count + ext.utf8.count > maximumNameBytes { stem.removeLast() }
        return stem.isEmpty ? nil : String(stem) + ext
    }

    private static func keptExtension<S: StringProtocol>(of name: S) -> String? {
        let lowered = name.lowercased()
        return keptExtensions.first { lowered.hasSuffix($0) && lowered.count > $0.count }
    }
}
