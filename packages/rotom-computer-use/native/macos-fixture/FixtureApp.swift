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
