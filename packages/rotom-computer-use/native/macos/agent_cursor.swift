import AppKit
import SwiftUI

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>

    static let shared = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private let scheduleIdleHide: IdleHideScheduler

    init(scheduleIdleHide: @escaping IdleHideScheduler) {
        self.scheduleIdleHide = scheduleIdleHide
    }

    func animate(agentId: String, to point: CGPoint, above windowId: UInt32, color: NSColor?) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let window = ensureWindow()
        if !window.isVisible { window.orderFrontRegardless() }
        window.order(.above, relativeTo: Int(windowId))

        let renderer = AgentCursorRenderer.shared
        let rgb = color.map { color -> (red: Double, green: Double, blue: Double) in
            let converted = color.usingColorSpace(.sRGB) ?? color
            return (Double(converted.redComponent), Double(converted.greenComponent), Double(converted.blueComponent))
        }
        renderer.animate(agentId: agentId, to: point, color: rgb)

        let generation = idleGeneration
        idleHideTask = scheduleIdleHide { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            renderer.removeAll()
            window.orderOut(nil)
            window.contentView = nil
            window.close()
            overlay = nil
            idleHideTask = nil
        }
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    private func ensureWindow() -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let window = AgentCursorOverlayWindow(
            contentRect: NSScreen.main?.frame ?? NSScreen.screens.first?.frame ?? .zero,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView())
        overlay = window
        return window
    }
}

/// Main-display-only, click-through overlay that can never take focus.
private final class AgentCursorOverlayWindow: NSWindow {
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

@MainActor
private struct AgentCursorView: View {
    @Bindable private var renderer = AgentCursorRenderer.shared

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 120.0, paused: !renderer.isAnimating)) { context in
            Canvas { graphics, _ in
                renderer.tick(now: context.date.timeIntervalSinceReferenceDate)
                drawCursor(in: graphics)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private func drawCursor(in graphics: GraphicsContext) {
        for state in renderer.cursors.values {
            drawCursor(state, in: graphics)
        }
    }

    private func drawCursor(_ state: AgentCursorState, in graphics: GraphicsContext) {
        let point = state.position
        guard point.x > -100 else { return }

        let accent = Color(red: state.color.red, green: state.color.green, blue: state.color.blue)
        let bloom = accent
        let radius: CGFloat = 22
        graphics.fill(
            Path(ellipseIn: CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)),
            with: .radialGradient(
                Gradient(colors: [bloom.opacity(0.55), bloom.opacity(0.15), bloom.opacity(0)]),
                center: point,
                startRadius: 0,
                endRadius: radius
            )
        )

        let points = [
            CGPoint(x: 14, y: 0),
            CGPoint(x: -8, y: -9),
            CGPoint(x: -3, y: 0),
            CGPoint(x: -8, y: 9),
        ]
        var shape = Path()
        for index in points.indices {
            let previous = points[(index + points.count - 1) % points.count]
            let current = points[index]
            let next = points[(index + 1) % points.count]
            let entry = CGPoint(x: current.x + (previous.x - current.x) * 0.16, y: current.y + (previous.y - current.y) * 0.16)
            let exit = CGPoint(x: current.x + (next.x - current.x) * 0.16, y: current.y + (next.y - current.y) * 0.16)
            if index == points.startIndex { shape.move(to: entry) } else { shape.addLine(to: entry) }
            shape.addQuadCurve(to: exit, control: current)
        }
        shape.closeSubpath()

        let transformed = shape.applying(
            CGAffineTransform(translationX: point.x, y: point.y)
                .rotated(by: CGFloat(state.heading + .pi))
        )
        graphics.fill(
            transformed,
            with: .linearGradient(
                Gradient(colors: [accent, accent.opacity(0.8), accent.opacity(0.6)]),
                startPoint: CGPoint(x: point.x + 14, y: point.y - 9),
                endPoint: CGPoint(x: point.x - 8, y: point.y + 9)
            )
        )
        graphics.stroke(transformed, with: .color(.white), lineWidth: 2)
    }
}
