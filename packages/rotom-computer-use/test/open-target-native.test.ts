import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");

test("native target preflight and dispatch guard classify real fixture URLs without a GUI", { skip: process.platform !== "darwin" }, () => {
	const classifier = source.slice(source.indexOf("private struct OpenTarget {"), source.indexOf("final class AXRefStore {"));
	const reader = source.slice(source.indexOf("\tprivate func describeOpenTarget("), source.indexOf("\tprivate func inspectOpenTarget("));
	const arm = source.split('\t\tcase "open":')[1]?.split('\t\tcase "select":')[0];
	assert.ok(classifier && reader && arm);
	const directory = mkdtempSync(path.join(tmpdir(), "cu-open-target-"));
	try {
		const file = path.join(directory, "main.swift");
		writeFileSync(file, `import Foundation
import CryptoKit
${classifier}
typealias CFString = String
typealias AXUIElement = Int
let kAXURLAttribute = "AXURL"
struct BridgeFailure: Error { let message: String; let code: String }
enum AXError: Int32 { case success = 0 }
var currentURL: URL?
var calls = 0
func copyAttribute(_ element: Int, attribute: String) -> AnyObject? {
 precondition(attribute == "AXURL")
 return currentURL as NSURL?
}
${reader}
func supportsAction(_ element: Int, action: String) -> Bool { true }
func AXUIElementPerformAction(_ element: Int, _ action: String) -> AXError { calls += 1; return .success }
func open(_ params: [String: Any]) throws -> [String: Any] {
 let element = 1
 var performed: [String: Any] = [:]
${arm}
}
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let folder = root.appendingPathComponent("folder", isDirectory: true)
let app = root.appendingPathComponent("fixture.app", isDirectory: true)
let script = root.appendingPathComponent("script.sh")
let file = root.appendingPathComponent("document.txt")
let link = root.appendingPathComponent("app-link")
let folderLink = root.appendingPathComponent("folder-link")
let appNamedLink = root.appendingPathComponent("folder-link.app")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
try Data("#!/bin/sh\\nexit 99\\n".utf8).write(to: script)
try Data("fixture".utf8).write(to: file)
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: app)
try FileManager.default.createSymbolicLink(at: folderLink, withDestinationURL: folder)
try FileManager.default.createSymbolicLink(at: appNamedLink, withDestinationURL: folder)
let cases: [(URL?, String)] = [(folder, "directory"), (app, "package"), (link, "package"),
 (folderLink, "directory"), (appNamedLink, "package"), (script, "file"), (file, "file"), (nil, "unknown"), (root.appendingPathComponent("missing"), "unknown"),
 (URL(string: "https://example.com/"), "unknown")]
for (url, kind) in cases {
 currentURL = url
 let target = describeOpenTarget(1)
 precondition(target.kind == kind, "expected \\(kind), got \\(target.kind)")
 calls = 0
 do {
  _ = try open(["openTarget": target.json])
  precondition(kind == "directory")
 } catch let error as BridgeFailure {
  precondition(kind != "directory" && error.code == "open_confirmation_required")
 }
 precondition(calls == (kind == "directory" ? 1 : 0))
 calls = 0
 let result = try open(["openTarget": target.json, "openApproved": true])
 precondition(calls == 1 && result["outcome"] as? String == "unknown")
}
currentURL = folder
private let before = describeOpenTarget(1)
currentURL = app
calls = 0
do { _ = try open(["openTarget": before.json, "openApproved": true]); fatalError("changed target dispatched") }
catch let error as BridgeFailure { precondition(error.code == "open_target_changed") }
precondition(calls == 0)
currentURL = folder
calls = 0
do { _ = try open([:]); fatalError("missing preflight dispatched") }
catch let error as BridgeFailure { precondition(error.code == "open_target_changed") }
precondition(calls == 0)
print("10 target cases: directory direct; external/unknown unconfirmed=0; changed/missing preflight=0; approved=1 unknown")
`, { mode: 0o600 });
		const result = spawnSync("xcrun", ["swift", "-module-cache-path", path.join(directory, "module-cache"), file, directory], { encoding: "utf8", timeout: 60_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /unconfirmed=0; changed\/missing preflight=0/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
