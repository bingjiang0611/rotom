// User simulator for the Computer Use v2 acceptance run (PLAN §10).
//
// Types a fixed string into whatever app is frontmost, at a fixed character rate,
// and moves the real system cursor on a slow cadence. Events are posted through
// the HID tap with an ordinary event source, so the helper's user-activity
// monitor classifies them as user input (no agent marker field).
//
//   swiftc -O -o ~/cu-v2-test/simulator simulator.swift
//   codesign --force --sign "Apple Development: ..." ~/cu-v2-test/simulator
//   ~/cu-v2-test/simulator --text "..." --chars-per-minute 300 --duration 40 --log /tmp/sim.jsonl

import AppKit
import Foundation

func option(_ name: String, default fallback: String) -> String {
	let args = CommandLine.arguments
	guard let index = args.firstIndex(of: name), index + 1 < args.count else { return fallback }
	return args[index + 1]
}

let text = option("--text", default: "")
let charsPerMinute = Double(option("--chars-per-minute", default: "300")) ?? 300
let duration = Double(option("--duration", default: "30")) ?? 30
let logPath = option("--log", default: "")

guard !text.isEmpty else {
	FileHandle.standardError.write(Data("simulator: --text is required\n".utf8))
	exit(2)
}

var logHandle: FileHandle?
if !logPath.isEmpty {
	FileManager.default.createFile(atPath: logPath, contents: nil)
	logHandle = FileHandle(forWritingAtPath: logPath)
}

func emit(_ fields: [String: Any]) {
	guard let logHandle, let data = try? JSONSerialization.data(withJSONObject: fields) else { return }
	logHandle.write(data)
	logHandle.write(Data("\n".utf8))
}

func nowMs() -> Int { Int(Date().timeIntervalSince1970 * 1000) }

// The helper reports `NSEvent.mouseLocation` (bottom-left origin), so log the
// position it will observe rather than the flipped CoreGraphics coordinate.
func cursorPosition() -> CGPoint { NSEvent.mouseLocation }

func postCharacter(_ character: Character) {
	let source = CGEventSource(stateID: .hidSystemState)
	guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
		let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
	else { return }
	var units = Array(String(character).utf16)
	down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
	up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
	down.post(tap: .cghidEventTap)
	up.post(tap: .cghidEventTap)
}

func moveCursor(to point: CGPoint) {
	let source = CGEventSource(stateID: .hidSystemState)
	guard let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else { return }
	event.post(tap: .cghidEventTap)
}

let screen = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
// CoreGraphics screen coordinates are top-left based; anchors stay inside the
// middle band of the screen so the simulator never lands on a Dock or menu bar.
let anchors: [CGPoint] = [
	CGPoint(x: screen.midX - 120, y: screen.maxY - 260),
	CGPoint(x: screen.midX + 160, y: screen.maxY - 320),
	CGPoint(x: screen.midX - 40, y: screen.maxY - 400),
	CGPoint(x: screen.midX + 60, y: screen.maxY - 220),
]

let characters = Array(text)
let interval = 60.0 / max(charsPerMinute, 1)
let started = Date()
var typed = 0
var anchorIndex = 0
var lastMove = Date.distantPast

emit(["t": nowMs(), "kind": "start", "charsPerMinute": charsPerMinute, "chars": characters.count])

while typed < characters.count {
	if Date().timeIntervalSince(started) > duration { break }
	postCharacter(characters[typed])
	typed += 1
	emit(["t": nowMs(), "kind": "char", "index": typed])
	if Date().timeIntervalSince(lastMove) >= 1.2 || lastMove == Date.distantPast {
		let target = anchors[anchorIndex % anchors.count]
		anchorIndex += 1
		moveCursor(to: target)
		lastMove = Date()
		let observed = cursorPosition()
		emit(["t": nowMs(), "kind": "move", "x": Double(observed.x), "y": Double(observed.y), "anchor": anchorIndex - 1])
	}
	usleep(useconds_t(interval * 1_000_000))
}

emit(["t": nowMs(), "kind": "done", "typed": typed])
try? logHandle?.synchronize()
exit(typed == characters.count ? 0 : 3)
