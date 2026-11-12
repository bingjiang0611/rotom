import Foundation

/// What a text write actually did, from the field's value before and after.
///
/// `didnt` is reserved for "nothing changed": it is the only outcome that invites a
/// retry, including the opt-in foreground retry. A field that changed but does not end
/// with the requested text may have been rewritten by an input method, a mask or an
/// autocorrection, so it is `unknown` - something was written and nobody can say what
/// (review G3).
enum TextWriteOutcome {
	/// - Parameters:
	///   - before: field value read before the write.
	///   - after: field value read after the write.
	///   - expected: the text the caller asked for; empty means "no verification possible".
	static func classify(before: String, after: String, expected: String) -> String {
		guard !expected.isEmpty else { return after != before ? "unknown" : "didnt" }
		if after.hasSuffix(expected) { return "worked" }
		return after != before ? "unknown" : "didnt"
	}
}
