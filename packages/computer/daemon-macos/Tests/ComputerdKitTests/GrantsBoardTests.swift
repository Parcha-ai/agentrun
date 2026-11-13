import XCTest
@testable import ComputerdKit

/// The grants window's board: which pane opens when, and the one done once every grant is in.
final class GrantsBoardTests: XCTestCase {
	let accessibility = GrantsBoard.Pane(name: "Accessibility", anchor: "Privacy_Accessibility", grants: ["Accessibility", "Post Event"])
	let recording = GrantsBoard.Pane(name: "Screen & System Audio Recording", anchor: "Privacy_ScreenCapture", grants: ["Screen Recording"])

	func board() -> GrantsBoard { GrantsBoard(panes: [accessibility, recording]) }

	func testTheFirstLookOpensTheFirstPaneStillWaiting() {
		var b = board()
		XCTAssertEqual(b.observe([]), [.open(accessibility)])
		XCTAssertEqual(b.opened, "Privacy_Accessibility")

		var granted = board()
		XCTAssertEqual(granted.observe(["Accessibility", "Post Event"]), [.open(recording)])
	}

	func testAPaneWithOneGrantOfTwoStaysOpenAndNothingElseOpens() {
		var b = board()
		_ = b.observe([])
		XCTAssertEqual(b.observe([]), [], "a second look at the same grants does nothing")
		XCTAssertEqual(b.observe(["Accessibility"]), [], "the list gave one of its two grants: the person is still in it")
		XCTAssertTrue(b.isGranted("Accessibility"))
		XCTAssertFalse(b.isGranted(accessibility))
	}

	func testThePaneOpenedNextIsTheOneStillWaitingOnceTheOpenOneIsDone() {
		var b = board()
		_ = b.observe([])
		XCTAssertEqual(b.observe(["Accessibility", "Post Event"]), [.open(recording)])
		XCTAssertEqual(b.observe(["Accessibility", "Post Event"]), [])
		XCTAssertEqual(b.opened, "Privacy_ScreenCapture")
	}

	func testEveryGrantInIsDoneOnceAndOnlyOnce() {
		var b = board()
		_ = b.observe([])
		XCTAssertEqual(b.observe(["Accessibility", "Post Event", "Screen Recording"]), [.done])
		XCTAssertTrue(b.finished)
		XCTAssertTrue(b.allGranted)
		XCTAssertEqual(b.observe(["Accessibility", "Post Event", "Screen Recording"]), [])
		XCTAssertEqual(b.observe([]), [], "the window has closed: a grant taken back after it opens nothing")
	}

	func testEveryGrantInAtTheFirstLookIsDoneWithNoPaneOpened() {
		var b = board()
		XCTAssertEqual(b.observe(["Accessibility", "Post Event", "Screen Recording"]), [.done])
		XCTAssertNil(b.opened)
	}

	func testAGrantOutOfOrderLeavesThePersonWhereTheyAre() {
		var b = board()
		_ = b.observe([])
		// Screen Recording came first, while the Accessibility pane is open: that pane is still waiting.
		XCTAssertEqual(b.observe(["Screen Recording"]), [])
		XCTAssertEqual(b.waiting, accessibility)
	}

	func testAClickedTileIsTheOpenPane() {
		var b = board()
		_ = b.observe([])
		XCTAssertEqual(b.choose("Privacy_ScreenCapture"), recording)
		XCTAssertEqual(b.opened, "Privacy_ScreenCapture")
		XCTAssertEqual(b.observe(["Accessibility", "Post Event"]), [], "the clicked pane still waits")
		XCTAssertNil(b.choose("Privacy_Camera"))
	}

	func testAPaneOpensAtItsPrivacyAnchor() {
		XCTAssertEqual(recording.url, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
	}
}
