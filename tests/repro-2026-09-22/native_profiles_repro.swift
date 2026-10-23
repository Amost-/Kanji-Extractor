import Foundation
// Two Safari profiles = two JS states, ONE extension container = one journal.
@main struct Profiles {
    static func main() async throws {
        let dir = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let native = NativeSyncCoordinator(directory: dir)
        var log: [String] = []
        // Profile A: Clear History with sync on -> JS generation 0 -> 1 -> reset(1).
        try await native.reset(generation: 1) { }
        log.append("A reset(1) deleted zone")
        // Profile B (still generation 0, has history): its next push/pull.
        do { try await native.perform(generation: 0) { }; log.append("B push(0) accepted") }
        catch { log.append("B push(0) -> \(error)") }
        // Profile A syncs new terms at generation 1.
        try await native.perform(generation: 1) { }
        log.append("A push(1) uploaded new terms")
        // Profile B presses Clear History: nativeGeneration unknown (0) -> nextGeneration(0,0) = 1 -> reset(1).
        var zoneDeleted = false
        try await native.reset(generation: 1) { zoneDeleted = true }
        log.append("B reset(1) returned ok, zone deleted: \(zoneDeleted)")
        print(log.joined(separator: "\n"))
    }
}
