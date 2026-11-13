// Whether this process may send Apple events to each app, by bundle id, one line each: "<id> granted", "<id> denied",
// "<id> unasked" or "<id> not running". Then one line for calendar data, "calendars granted|denied|unasked|write
// only": Calendar's AppleScript reads the calendar store for the process that sent the event, so a script that counts
// events needs this grant too. Neither check raises a consent prompt unless --ask is given; with --ask each one not yet
// answered raises its prompt, for a person at the Mac to answer. mini-demos.py runs it through Computerd's exec.run, so
// the answers are Computerd's: a grant names the process responsible for this one, which is the one that spawned it.
//
//     swift can-automate.swift [--ask] com.apple.iCal com.apple.Notes ...

import CoreServices
import EventKit
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

func calendars() -> String {
	switch EKEventStore.authorizationStatus(for: .event) {
	case .fullAccess: return "granted"
	case .writeOnly: return "write only"
	case .denied, .restricted: return "denied"
	case .notDetermined: return "unasked"
	@unknown default: return "unknown"
	}
}

if ask && EKEventStore.authorizationStatus(for: .event) == .notDetermined {
	let done = DispatchSemaphore(value: 0)
	EKEventStore().requestFullAccessToEvents { _, _ in done.signal() }
	_ = done.wait(timeout: .now() + 300)
}
print("calendars \(calendars())")
