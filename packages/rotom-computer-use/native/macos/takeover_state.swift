import Foundation
import ApplicationServices

/// Native dispatch latch. Network round trips never hold this lock. Input
/// generations invalidate interrupted batches as well as pending resume replies.
final class TakeoverState {
	struct Session {
		let id: String
		let agentId: String
		let leaseId: String
		let pid: Int32
		let windowId: UInt32
		let windowRef: String
		let bundleId: String
		let launchDate: Date?
		let label: String
		let startedAt: TimeInterval
		var pausedAt: TimeInterval?
		var sequence = 0
		var resumes = 0
	}
	struct HeldInput: Hashable {
		enum Kind: String { case key, modifier, button }
		let kind: Kind
		let code: Int
		let pid: Int32
		let delivery: String
	}
	struct Release {
		let input: HeldInput
		let posted: Bool
		var metadata: [String: Any] { ["kind": input.kind.rawValue, "code": input.code, "posted": posted] }
	}
	struct Yield {
		let session: Session
		let releases: [Release]
	}
	static let quietSeconds: TimeInterval = 30
	static let pauseTimeout: TimeInterval = 120
	static let maxDuration: TimeInterval = 600
	static let maxResumes = 3
	private let lock = NSRecursiveLock()
	private var session: Session?
	private var yielding = false
	private var releases: [HeldInput: () -> Bool] = [:]
	private var unresolved: [HeldInput] = []
	private let now: () -> TimeInterval

	init(now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) { self.now = now }
	var snapshot: Session? { lock.lock(); defer { lock.unlock() }; return session }
	var unresolvedInputs: [HeldInput] { lock.lock(); defer { lock.unlock() }; return unresolved }

	func begin(_ value: Session) throws {
		lock.lock(); defer { lock.unlock() }
		guard unresolved.isEmpty else { throw BridgeFailure(message: "Unresolved surrender releases; clear the held state manually and restart this helper before authorizing another takeover", code: "release_failed") }
		guard session == nil else { throw BridgeFailure(message: "A takeover is already active", code: "takeover_conditions") }
		session = value
	}

	func interrupted(expected: String?) -> Bool {
		lock.lock(); defer { lock.unlock() }
		guard let expected else { return false }
		return session.map({ "\($0.id):\($0.sequence)" }) != expected || session?.pausedAt != nil || yielding
	}

	func dispatch<T>(expected: String?, _ body: () throws -> T) throws -> T {
		lock.lock(); defer { lock.unlock() }
		guard unresolved.isEmpty else { throw BridgeFailure(message: "A surrender release could not be posted; no further input is allowed", code: "release_failed") }
		if interrupted(expected: expected) || session?.pausedAt != nil || yielding {
			throw BridgeFailure(message: "Takeover interrupted by user input or release; do not replay the action", code: "user_input_pause")
		}
		if let state = session, now() - state.startedAt >= Self.maxDuration {
			throw BridgeFailure(message: "Takeover duration budget is exhausted", code: "takeover_duration_limit")
		}
		return try body()
	}

	/// Admit a synchronous cross-process operation without holding the latch while
	/// waiting for its reply. An admitted operation is in-flight, not cancellable;
	/// finish() reports unknown if its generation changes before the reply.
	func admitWrite(expected: String?) throws { try dispatch(expected: expected) {} }

	func trackDown(_ input: HeldInput, release: @escaping () -> Bool) { lock.lock(); defer { lock.unlock() }; releases[input] = release }
	func trackUp(_ input: HeldInput) { lock.lock(); defer { lock.unlock() }; releases.removeValue(forKey: input) }

	/// Inhibit new work, emit only outstanding ups, then publish paused.
	@discardableResult func pause(now: TimeInterval) -> Yield? {
		lock.lock(); defer { lock.unlock() }
		guard var value = session else { return nil }
		value.sequence += 1
		if value.pausedAt != nil { session = value; return nil }
		yielding = true
		let released = drainReleases()
		value.pausedAt = now
		session = value
		yielding = false
		return Yield(session: value, releases: released)
	}

