// A one-off probe (removed before merge): an app's menu bar, each item's title and key equivalent, by accessibility.
//   swiftc probe-menus.swift -o probe-menus && ./probe-menus com.apple.Notes
import AppKit
import ApplicationServices

let id = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.apple.Notes"
print("trusted \(AXIsProcessTrusted())")
guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first else { print("not running"); exit(1) }
let root = AXUIElementCreateApplication(app.processIdentifier)
func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
	var v: AnyObject?
	return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
guard let bar = attr(root, kAXMenuBarAttribute) else { print("no menu bar"); exit(1) }
func walk(_ e: AXUIElement, _ path: String, _ depth: Int) {
	for child in (attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
		let title = (attr(child, kAXTitleAttribute) as? String) ?? ""
		let char = (attr(child, kAXMenuItemCmdCharAttribute) as? String) ?? ""
		let mods = (attr(child, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue ?? -1
		let here = title.isEmpty ? path : "\(path) > \(title)"
		if !title.isEmpty, depth >= 2 { print("\(here) [\(char) \(mods)]") }
		if depth < 5 { walk(child, here, depth + 1) }
	}
}
walk(bar as! AXUIElement, "", 0)
