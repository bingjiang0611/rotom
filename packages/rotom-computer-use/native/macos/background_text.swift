import AppKit
import ApplicationServices
import Darwin

enum BackgroundTextCopy {
	static let unsupported = "Background text requires a visible IDEA text ref, readable value/selection, printable ASCII up to 256 characters, and stable focus."
	static let unknown = "Background text may be partial; read back before deciding another action. No replay or foreground fallback."
	static let exactTargetRequired = "Background text requires an exact window and text ref"
	static let axReadbackUnknown = "AX accepted the value write but readback differs. Do not replay or escalate to foreground."
}

// Deliberately bounded to the IDEA path verified in P0. This is not a general
// replacement for AX, an IME, or permission to activate a background application.
struct BackgroundTextPlan {
	let before: String
	let replacement: String
	let range: NSRange
	let after: String

	init?(before: String, replacement: String, range: NSRange) {
		guard replacement.utf16.count <= 256,
			replacement.unicodeScalars.allSatisfy({ (32...126).contains($0.value) }),
			range.location >= 0, range.length >= 0,
			range.location <= (before as NSString).length,
			range.length <= (before as NSString).length - range.location,
			Range(range, in: before) != nil else { return nil }
		self.before = before
		self.replacement = replacement
		self.range = range
		self.after = (before as NSString).replacingCharacters(in: range, with: replacement)
	}

	// Empty replacement uses one Delete event, never a shortcut or clipboard.
	var characters: [Character?] { replacement.isEmpty ? [nil] : replacement.map { $0 } }
	func value(after count: Int) -> String {
		guard count > 0 else { return before }
		return (before as NSString).replacingCharacters(in: range, with: String(replacement.prefix(count)))
	}
	func selection(before index: Int) -> NSRange {
		index == 0 ? range : NSRange(location: range.location + index, length: 0)
	}
}

// The production loop and deterministic checks share this exact no-replay rule.
// A timeout, focus loss or failed check after any dispatch is UNKNOWN, not didnt.
func deliverBackgroundText(
	_ plan: BackgroundTextPlan,
	isBound: (NSRange) -> Bool,
	read: () -> String?,
	send: (Character?) -> Bool,
	now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
	pause: () -> Void = { usleep(10_000) }
) -> String {
	if plan.before == plan.after { return "worked" }
	let deadline = now() + 8
	var dispatched = false
	for (index, character) in plan.characters.enumerated() {
		guard now() < deadline, isBound(plan.selection(before: index)), read() == plan.value(after: index) else {
			return dispatched ? "unknown" : "didnt"
		}
		dispatched = true
		guard send(character) else { return "unknown" }
		let stepDeadline = min(deadline, now() + 2)
		while true {
			let end = NSRange(location: plan.range.location + (character == nil ? 0 : index + 1), length: 0)
			// Check the full value AND selection; an AX cache update is not enough
			// evidence that the next queued key will go to the same insertion point.
			if read() == plan.value(after: index + 1), isBound(end) { break }
			if now() >= stepDeadline { return "unknown" }
			pause()
		}
	}
	return read() == plan.after ? "worked" : "unknown"
}

private func backgroundAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func backgroundSelection(_ element: AXUIElement) -> NSRange? {
	guard let value = backgroundAttribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
	var range = CFRange()
	guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
	return NSRange(location: range.location, length: range.length)
}

private struct BackgroundFocus {
	typealias PSN = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32
	typealias Post = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
	typealias Window = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
	let process: [UInt8]
	let window: CGWindowID
	let post: Post
	// Handles remain loaded for process lifetime; resolved once, never force-cast
	// a missing private ABI into an apparently working capability.
	static let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
	static let services = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
	init?(pid: pid_t, window: CGWindowID, element: AXUIElement) {
		guard let sky = Self.sky, let services = Self.services,
			let getPSN = dlsym(services, "GetProcessForPID"), let post = dlsym(sky, "SLPSPostEventRecordTo"),
			let getWindow = dlsym(services, "_AXUIElementGetWindow") else { return nil }
		// The ordinary outline uses heuristic AX/CG pairing. Key-window records
		// must instead bind an exact native window number and owner process.
		var actualWindow: CGWindowID = 0
		var owner: pid_t = 0
		guard unsafeBitCast(getWindow, to: Window.self)(element, &actualWindow) == .success,
			actualWindow == window, AXUIElementGetPid(element, &owner) == .success, owner == pid,
			let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, window) as? [[String: Any]])?.first,
			(info[kCGWindowIsOnscreen as String] as? Bool) == true else { return nil }
		var process = [UInt8](repeating: 0, count: 8)
		guard process.withUnsafeMutableBytes({ unsafeBitCast(getPSN, to: PSN.self)(pid, $0.baseAddress) }) == 0 else { return nil }
		self.process = process
		self.window = window
		self.post = unsafeBitCast(post, to: Post.self)
	}
	func record(kind: UInt8, active: Bool? = nil, key: Bool = false) -> Bool {
		var bytes = [UInt8](repeating: 0, count: 0xF8)
		bytes[4] = 0xF8; bytes[8] = kind
		for index in 0..<4 { bytes[0x3C + index] = UInt8(truncatingIfNeeded: window >> (index * 8)) }
		if let active { bytes[0x8A] = active ? 1 : 2 }
		if key { bytes[0x3A] = 0x10; for index in 0x20..<0x30 { bytes[index] = 0xFF } }
		return process.withUnsafeBytes { p in bytes.withUnsafeBufferPointer { post(p.baseAddress, $0.baseAddress) == 0 } }
	}
}