	func resume(id: String, sequence: Int, quiet: @autoclosure () -> Bool, now: TimeInterval) -> Bool {
		lock.lock(); defer { lock.unlock() }
		guard var value = session, value.id == id, value.sequence == sequence,
			let pausedAt = value.pausedAt, quiet(), !yielding, unresolved.isEmpty,
			now - pausedAt < Self.pauseTimeout, now - value.startedAt < Self.maxDuration,
			value.resumes < Self.maxResumes else { return false }
		value.pausedAt = nil; value.resumes += 1; session = value
		return true
	}

	@discardableResult func end(id: String? = nil) -> Yield? {
		lock.lock(); defer { lock.unlock() }
		guard let value = session, id == nil || value.id == id else { return nil }
		yielding = true
		let released = drainReleases()
		session = nil
		yielding = false
		return Yield(session: value, releases: released)
	}

	private func drainReleases() -> [Release] {
		let pending = releases; releases.removeAll()
		// Release ordinary keys/buttons first, then modifiers. Sorting makes the
		// metadata and tests deterministic; no held state survives for replay.
		let results = pending.keys.sorted { left, right in
			if (left.kind == .modifier) != (right.kind == .modifier) { return right.kind == .modifier }
			if left.kind != right.kind { return left.kind.rawValue < right.kind.rawValue }
			if left.code != right.code { return left.code < right.code }
			if left.pid != right.pid { return left.pid < right.pid }
			return left.delivery < right.delivery
		}.map { Release(input: $0, posted: pending[$0]!()) }
		unresolved.append(contentsOf: results.filter { !$0.posted }.map(\.input))
		return results
	}

	static func modifierFlag(code: Int) -> CGEventFlags? {
		switch code {
		case 54, 55: return .maskCommand
		case 56, 60: return .maskShift
		case 57: return .maskAlphaShift
		case 58, 61: return .maskAlternate
		case 59, 62: return .maskControl
		case 63: return .maskSecondaryFn
		default: return nil
		}
	}

	static func transition(_ event: CGEvent, pid: Int32, delivery: String) -> (input: HeldInput, down: Bool)? {
		switch event.type {
		case .keyDown, .keyUp, .flagsChanged:
			let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
			let modifier = modifierFlag(code: code)
			let down = event.type == .flagsChanged ? modifier.map { event.flags.contains($0) } ?? false : event.type == .keyDown
			return (HeldInput(kind: modifier == nil ? .key : .modifier, code: code, pid: pid, delivery: delivery), down)
		case .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseUp, .rightMouseUp, .otherMouseUp:
			let down = event.type == .leftMouseDown || event.type == .rightMouseDown || event.type == .otherMouseDown
			return (HeldInput(kind: .button, code: Int(event.getIntegerValueField(.mouseEventButtonNumber)), pid: pid, delivery: delivery), down)
		default: return nil
		}
	}

	/// Fresh up events only: never copy Unicode data, stale coordinates or flags
	/// from the interrupted down. The caller samples the live cursor at surrender.
	static func releaseEvent(_ input: HeldInput, position: CGPoint?, flags: CGEventFlags) -> CGEvent? {
		if input.kind == .button {
			guard let position, let button = CGMouseButton(rawValue: UInt32(input.code)) else { return nil }
			let type: CGEventType = input.code == 0 ? .leftMouseUp : input.code == 1 ? .rightMouseUp : .otherMouseUp
			let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: position, mouseButton: button)
			event?.flags = flags
			return event
		}
		guard let code = CGKeyCode(exactly: input.code) else { return nil }
		let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
		var currentFlags = flags
		if input.kind == .modifier, let ownFlag = modifierFlag(code: input.code) { currentFlags.remove(ownFlag) }
		event?.flags = currentFlags
		return event
	}

	static func isInterruption(_ code: String) -> Bool { code == "user_input_pause" || code == "released_by_user" || code == "takeover_duration_limit" || code == "release_failed" }

	static func quiet(_ activity: [String: Any]) -> Bool {
		guard activity["listening"] as? Bool == true,
			let observed = activity["listeningSeconds"] as? Double, observed >= quietSeconds,
			let last = activity["lastUserInputAt"] as? Double,
			let idle = activity["idleSeconds"] as? Double else { return false }
		return last == 0 || (last > 0 && idle >= quietSeconds)
	}
}
