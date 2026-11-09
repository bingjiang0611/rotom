import Foundation
import ApplicationServices

/// Offline native checks. Constructs events but NEVER posts them, creates a tap,
/// queries the real cursor/input source, starts an App or changes focus.
enum TakeoverStateSelfTest {
	static func run() -> Int {
		var failures = 0
		func check(_ name: String, _ ok: Bool) { print("case \(name) \(ok ? "pass" : "FAIL")"); if !ok { failures += 1 } }
		func session(_ id: String) -> TakeoverState.Session {
			TakeoverState.Session(id: id, agentId: "a", leaseId: "lease-\(id)", pid: 1, windowId: 2, windowRef: "w", bundleId: "fixture", launchDate: nil, label: "fixture", startedAt: 0)
		}
		let gate = TakeoverState(now: { 0 })
		do {
			try gate.begin(session("one"))
			let key = TakeoverState.HeldInput(kind: .key, code: 0, pid: 1, delivery: "hid")
			let modifier = TakeoverState.HeldInput(kind: .modifier, code: 55, pid: 1, delivery: "hid")
			let button = TakeoverState.HeldInput(kind: .button, code: 0, pid: 1, delivery: "hid")
			let alreadyUp = TakeoverState.HeldInput(kind: .key, code: 7, pid: 1, delivery: "hid")
			var emitted: [TakeoverState.HeldInput] = []
			var writes = 0
			for input in [key, modifier, button, alreadyUp] {
				gate.trackDown(input) { emitted.append(input); return true }
			}
			gate.trackUp(alreadyUp)
			// A repeated keyDown is still one outstanding press, not two releases.
			gate.trackDown(key) { emitted.append(key); return true }
			try gate.dispatch(expected: "one:0") { writes += 1 }
			let yielded = gate.pause(now: 1)!
			check("release-set-exact", Set(emitted) == Set([key, modifier, button]) && emitted.count == 3)
			check("release-metadata-only", Set(yielded.releases[0].metadata.keys) == Set(["kind", "code", "posted"]))
			check("modifiers-released-last", emitted.last?.kind == .modifier)
			do { try gate.dispatch(expected: "one:0") { writes += 1 }; check("paused-zero-dispatch", false) }
			catch { check("paused-zero-dispatch", writes == 1) }
			_ = gate.pause(now: 2)
			check("release-drained-once", emitted.count == 3)
			check("press-identity-includes-transport", key != TakeoverState.HeldInput(kind: .key, code: 0, pid: 1, delivery: "pid"))
			check("press-identity-includes-pid", key != TakeoverState.HeldInput(kind: .key, code: 0, pid: 2, delivery: "hid"))
			check("quiet-required", !gate.resume(id: "one", sequence: 2, quiet: false, now: 32))
			check("new-input-cancels-resume", !gate.resume(id: "one", sequence: 1, quiet: true, now: 32))
			check("same-takeover-resumes", gate.resume(id: "one", sequence: 2, quiet: true, now: 32))
			do { try gate.dispatch(expected: "one:0") { writes += 1 }; check("old-text-batch-not-replayed", false) }
			catch { check("old-text-batch-not-replayed", writes == 1) }
			try gate.dispatch(expected: "one:2") { writes += 1 }
			check("fresh-batch-dispatches", writes == 2)
			gate.trackDown(key) { emitted.append(key); return true }
			let ended = gate.end()!
			check("hard-end-also-releases", ended.releases.map(\.input) == [key])
			check("stop-cancels-pending-resume", !gate.resume(id: "one", sequence: 2, quiet: true, now: 63))
			check("stop-idempotent", gate.end() == nil)
			do { try gate.dispatch(expected: "one:2") { writes += 1 }; check("ended-batch-zero-dispatch", false) }
			catch { check("ended-batch-zero-dispatch", writes == 2) }

			try gate.begin(session("two"))
			for index in 1...3 {
				_ = gate.pause(now: Double(index * 31))
				check("bounded-resume-\(index)", gate.resume(id: "two", sequence: index, quiet: true, now: Double(index * 31 + 30)))
			}
			_ = gate.pause(now: 130)
			check("resume-limit", !gate.resume(id: "two", sequence: 4, quiet: true, now: 160))
			_ = gate.end(); try gate.begin(session("three")); _ = gate.pause(now: 1)
			check("pause-timeout", !gate.resume(id: "three", sequence: 1, quiet: true, now: 121))
			check("duration-budget", !gate.resume(id: "three", sequence: 1, quiet: true, now: 600))

			let textGate = TakeoverState(now: { 0 })
			try textGate.begin(session("text"))
			var typed = ""
			for char in "partial" {
				do { try textGate.dispatch(expected: "text:0") { typed.append(char) } }
				catch { break }
				if typed.count == 2 { textGate.pause(now: 1) }
			}
			check("text-stops-at-interruption", typed == "pa")
			_ = textGate.resume(id: "text", sequence: 1, quiet: true, now: 31)
			do { try textGate.dispatch(expected: "text:0") { typed.append("rtial") } } catch {}
			check("partial-text-not-continued-after-resume", typed == "pa")

			let failedGate = TakeoverState(now: { 0 })
			try failedGate.begin(session("failed"))
			var failedAttempts = 0
			failedGate.trackDown(key) { failedAttempts += 1; return false }
			let failed = failedGate.pause(now: 1)!
			check("failed-release-remains-unresolved", failed.releases.count == 1 && !failed.releases[0].posted && failedGate.unresolvedInputs == [key])
			check("failed-release-no-auto-resume", !failedGate.resume(id: "failed", sequence: 1, quiet: true, now: 31))
			_ = failedGate.end()
			check("failed-release-never-replayed", failedAttempts == 1 && failedGate.unresolvedInputs == [key])
			do { try failedGate.begin(session("new")); check("unresolved-needs-manual-clear-and-restart", false) }
			catch { check("unresolved-needs-manual-clear-and-restart", true) }

			let slowGate = TakeoverState(now: { 0 })
			try slowGate.begin(session("slow"))
			let admitted = DispatchSemaphore(value: 0), unblock = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0), paused = DispatchSemaphore(value: 0)
			DispatchQueue.global().async {
				do { try slowGate.admitWrite(expected: "slow:0") } catch { finished.signal(); return }
				admitted.signal(); unblock.wait(); finished.signal()
			}
			let entered = admitted.wait(timeout: .now() + 1) == .success
			DispatchQueue.global().async { slowGate.pause(now: 1); paused.signal() }
			let yieldedWhileBlocked = paused.wait(timeout: .now() + 1) == .success
			unblock.signal()
			let completed = finished.wait(timeout: .now() + 1) == .success
			check("slow-AX-does-not-block-immediate-yield", entered && yieldedWhileBlocked && completed)
			check("in-flight-AX-becomes-unknown", slowGate.interrupted(expected: "slow:0"))

			let position = CGPoint(x: 83, y: 91)
			for input in [key, modifier, button] {
				let event = TakeoverState.releaseEvent(input, position: position, flags: [.maskShift, .maskCommand])!
				// CoreGraphics represents a modifier key-up as flagsChanged.
				let isUp = input.kind == .button ? event.type == .leftMouseUp : input.kind == .modifier ? event.type == .flagsChanged && !event.flags.contains(.maskCommand) : event.type == .keyUp
				check("up-only-\(input.kind)", isUp)
				if input.kind == .button { check("release-current-cursor-only", event.location == position) }
				else { check("release-keycode-\(input.kind)", event.getIntegerValueField(.keyboardEventKeycode) == Int64(input.code)) }
			}
			check("no-stale-coordinate-fallback", TakeoverState.releaseEvent(button, position: nil, flags: []) == nil)
			let modifierUp = TakeoverState.releaseEvent(modifier, position: nil, flags: [.maskShift, .maskCommand])!
			check("unrelated-user-modifier-preserved", modifierUp.flags.contains(.maskShift) && !modifierUp.flags.contains(.maskCommand))
			let down = CGEvent(keyboardEventSource: nil, virtualKey: 55, keyDown: true)!
			check("modifier-down-tracked", TakeoverState.transition(down, pid: 1, delivery: "hid")?.input.kind == .modifier)
			let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: position, mouseButton: .left)!
			check("movement-not-tracked-as-press", TakeoverState.transition(move, pid: 1, delivery: "hid") == nil)
			// Model the receiver after a real up: another up cannot introduce a press,
			// movement, focus or text. Actual App/OS effects still require B5 evidence.
			var receiverHeld = Set<TakeoverState.HeldInput>()
			var otherEvents = 0
			for input in [key, modifier, button] {
				let event = TakeoverState.releaseEvent(input, position: position, flags: [])!
				switch event.type {
				case .keyUp, .flagsChanged: receiverHeld.remove(input)
				case .leftMouseUp, .rightMouseUp, .otherMouseUp: receiverHeld.remove(input)
				case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown: receiverHeld.insert(input)
				default: otherEvents += 1
				}
			}
			check("redundant-ups-idempotent-in-input-model", receiverHeld.isEmpty && otherEvents == 0)
		} catch { check("unexpected-error", false) }
		check("monitor-required", !TakeoverState.quiet(["listening": false, "listeningSeconds": 60.0, "lastUserInputAt": 0.0, "idleSeconds": -1.0]))
		check("continuous-quiet-window", !TakeoverState.quiet(["listening": true, "listeningSeconds": 29.0, "lastUserInputAt": 0.0, "idleSeconds": -1.0]))
		print("takeover-state failures=\(failures)")
		return failures
	}
}
