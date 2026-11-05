import AppKit
import ApplicationServices

/// Full-screen border shown while an agent holds the foreground (PLAN §7, L4).
///
/// The border is the user's evidence that the machine is being driven. It is
/// click-through and can never take focus, so it cannot intercept the input the
/// takeover is allowed to use; the helper's own windows are excluded from capture
/// (see `captureWindow`), so it never ends up in an observation either.
final class TakeoverBorderView: NSView {
	let label: String

	init(frame: NSRect, label: String) {
		self.label = label
		super.init(frame: frame)
	}

	required init?(coder: NSCoder) {
		return nil
	}

	override var isOpaque: Bool { false }

	override func draw(_ dirtyRect: NSRect) {
		guard let context = NSGraphicsContext.current?.cgContext else { return }
		let accent = NSColor(red: 1.0, green: 0x78 / 255.0, blue: 0x18 / 255.0, alpha: 0.95)
		context.setStrokeColor(accent.cgColor)
		context.setLineWidth(8)
		let inset = bounds.insetBy(dx: 4, dy: 4)
		context.stroke(inset)

		let text = "\(label) — the agent is driving. Touch anything to take back control."
		let attributes: [NSAttributedString.Key: Any] = [
			.font: NSFont.systemFont(ofSize: 15, weight: .semibold),
			.foregroundColor: NSColor.white,
		]
		let size = (text as NSString).size(withAttributes: attributes)
		let padding: CGFloat = 12
		let box = CGRect(
			x: bounds.midX - size.width / 2 - padding,
			y: bounds.maxY - size.height - padding * 3,
			width: size.width + padding * 2,
			height: size.height + padding
		)
		context.setFillColor(NSColor(red: 0.08, green: 0.08, blue: 0.1, alpha: 0.82).cgColor)
		let path = CGPath(roundedRect: box, cornerWidth: 10, cornerHeight: 10, transform: nil)
		context.addPath(path)
		context.fillPath()
		(text as NSString).draw(at: CGPoint(x: box.minX + padding, y: box.minY + padding / 2), withAttributes: attributes)
	}
}

private final class TakeoverBorderWindow: NSWindow {
	override var canBecomeKey: Bool { false }
	override var canBecomeMain: Bool { false }

	override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
		super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
		isOpaque = false
		backgroundColor = .clear
		hasShadow = false
		ignoresMouseEvents = true
		collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
		isReleasedWhenClosed = false
		hidesOnDeactivate = false
	}
}

/// Swallows Escape while a takeover is active and passes everything else through.
///
/// PLAN §7 allows consuming exactly this one key during L4: Escape is the app's
/// "cancel", and letting it through while the agent drives would end whatever the
/// agent was doing in a way the user cannot see. No other key is touched.
final class EscapeSwallowTap {
	private let lock = NSLock()
	private var tap: CFMachPort?
	private var source: CFRunLoopSource?
	private var runLoop: CFRunLoop?
	private var thread: Thread?
	private var active = false

	var isActive: Bool {
		lock.lock()
		defer { lock.unlock() }
		return active
	}

	func start() {
		lock.lock()
		if tap != nil {
			lock.unlock()
			return
		}
		lock.unlock()

		let mask = CGEventMask((1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue))
		let thread = Thread { [weak self] in
			guard let self else { return }
			let runLoop = CFRunLoopGetCurrent()
			guard let tap = CGEvent.tapCreate(
				tap: .cgSessionEventTap,
				place: .headInsertEventTap,
				options: .defaultTap,
				eventsOfInterest: mask,
				callback: escapeSwallowCallback,
				userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
			) else { return }
			self.lock.lock()
			self.tap = tap
			self.runLoop = runLoop
			self.source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
			if let source = self.source {
				CFRunLoopAddSource(runLoop, source, .commonModes)
			}
			self.active = true
			self.lock.unlock()
			CGEvent.tapEnable(tap: tap, enable: true)
			CFRunLoopRun()
		}
		thread.name = "pi-computer-use-escape-swallow"
		lock.lock()
		self.thread = thread
		lock.unlock()
		thread.start()
	}

	func stop() {
		lock.lock()
		let tap = self.tap
		let runLoop = self.runLoop
		self.tap = nil
		self.source = nil
		self.runLoop = nil
		self.thread = nil
		self.active = false
		lock.unlock()
		if let tap {
			CGEvent.tapEnable(tap: tap, enable: false)
			CFMachPortInvalidate(tap)
		}
		if let runLoop {
			CFRunLoopStop(runLoop)
		}
	}

	fileprivate func reenable() {
		lock.lock()
		let tap = self.tap
		lock.unlock()
		if let tap {
			CGEvent.tapEnable(tap: tap, enable: true)
		}
	}
}

private let escapeSwallowCallback: CGEventTapCallBack = { _proxy, type, event, userInfo in
	if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
		if let userInfo {
			Unmanaged<EscapeSwallowTap>.fromOpaque(userInfo).takeUnretainedValue().reenable()
		}
		return Unmanaged.passUnretained(event)
	}
	if (type == .keyDown || type == .keyUp || type == .flagsChanged),
		event.getIntegerValueField(.keyboardEventKeycode) == 53 {
		return nil
	}
	return Unmanaged.passUnretained(event)
}

/// Owns the border window and the Escape tap for one takeover at a time.
final class TakeoverBorder {
	private let swallow = EscapeSwallowTap()
	private var window: NSWindow?

	var isVisible: Bool { window != nil }

	func show(label: String) {
		if window != nil { return }
		let frame = NSScreen.main?.frame ?? NSScreen.screens.first?.frame ?? .zero
		let window = TakeoverBorderWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
		let view = TakeoverBorderView(frame: CGRect(origin: .zero, size: frame.size), label: label)
		window.contentView = view
		window.level = .statusBar
		window.orderFrontRegardless()
		self.window = window
		swallow.start()
	}

	func hide() {
		swallow.stop()
		guard let window else { return }
		window.orderOut(nil)
		window.contentView = nil
		window.close()
		self.window = nil
	}
}