private let backgroundKeyCodes: [Character: CGKeyCode] = [
	"a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
	"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,
	"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
	"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,"j":38,"'":39,"k":40,
	";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"`":50," ":49
]
private let backgroundShifted = Dictionary(uniqueKeysWithValues: zip(Array("~!@#$%^&*()_+{}|:\"<>?"), Array("`1234567890-=[]\\;',./")))
func backgroundKey(_ character: Character) -> (CGKeyCode, CGEventFlags)? {
	let lower = Character(String(character).lowercased())
	let base = backgroundShifted[character] ?? lower
	guard let code = backgroundKeyCodes[base] else { return nil }
	return (code, base == character ? [] : .maskShift)
}

func backgroundIdeaText(pid: pid_t, window: AXUIElement, windowID: CGWindowID, element: AXUIElement, text: String, replace: Bool) -> [String: Any] {
	func result(_ outcome: String) -> [String: Any] {
		var response: [String: Any] = ["outcome": outcome, "performed": ["delivery": "pid", "grounding": "description", "backgroundText": true]]
		if outcome != "worked" {
			response["error"] = ["code": outcome == "unknown" ? "background_input_unknown" : "background_unsupported",
				"message": outcome == "unknown" ? BackgroundTextCopy.unknown : BackgroundTextCopy.unsupported]
		}
		return response
	}
	let app = AXUIElementCreateApplication(pid)
	guard let application = NSRunningApplication(processIdentifier: pid), !application.isHidden,
		let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != pid,
		let role = backgroundAttribute(element, kAXRoleAttribute) as? String, ["AXTextArea", "AXTextField"].contains(role),
		(backgroundAttribute(element, kAXSubroleAttribute) as? String) != kAXSecureTextFieldSubrole,
		let owner = backgroundAttribute(element, kAXWindowAttribute), CFEqual(owner, window),
		let before = backgroundAttribute(element, kAXValueAttribute) as? String,
		let selection = backgroundSelection(element),
		let plan = BackgroundTextPlan(before: before, replacement: text, range: replace ? NSRange(location: 0, length: (before as NSString).length) : selection),
		let focus = BackgroundFocus(pid: pid, window: windowID, element: window) else { return result("didnt") }
	let frontPID = front.processIdentifier
	func frontUnchanged() -> Bool { NSWorkspace.shared.frontmostApplication?.processIdentifier == frontPID && !application.isActive }
	if before == plan.after { return result("worked") }
	// Synthetic activation is internal to the target app; it is NOT activate().
	// If the user changes foreground, don't send a deactivation into their newly
	// selected target app. We cannot guarantee an app will never activate itself.
	var needsRelease = true
	defer { if needsRelease && frontUnchanged() { _ = focus.record(kind: 0x0D, active: false) } }
	guard focus.record(kind: 0x0D, active: true) else { return result("unknown") }
	usleep(20_000)
	guard frontUnchanged(), focus.record(kind: 1, key: true), focus.record(kind: 2, key: true) else { return result("unknown") }
	_ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
	var range = CFRange(location: plan.range.location, length: plan.range.length)
	guard let rangeValue = AXValueCreate(.cfRange, &range) else { return result("didnt") }
	_ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue)
	func bound(_ range: NSRange) -> Bool {
		guard frontUnchanged(), !application.isHidden,
			let focused = backgroundAttribute(app, kAXFocusedUIElementAttribute), CFEqual(focused, element),
			let owner = backgroundAttribute(element, kAXWindowAttribute), CFEqual(owner, window) else { return false }
		return backgroundSelection(element) == range
	}
	let focusDeadline = ProcessInfo.processInfo.systemUptime + 0.5
	while !bound(plan.range), frontUnchanged(), ProcessInfo.processInfo.systemUptime < focusDeadline { usleep(10_000) }
	let outcome = deliverBackgroundText(plan, isBound: bound, read: { backgroundAttribute(element, kAXValueAttribute) as? String }, send: { character in
		let key: (CGKeyCode, CGEventFlags)
		if let character { guard let mapped = backgroundKey(character) else { return false }; key = mapped }
		else { key = (51, []) }
		guard let down = CGEvent(keyboardEventSource: nil, virtualKey: key.0, keyDown: true),
			let up = CGEvent(keyboardEventSource: nil, virtualKey: key.0, keyDown: false) else { return false }
		for event in [down, up] {
			event.flags = key.1
			if let character {
				var units = Array(String(character).utf16)
				event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
			}
			event.postToPid(pid)
			usleep(8_000)
		}
		return true
	})
	// Delay/release is not an extra opportunity to dispatch. Verify only.
	needsRelease = false
	let released = frontUnchanged() && focus.record(kind: 0x0D, active: false)
	usleep(30_000)
	if outcome == "worked" && (!released || !frontUnchanged() || (backgroundAttribute(element, kAXValueAttribute) as? String) != plan.after) { return result("unknown") }
	return result(outcome)
}
