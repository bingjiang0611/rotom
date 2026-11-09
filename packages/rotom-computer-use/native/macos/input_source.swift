import Carbon

/// Only input methods need the AX-first path. Unknown sources and plain layouts
/// keep key delivery, and an explicitly pinned transport is never rewritten.
enum InputSourcePolicy {
	static func prefersAX(type: CFString?, requireTransport: Bool) -> Bool {
		guard !requireTransport, let type else { return false }
		return type == kTISTypeKeyboardInputMode || type == kTISTypeKeyboardInputMethodWithoutModes || type == kTISTypeKeyboardInputMethodModeEnabled
	}

	static func currentPrefersAX(requireTransport: Bool) -> Bool {
		guard !requireTransport, let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
			let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return false }
		return prefersAX(type: Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue(), requireTransport: requireTransport)
	}

	static func selfTest() -> Int {
		let cases: [(CFString?, Bool, Bool)] = [
			(kTISTypeKeyboardLayout, false, false),
			(kTISTypeKeyboardInputMode, false, true),
			(kTISTypeKeyboardInputMethodWithoutModes, false, true),
			(kTISTypeKeyboardInputMethodModeEnabled, false, true),
			(kTISTypeKeyboardInputMode, true, false),
			(nil, false, false),
		]
		let failures = cases.filter { prefersAX(type: $0.0, requireTransport: $0.1) != $0.2 }.count
		print("input-source cases=\(cases.count) failures=\(failures)")
		return failures
	}
}
