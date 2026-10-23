import Foundation
import CloudKit
import SafariServices

// ---------- Repro 1: gate stress (mutual exclusion, liveness, errors, cancellation) ----------
final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var inside = 0
    private(set) var maxInside = 0
    private(set) var ran = 0
    func enter() { lock.lock(); inside += 1; maxInside = max(maxInside, inside); ran += 1; lock.unlock() }
    func leave() { lock.lock(); inside -= 1; lock.unlock() }
}

func gateStress(_ root: URL) async {
    let coordinator = NativeSyncCoordinator(directory: root.appendingPathComponent("gate"))
    let counter = Counter()
    var tasks: [Task<String, Never>] = []
    for i in 0..<300 {
        let t = Task { () -> String in
            do {
                try await coordinator.perform(generation: 0) {
                    counter.enter()
                    defer { counter.leave() }
                    try await Task.sleep(nanoseconds: UInt64.random(in: 0...300_000))
                    if i % 7 == 0 { throw SyncError.message("boom") }
                }
                return "ok"
            } catch is CancellationError { return "cancelled" }
            catch { return "error" }
        }
        tasks.append(t)
        if i % 11 == 0 { t.cancel() }
    }
    var tally: [String: Int] = [:]
    for t in tasks { tally[await t.value, default: 0] += 1 }
    print("REPRO1 gate: maxInside=\(counter.maxInside) ran=\(counter.ran) results=\(tally.sorted { $0.key < $1.key })")
}

// ---------- Repro 2: request order is not preserved before the gate ----------
final class FakeContext: NSExtensionContext, @unchecked Sendable {
    let items: [Any]
    let onComplete: ([String: Any]) -> Void
    init(message: [String: Any], onComplete: @escaping ([String: Any]) -> Void) {
        let item = NSExtensionItem()
        item.userInfo = [SFExtensionMessageKey: message]
        self.items = [item]
        self.onComplete = onComplete
        super.init()
    }
    override var inputItems: [Any] { items }
    override func completeRequest(returningItems items: [Any]?, completionHandler: ((Bool) -> Void)? = nil) {
        let item = items?.first as? NSExtensionItem
        onComplete((item?.userInfo?[SFExtensionMessageKey] as? [String: Any]) ?? [:])
    }
}

func handlerOrdering(trials: Int) {
    let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("KanjiExtractorSync", isDirectory: true)
    // The real handler uses the default journal path: run only with a fake home
    // (CFFIXED_USER_HOME=<temp dir>) so the user's journal is never touched.
    let fakeHome = ProcessInfo.processInfo.environment["CFFIXED_USER_HOME"] ?? ""
    let resolve = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
    guard !fakeHome.isEmpty, resolve(NSHomeDirectory()) == resolve(fakeHome),
          dir.path.hasPrefix(NSHomeDirectory() + "/") else {
        print("refusing to touch \(dir.path): set CFFIXED_USER_HOME to a temporary directory")
        exit(2)
    }
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let control = dir.appendingPathComponent("control.json")
    var inversions = 0, abandonSawNothing = 0
    let delivery = DispatchQueue(label: "delivery")   // requests delivered one after another
    for _ in 0..<trials {
        try! Data(#"{"generation":5,"resetPending":true,"resetCompleted":false}"#.utf8).write(to: control, options: .atomic)
        let group = DispatchGroup()
        var first: [String: Any] = [:], second: [String: Any] = [:]
        group.enter(); group.enter()
        delivery.sync {
            // 1st message: abandon the pending reset. 2nd message: read state.
            SafariWebExtensionHandler().beginRequest(with: FakeContext(message: ["action": "abandonReset", "generation": 5]) { first = $0; group.leave() })
            SafariWebExtensionHandler().beginRequest(with: FakeContext(message: ["action": "syncState"]) { second = $0; group.leave() })
        }
        group.wait()
        // If the 2nd request ran first it still sees the reset intent the 1st one clears.
        if second["resetPending"] as? Bool == true { inversions += 1 }
        if first["completed"] as? Bool == nil { abandonSawNothing += 1 }
    }
    print("REPRO2 handler ordering: \(inversions)/\(trials) trials executed message #2 before message #1 (bad abandon replies: \(abandonSawNothing))")
}

@main
struct Repro {
    static func main() async {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        await gateStress(root)
        let trials = Int(CommandLine.arguments[2]) ?? 2000
        await Task.detached { handlerOrdering(trials: trials) }.value
    }
}
