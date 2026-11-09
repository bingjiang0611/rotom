import Carbon
import Foundation
import Dispatch

/// Only input methods need the AX-first path. Unknown sources and plain layouts
/// keep key delivery, and an explicitly pinned transport is never rewritten.
enum InputSourcePolicy {
	static func prefersAX(type: CFString?, requireTransport: Bool) -> Bool {
		guard !requireTransport, let type else { return false }
		return type == kTISTypeKeyboardInputMode || type == kTISTypeKeyboardInputMethodWithoutModes || type == kTISTypeKeyboardInputMethodModeEnabled
	}

	static func currentPrefersAX(requireTransport: Bool) -> Bool {
		guard !requireTransport else { return false }
		let type: CFString?
		if Thread.isMainThread {
			type = currentInputSourceType()
		} else {
			// Serve leaves the main thread in NSApp.run(); it never joins a client
			// request thread. Only read TIS here, not the rest of the input action.
			type = DispatchQueue.main.sync { currentInputSourceType() }
		}
		return prefersAX(type: type, requireTransport: requireTransport)
	}

	private static func currentInputSourceType() -> CFString? {
		precondition(Thread.isMainThread)
		guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
			let property = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return nil }
		return Unmanaged<CFString>.fromOpaque(property).takeUnretainedValue()
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
		var failures = cases.filter { prefersAX(type: $0.0, requireTransport: $0.1) != $0.2 }.count
		let background = DispatchWorkItem {
			precondition(!Thread.isMainThread)
			_ = currentPrefersAX(requireTransport: false)
		}
		DispatchQueue.global(qos: .userInitiated).async(execute: background)
		// Match serve's main run loop; a blocking wait here would deadlock the hop.
		let deadline = Date().addingTimeInterval(5)
		var completed = false
		while Date() < deadline {
			if background.wait(timeout: .now()) == .success { completed = true; break }
			RunLoop.current.run(until: Date().addingTimeInterval(0.01))
		}
		print("case input-source-background-main-hop \(completed ? "pass" : "FAIL")")
		if !completed { failures += 1 }
		print("input-source cases=\(cases.count + 1) failures=\(failures)")
		return failures
	}
}
