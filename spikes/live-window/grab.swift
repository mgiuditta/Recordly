// Simulates Discord: grabs one window by CGWindowID through ScreenCaptureKit.
// usage: swift grab.swift <windowID> <out.png>
import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

_ = NSApplication.shared // CGS needs a connection before SCK calls
let windowID = CGWindowID(CommandLine.arguments[1])!
let outURL = URL(fileURLWithPath: CommandLine.arguments[2])

let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
	print("window \(windowID) not shareable; onScreen windows:", content.windows.filter(\.isOnScreen).count)
	exit(1)
}
print("window", window.title ?? "-", "frame", window.frame, "onScreen", window.isOnScreen)
let config = SCStreamConfiguration()
config.width = Int(window.frame.width)
config.height = Int(window.frame.height)
let image: CGImage = try await withCheckedThrowingContinuation { cont in
	SCScreenshotManager.captureImage(
		contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config
	) { image, error in
		if let image { cont.resume(returning: image) } else { cont.resume(throwing: error!) }
	}
}
let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, image, nil)
CGImageDestinationFinalize(dest)
print("saved", outURL.path, image.width, "x", image.height)
