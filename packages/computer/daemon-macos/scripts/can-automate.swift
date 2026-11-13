// Whether this process may send Apple events to each app, by bundle id, one line each: "<id> granted", "<id> denied",
// "<id> unasked" or "<id> not running". It never raises the consent prompt unless --ask is given; with --ask it raises
// it for each app not yet answered, for a person at the Mac to answer. mini-demos.py runs it through Computerd's exec.run,
// so the answer is Computerd's: the process an Automation grant names is the one that spawned osascript.
//
//     swift can-automate.swift [--ask] com.apple.iCal com.apple.Notes ...

import CoreServices
import Foundation

let ask = CommandLine.arguments.contains("--ask")
for id in CommandLine.arguments.dropFirst() where id != "--ask" {
	let target = NSAppleEventDescriptor(bundleIdentifier: id)
	let status = AEDeterminePermissionToAutomateTarget(target.aeDesc, typeWildCard, typeWildCard, ask)
	let words: String
	switch status {
	case noErr: words = "granted"
	case OSStatus(errAEEventNotPermitted): words = "denied"
	case OSStatus(errAEEventWouldRequireUserConsent): words = "unasked"
	case OSStatus(procNotFound): words = "not running"
	default: words = "status \(status)"
	}
	print("\(id) \(words)")
}
