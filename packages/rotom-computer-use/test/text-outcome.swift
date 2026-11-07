import Foundation

/// Deterministic checks for `TextWriteOutcome` (review G3).
///
/// Build: xcrun swiftc native/macos/text_outcome.swift test/text-outcome.swift -o /absolute/private/out
@main
struct TextOutcomeTests {
	static func main() {
		precondition(TextWriteOutcome.classify(before: "", after: "l2probe", expected: "l2probe") == "worked")
		precondition(TextWriteOutcome.classify(before: "old", after: "oldl2probe", expected: "l2probe") == "worked")
		// An input method rewrote the text: something landed, so this must not invite a retry.
		precondition(TextWriteOutcome.classify(before: "", after: "里probe", expected: "l2probe") == "unknown")
		// Nothing was written.
		precondition(TextWriteOutcome.classify(before: "abc", after: "abc", expected: "l2probe") == "didnt")
		precondition(TextWriteOutcome.classify(before: "", after: "", expected: "x") == "didnt")
		// No expected text to compare against: a change is unattributable, silence is a miss.
		precondition(TextWriteOutcome.classify(before: "", after: "x", expected: "") == "unknown")
		precondition(TextWriteOutcome.classify(before: "", after: "", expected: "") == "didnt")
		print("text outcome cases pass")
	}
}
