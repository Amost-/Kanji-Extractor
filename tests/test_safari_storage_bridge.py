#!/usr/bin/env python3
"""Exercise Foundation-to-JavaScriptCore JSON conversion entirely offline.

Usage: python3 tests/test_safari_storage_bridge.py
Requires macOS and the Swift compiler. DEVELOPER_DIR can select an Xcode.

Safari's storage bridge can expose shared references for separate empty JSON
containers. Report that behavior without requiring future OS versions to retain
it, and verify that a JavaScript JSON roundtrip prevents cross-map mutations.
This tests the platform bridge and mitigation, not Safari's storage API itself.
No extension storage, browser session, or iCloud account is accessed.
"""

import os
from pathlib import Path
import subprocess
import tempfile


SWIFT_CASES = r'''
import Foundation
import JavaScriptCore

let context = JSContext()!
var checks = 0

func evaluate(_ script: String) -> JSValue {
    context.exception = nil
    guard let result = context.evaluateScript(script), context.exception == nil else {
        fatalError("JavaScript failed: \(context.exception?.toString() ?? script)")
    }
    return result
}

func expect(_ script: String, _ message: String) {
    guard evaluate(script).toBool() else {
        fatalError(message)
    }
    checks += 1
}

func bridge(_ json: String, as name: String) throws {
    let foundationValue = try JSONSerialization.jsonObject(with: Data(json.utf8))
    context.setObject(foundationValue, forKeyedSubscript: name as NSString)
}

// Separate empty containers in JSON can become the same immutable Foundation
// object. JavaScriptCore intentionally preserves native object identity.
try bridge("""
{
  "syncQueue": {}, "completedCommands": {},
  "emptyArrayA": [], "emptyArrayB": [],
  "one": {"value": 9}, "two": {"value": 9},
  "nested": {"map": {}, "array": []},
  "zero": 0, "oneNumber": 1, "no": false, "yes": true
}
""", as: "received")

let aliasObservation = evaluate("""
JSON.stringify({
  emptyObjects: received.syncQueue === received.completedCommands,
  emptyArrays: received.emptyArrayA === received.emptyArrayB,
  equalNonemptyObjects: received.one === received.two
})
""").toString()!
print("Observed bridge aliases: \(aliasObservation)")
print("Platform: \(ProcessInfo.processInfo.operatingSystemVersionString)")

expect("received.one !== received.two", "Equal nonempty dictionaries must remain distinct")
expect("received.one.value === 9 && received.two.value === 9", "Nonempty values changed")
expect("received.zero === 0 && typeof received.zero === 'number'", "Zero became a boolean")
expect("received.oneNumber === 1 && typeof received.oneNumber === 'number'", "One became a boolean")
expect("received.no === false && received.yes === true", "Boolean values changed")

// Detach at the storage-read boundary, before either application map is edited.
_ = evaluate("var detached = JSON.parse(JSON.stringify(received))")
expect("detached !== received", "The top-level object was not detached")
expect("detached.syncQueue !== detached.completedCommands", "Empty maps still alias")
expect("detached.emptyArrayA !== detached.emptyArrayB", "Empty arrays still alias")
expect("detached.nested.map !== detached.syncQueue", "Nested empty map still aliases")
expect("detached.nested.array !== detached.emptyArrayA", "Nested empty array still aliases")
expect("JSON.stringify(detached) === JSON.stringify(received)", "Detachment changed JSON data")

_ = evaluate("""
detached.syncQueue['今更'] = 9;
detached.completedCommands['fixture-command'] = {added: 27};
detached.emptyArrayA.push('only A');
""")
expect("Object.keys(detached.syncQueue).length === 1 && detached.syncQueue['今更'] === 9",
       "Command receipt contaminated the queue")
expect("Object.keys(detached.completedCommands).length === 1 && detached.completedCommands['fixture-command'].added === 27",
       "Queued term contaminated the command receipts")
expect("detached.emptyArrayA.length === 1 && detached.emptyArrayB.length === 0 && detached.nested.array.length === 0",
       "Array mutation crossed container boundaries")
expect("Object.keys(received.syncQueue).length === 0 && Object.keys(received.completedCommands).length === 0 && received.emptyArrayA.length === 0",
       "Detached mutation changed the original bridge result")

// Simulate the historical bug explicitly so this fixture still exercises
// recovery after Foundation/Safari eventually stops sharing empty containers.
// JSON persistence loses the reference alias but keeps both contaminated maps.
let contaminatedJSON = evaluate("""
(function () {
  const shared = {'今更': 9, 'fixture-command': {added: 27}};
  return JSON.stringify({syncQueue: shared, completedCommands: shared});
})()
""").toString()!
try bridge(contaminatedJSON, as: "historical")
expect("historical.syncQueue !== historical.completedCommands",
       "Persisted nonempty maps unexpectedly alias")
expect("Object.keys(historical.syncQueue).length === 2 && Object.keys(historical.completedCommands).length === 2 && Object.keys(historical.syncQueue).every(key => JSON.stringify(historical.syncQueue[key]) === JSON.stringify(historical.completedCommands[key]))",
       "The persisted contamination fixture changed")

// This demonstrates the unambiguous split for this exact fixture only. Product
// recovery must separately validate the entire schema and reject ambiguous data.
_ = evaluate("""
var restored = JSON.parse(JSON.stringify(historical));
var queueEntries = Object.entries(restored.syncQueue).filter(([, value]) => Number.isSafeInteger(value) && value > 0);
var commandEntries = Object.entries(restored.completedCommands).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Number.isSafeInteger(value.added) && value.added >= 0);
var splitQueue = Object.fromEntries(queueEntries);
var splitCommands = Object.fromEntries(commandEntries);
""")
expect("queueEntries.length === 1 && commandEntries.length === 1 && queueEntries.length + commandEntries.length === Object.keys(restored.syncQueue).length",
       "Historical entries could not be partitioned without loss")
expect("splitQueue['今更'] === 9 && !Object.hasOwn(splitQueue, 'fixture-command')",
       "Historical queue could not be recovered")
expect("splitCommands['fixture-command'].added === 27 && !Object.hasOwn(splitCommands, '今更')",
       "Historical command receipt could not be recovered")

print("PASS: \(checks) offline Safari bridge checks")
'''


def main():
    env = os.environ.copy()
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if "DEVELOPER_DIR" not in env and xcode.is_dir():
        env["DEVELOPER_DIR"] = str(xcode)
    sdk = subprocess.check_output(
        ["xcrun", "--sdk", "macosx", "--show-sdk-path"], env=env, text=True
    ).strip()
    with tempfile.TemporaryDirectory(prefix="kanji-safari-bridge-tests-") as directory:
        source = Path(directory) / "main.swift"
        source.write_text(SWIFT_CASES, encoding="utf-8")
        binary = Path(directory) / "safari-storage-bridge-tests"
        subprocess.run(
            ["xcrun", "swiftc", "-sdk", sdk, "-module-cache-path",
             str(Path(directory) / "module-cache"), "-warnings-as-errors",
             str(source), "-o", str(binary)],
            env=env, check=True,
        )
        return subprocess.run([str(binary)], env=env, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
