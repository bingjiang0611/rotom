// macOS fixture app for Computer Use v2 live checks.
//
// It deliberately contains one of each control class the accessibility actions
// target: a text field, a list, a checkbox, a disclosure tree, a slider, tabs and
// a context menu. Nothing here touches user data, which is why the live script
// may drive it.
//
// Build: swiftc -O native/macos-fixture/FixtureApp.swift -o /tmp/cu-fixture
//        (the app must run as a bundle for Accessibility to see a stable identity)
import AppKit
import SwiftUI

@MainActor
final class FixtureModel: ObservableObject {
	@Published var text: String = ""
	@Published var checked: Bool = false
	@Published var slider: Double = 0.5
	@Published var selectedRow: String = ""
	@Published var expanded: Bool = true
	@Published var selectedTab: Int = 0
	@Published var lastMenuSelection: String = ""
	// A monotonic counter, not a boolean (review 7, R1): a boolean is spent after the
	// first click, so a run that clicks the same button twice - AX first, then the
	// directed L2 post - cannot tell whether the second click landed. Every click now
	// has to show up as "count went up by exactly one".
	@Published var clicks: Int = 0

	let rows = ["Alpha", "Bravo", "Charlie", "Delta"]
	let tabs = ["First", "Second"]
}

struct FixtureView: View {
	@ObservedObject var model: FixtureModel

	var body: some View {
		VStack(alignment: .leading, spacing: 12) {
			Text("Computer Use fixture").font(.headline)

			TextField("Type here", text: $model.text)
				.accessibilityIdentifier("cu-fixture-text")

			// A content button, not window chrome: the live check clicks this and the
			// row below proves the click landed. Without it the only AXButton in the
			// tree is the close button, and clicking that closes the window the rest of
			// the check still needs (observed 2026-11-06).
			HStack(spacing: 8) {
				Button("Fixture action") { model.clicks += 1 }
					.accessibilityIdentifier("cu-fixture-button")
					// The count is also written into the button's own accessibility value
					// (review 6, P4): `press` reads back the pressed control, not its siblings, so
					// a result living only in the neighbouring Text made every press `unknown` -
					// truthful, but impossible for the matrix to judge.
					.accessibilityValue("clicks: \(model.clicks)")
				Text("clicks: \(model.clicks)")
					.accessibilityIdentifier("cu-fixture-button-result")
			}

			Toggle("Enable option", isOn: $model.checked)
				.accessibilityIdentifier("cu-fixture-checkbox")

			Slider(value: $model.slider, in: 0...1)
				.accessibilityIdentifier("cu-fixture-slider")

			DisclosureGroup("Details", isExpanded: $model.expanded) {
				Text("Disclosure content")
			}
			.accessibilityIdentifier("cu-fixture-tree")

			List(model.rows, id: \.self, selection: $model.selectedRow) { row in
				Text(row)
			}
			.frame(height: 120)
			.accessibilityIdentifier("cu-fixture-list")

			TabView(selection: $model.selectedTab) {
				Text("First tab").tabItem { Text("First") }.tag(0)
				Text("Second tab").tabItem { Text("Second") }.tag(1)
			}
			.frame(height: 80)
			.accessibilityIdentifier("cu-fixture-tabs")

			Text(model.lastMenuSelection.isEmpty ? "No menu choice" : "Chose \(model.lastMenuSelection)")
			Spacer()
		}
		.padding(16)
		.frame(minWidth: 420, minHeight: 380)
		.contextMenu {
			Button("Fixture menu item") { model.lastMenuSelection = "item" }
		}
	}
}

final class AppDelegate: NSObject, NSApplicationDelegate {
	func applicationDidFinishLaunching(_ notification: Notification) {
		// A stable bundle identity keeps the accessibility element tree cacheable
		// across observations; without it AX re-enumerates on every look.
		NSApp.setActivationPolicy(.regular)
	}
}

@main
struct FixtureApp: App {
	@NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
	@StateObject private var model = FixtureModel()

	var body: some Scene {
		WindowGroup("CU Fixture") {
			FixtureView(model: model)
		}
	}
}
