import AppKit
import ApplicationServices
import Foundation

// cursor-sidecar — standalone cursor telemetry logger for Magic AutoPass v4.
// Adapted from OpenScreen (MIT, github.com/siddharthvaddem/openscreen) —
// electron/native/screencapturekit/Sources/OpenScreenMacOSCursorHelper/main.swift.
// Changes from the original: emits the cursor POSITION per sample (normalized
// 0-1 against the primary display, top-left origin — the OpenScreen telemetry
// contract), writes NDJSON to a file instead of stdout, and drops the cursor
// bitmap capture (not needed for zoom targeting; keeps logs small).
//
// Run it alongside an OBS screen recording; the header line carries the
// absolute epoch start so the log aligns with the video file's creation time.
// Stop with Ctrl-C. Requires Accessibility trust for click detection and
// element classification (see README.md).

struct CliOptions {
	var outPath: String?
	var intervalMs: Int = 33
}

func parseCli() -> CliOptions {
	var options = CliOptions()
	let args = CommandLine.arguments
	var i = 1
	while i < args.count {
		switch args[i] {
		case "--out":
			if i + 1 < args.count {
				options.outPath = args[i + 1]
				i += 1
			}
		case "--interval-ms":
			if i + 1 < args.count, let v = Int(args[i + 1]) {
				options.intervalMs = max(8, v)
				i += 1
			}
		case "--help", "-h":
			print("""
			usage: cursor-sidecar [--out <file.ndjson>] [--interval-ms <n>]
			  --out          output NDJSON path (default ~/Movies/cursor-logs/<epoch>.ndjson)
			  --interval-ms  sample interval, default 33 (~30 Hz)
			""")
			exit(0)
		default:
			FileHandle.standardError.write(
				"unknown argument: \(args[i])\n".data(using: .utf8)!)
			exit(1)
		}
		i += 1
	}
	return options
}

// MARK: - Click tracking (CGEvent tap, listen-only) — unchanged from OpenScreen

final class MouseButtonTracker {
	private let lock = NSLock()
	private var leftDownCount = 0
	private var leftUpCount = 0
	private var eventTap: CFMachPort?
	private var runLoopSource: CFRunLoopSource?

	struct Events {
		let leftDownCount: Int
		let leftUpCount: Int
	}

	func start() -> Bool {
		let mask =
			(1 << CGEventType.leftMouseDown.rawValue) |
			(1 << CGEventType.leftMouseUp.rawValue)
		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .listenOnly,
			eventsOfInterest: CGEventMask(mask),
			callback: { _, type, event, userInfo in
				if let userInfo {
					let tracker = Unmanaged<MouseButtonTracker>.fromOpaque(userInfo).takeUnretainedValue()
					tracker.record(type)
				}
				return Unmanaged.passUnretained(event)
			},
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			return false
		}

		guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
			return false
		}

		eventTap = tap
		runLoopSource = source
		CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
		CGEvent.tapEnable(tap: tap, enable: true)
		return true
	}

	func pump() {
		CFRunLoopRunInMode(.defaultMode, 0.001, false)
	}

	func consume() -> Events {
		lock.lock()
		defer { lock.unlock() }
		let events = Events(leftDownCount: leftDownCount, leftUpCount: leftUpCount)
		leftDownCount = 0
		leftUpCount = 0
		return events
	}

	private func record(_ type: CGEventType) {
		lock.lock()
		defer { lock.unlock() }
		if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
			reenableTap()
			return
		}
		if type == .leftMouseDown {
			leftDownCount += 1
		} else if type == .leftMouseUp {
			leftUpCount += 1
		}
	}

	private func reenableTap() {
		if let eventTap {
			CGEvent.tapEnable(tap: eventTap, enable: true)
		}
	}
}

// MARK: - AX element classification — unchanged from OpenScreen

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	return value as? String
}

func parentElement(_ element: AXUIElement) -> AXUIElement? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
		return nil
	}

	return (value as! AXUIElement)
}

func roleDescription(_ element: AXUIElement) -> String? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXRoleDescriptionAttribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	return value as? String
}

func isTextInputRole(_ role: String?) -> Bool {
	role == "AXTextField" ||
		role == "AXTextArea" ||
		role == "AXTextView" ||
		role == "AXComboBox"
}

func isPointerRole(_ role: String?, _ subrole: String?, _ description: String?) -> Bool {
	if role == "AXLink" ||
		subrole?.localizedCaseInsensitiveContains("link") == true ||
		description?.contains("link") == true
	{
		return true
	}

	return role == "AXButton" ||
		role == "AXMenuButton" ||
		role == "AXPopUpButton" ||
		role == "AXCheckBox" ||
		role == "AXRadioButton" ||
		role == "AXSwitch" ||
		role == "AXDisclosureTriangle" ||
		role == "AXTab" ||
		role == "AXMenuItem"
}

func cursorTypeForElement(_ element: AXUIElement) -> String? {
	var current: AXUIElement? = element

	for _ in 0..<5 {
		guard let element = current else {
			break
		}

		let role = stringAttribute(element, kAXRoleAttribute)
		let subrole = stringAttribute(element, kAXSubroleAttribute)
		let description = roleDescription(element)?.lowercased()

		if isTextInputRole(role) {
			return "text"
		}

		if isPointerRole(role, subrole, description) {
			return "pointer"
		}

		current = parentElement(element)
	}

	return nil
}

