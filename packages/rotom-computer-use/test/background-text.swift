import Foundation

@main
struct BackgroundTextTests {
	static func main() {
		func plan(_ before: String = "old", _ text: String = "ab", _ range: NSRange? = nil) -> BackgroundTextPlan {
			BackgroundTextPlan(before: before, replacement: text, range: range ?? NSRange(location: 0, length: (before as NSString).length))!
		}
		precondition(plan().after == "ab")
		precondition(plan("a😀z", "xy", NSRange(location: 1, length: 2)).after == "axyz")
		precondition(BackgroundTextPlan(before: "😀", replacement: "a", range: NSRange(location: 1, length: 1)) == nil)
		precondition(BackgroundTextPlan(before: "", replacement: "中文", range: NSRange(location: 0, length: 0)) == nil)
		precondition(BackgroundTextPlan(before: "", replacement: "\n", range: NSRange(location: 0, length: 0)) == nil)
		precondition(BackgroundTextPlan(before: "", replacement: String(repeating: "a", count: 257), range: NSRange(location: 0, length: 0)) == nil)
		for byte in 32...126 { precondition(backgroundKey(Character(UnicodeScalar(byte)!)) != nil) }
		precondition(backgroundKey("_")!.1.contains(.maskShift))
		precondition(backgroundKey("A")!.1.contains(.maskShift))

		var sent = 0
		var value = "old"
		var clock = 0.0
		var selection = NSRange(location: 0, length: 3)
		var pending: (String, NSRange, Double)?
		let p = plan()
		let outcome = deliverBackgroundText(p, isBound: { $0 == selection }, read: { value }, send: { _ in
			sent += 1
			pending = (p.value(after: sent), NSRange(location: sent, length: 0), clock + 0.3)
			return true
		}, now: { clock }, pause: {
			clock += 0.01
			if let update = pending, clock >= update.2 { value = update.0; selection = update.1; pending = nil }
		})
		precondition(outcome == "worked" && value == "ab" && sent == 2)

		// Accepted dispatch with no visible effect must never resend the key.
		sent = 0; clock = 0
		let timedOut = deliverBackgroundText(p, isBound: { _ in true }, read: { "old" }, send: { _ in sent += 1; return true }, now: { clock }, pause: { clock += 0.1 })
		precondition(timedOut == "unknown" && sent == 1)

		// A prefix elsewhere is not an exact readback; preserve the whole field.
		sent = 0; clock = 0
		let extraText = deliverBackgroundText(p, isBound: { _ in true }, read: { sent == 0 ? "old" : "aEXTRA" }, send: { _ in sent += 1; return true }, now: { clock }, pause: { clock += 0.1 })
		precondition(extraText == "unknown" && sent == 1)

		sent = 0
		let noFocus = deliverBackgroundText(p, isBound: { _ in false }, read: { "old" }, send: { _ in sent += 1; return true })
		precondition(noFocus == "didnt" && sent == 0)

		sent = 0; clock = 0
		let focusLost = deliverBackgroundText(p, isBound: { _ in sent == 0 }, read: { sent == 0 ? "old" : "a" }, send: { _ in sent += 1; return true }, now: { clock }, pause: { clock += 0.1 })
		precondition(focusLost == "unknown" && sent == 1)

		sent = 0
		let failedSend = deliverBackgroundText(p, isBound: { _ in true }, read: { "old" }, send: { _ in sent += 1; return false })
		precondition(failedSend == "unknown" && sent == 1)

		sent = 0
		let noOp = deliverBackgroundText(plan("same", "same"), isBound: { _ in false }, read: { nil }, send: { _ in sent += 1; return true })
		precondition(noOp == "worked" && sent == 0)

		sent = 0
		value = "old"
		let deleted = deliverBackgroundText(plan("old", ""), isBound: { _ in true }, read: { value }, send: { char in precondition(char == nil); sent += 1; value = ""; return true })
		precondition(deleted == "worked" && sent == 1)
		print("background text: plan, all printable keys, delayed readback, no replay, exact value, focus loss, send failure, no-op and delete checks passed")
	}
}