// MARK: - Position (the part OpenScreen never emitted)

func primaryScreenFrame() -> CGRect {
	NSScreen.screens.first?.frame ?? NSScreen.main?.frame ?? CGRect(x: 0, y: 0, width: 1, height: 1)
}

/// Mouse position in top-left-origin screen coordinates (AX convention).
func accessibilityPointForMouse() -> CGPoint {
	let mouse = NSEvent.mouseLocation
	let primaryHeight = primaryScreenFrame().height
	return CGPoint(x: mouse.x, y: primaryHeight - mouse.y)
}

func clamp01(_ v: Double) -> Double {
	min(1, max(0, v))
}

/// Normalized 0-1 position against the primary display — the OpenScreen
/// telemetry contract ({timeMs, cx, cy}). A mouse on a secondary display
/// clamps to the nearest edge.
func normalizedCursorPosition() -> (cx: Double, cy: Double) {
	let point = accessibilityPointForMouse()
	let frame = primaryScreenFrame()
	return (
		cx: clamp01(Double(point.x) / Double(max(1, frame.width))),
		cy: clamp01(Double(point.y) / Double(max(1, frame.height)))
	)
}

func currentCursorType() -> String? {
	guard AXIsProcessTrusted() else {
		return nil
	}

	let point = accessibilityPointForMouse()
	let systemWide = AXUIElementCreateSystemWide()
	var element: AXUIElement?
	let result = AXUIElementCopyElementAtPosition(
		systemWide,
		Float(point.x),
		Float(point.y),
		&element
	)

	guard result == .success, let element else {
		return nil
	}

	return cursorTypeForElement(element)
}

func leftButtonDown() -> Bool {
	CGEventSource.buttonState(.hidSystemState, button: .left)
}

func requestAccessibilityTrust() -> Bool {
	let options = [
		kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
	] as CFDictionary
	return AXIsProcessTrustedWithOptions(options)
}

// MARK: - NDJSON file output

func jsonLine(_ fields: [String: Any?]) -> Data? {
	let compacted = fields.compactMapValues { $0 }
	guard let data = try? JSONSerialization.data(withJSONObject: compacted, options: []) else {
		return nil
	}
	return data + Data("\n".utf8)
}

// MARK: - main

let options = parseCli()
let startEpochMs = Int(Date().timeIntervalSince1970 * 1000)

let outPath: String
if let p = options.outPath {
	outPath = (p as NSString).expandingTildeInPath
} else {
	let dir = ("~/Movies/cursor-logs" as NSString).expandingTildeInPath
	try? FileManager.default.createDirectory(
		atPath: dir, withIntermediateDirectories: true)
	outPath = "\(dir)/\(startEpochMs).ndjson"
}
FileManager.default.createFile(atPath: outPath, contents: nil)
guard let out = FileHandle(forWritingAtPath: outPath) else {
	FileHandle.standardError.write("cannot open \(outPath) for writing\n".data(using: .utf8)!)
	exit(1)
}

let accessibilityTrusted = requestAccessibilityTrust()
let mouseTracker = MouseButtonTracker()
let mouseTapReady = mouseTracker.start()
let screen = primaryScreenFrame()

if let header = jsonLine([
	"type": "header",
	"version": 1,
	"startEpochMs": startEpochMs,
	"sampleIntervalMs": options.intervalMs,
	"displayWidth": Int(screen.width),
	"displayHeight": Int(screen.height),
	"accessibilityTrusted": accessibilityTrusted,
	"mouseTapReady": mouseTapReady,
]) {
	out.write(header)
}

print("cursor-sidecar logging to \(outPath)")
print("started at epoch \(startEpochMs) ms — Ctrl-C to stop")
if !accessibilityTrusted {
	print("WARNING: no Accessibility trust — cursorType will be null (positions still log). Grant it in System Settings > Privacy & Security > Accessibility.")
}
if !mouseTapReady {
	print("WARNING: CGEvent tap unavailable — clicks fall back to button-state polling.")
}

var shouldStop: sig_atomic_t = 0
signal(SIGINT) { _ in shouldStop = 1 }
signal(SIGTERM) { _ in shouldStop = 1 }

var sampleCount = 0
var prevButtonDown = false

while shouldStop == 0 {
	autoreleasepool {
		mouseTracker.pump()
		let mouseEvents = mouseTracker.consume()
		let buttonDown = leftButtonDown()
		// Tap-based edge detection when trusted; polled edge as the fallback.
		let pressed = mouseTapReady
			? mouseEvents.leftDownCount > 0
			: (buttonDown && !prevButtonDown)
		prevButtonDown = buttonDown
		let position = normalizedCursorPosition()
		if let line = jsonLine([
			"type": "sample",
			"timeMs": Int(Date().timeIntervalSince1970 * 1000) - startEpochMs,
			"cx": (position.cx * 10000).rounded() / 10000,
			"cy": (position.cy * 10000).rounded() / 10000,
			"leftButtonDown": buttonDown,
			"leftButtonPressed": pressed,
			"cursorType": currentCursorType(),
		]) {
			out.write(line)
			sampleCount += 1
		}
		Thread.sleep(forTimeInterval: Double(options.intervalMs) / 1000.0)
	}
}

try? out.close()
let elapsedSec = (Int(Date().timeIntervalSince1970 * 1000) - startEpochMs) / 1000
print("\nstopped: \(sampleCount) samples over \(elapsedSec)s → \(outPath)")
