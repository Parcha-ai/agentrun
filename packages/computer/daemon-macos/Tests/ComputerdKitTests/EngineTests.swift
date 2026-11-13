import Foundation
import XCTest
@testable import ComputerdKit

/// The ui group's rules over a fake OS: refs across states, compact and full views, diffs, the route ladder and its
/// refusals, points bound to their state, settle, and expect.
final class EngineTests: XCTestCase {
	var os: FakeOS!

	/// A Notes window at (100, 50), 800 by 600 points.
	override func setUp() {
		os = FakeOS()
		os.add(1, "window", name: "Notes", frame: Rect(100, 50, 800, 600))
		os.add(2, "group", frame: Rect(100, 50, 800, 600), parent: 1)
		os.add(3, "button", name: "Save", frame: Rect(120, 70, 80, 30), parent: 2, actions: ["AXPress", "AXShowMenu"])
		os.add(4, "textbox", name: "Title", value: "", frame: Rect(120, 120, 300, 30), parent: 2, settable: true, textInput: true)
		os.add(5, "text", name: "Hello", frame: Rect(120, 200, 100, 20), parent: 2)
		os.add(6, "group", frame: Rect(500, 300, 10, 10), parent: 1)
		os.add(7, "textbox", name: "Password", value: "hunter2", frame: Rect(120, 400, 200, 30), parent: 2, settable: true, textInput: true, flags: [.secure])
		os.add(8, "menuitem", name: "super+s", actions: ["AXPress"])
	}

	func node(_ r: UiObserveResult, _ name: String) -> UiNode? { r.nodes.first { $0.name == name } }

	func ref(_ r: UiObserveResult, _ name: String) -> String { node(r, name)!.ref }

	func stepError(_ result: UiActResult, _ i: Int) -> StepError? {
		if case .error(let e) = result.steps[i] { return e }
		return nil
	}

	func ran(_ result: UiActResult, _ i: Int) -> (Route, Bool)? {
		if case .ran(let route, let verified) = result.steps[i] { return (route, verified) }
		return nil
	}

	func throwsKind(_ kind: ErrorKind, _ body: () async throws -> some Any, file: StaticString = #filePath, line: UInt = #line) async -> String? {
		do {
			_ = try await body()
			XCTFail("it did not throw", file: file, line: line)
		} catch let e as RPCError {
			XCTAssertEqual(e.kind, kind, e.message, file: file, line: line)
			return e.message
		} catch {
			XCTFail("\(error)", file: file, line: line)
		}
		return nil
	}

	// MARK: observe

	func testCompactKeepsNamedAndActionableWithTheirParents() async throws {
		let r = try await os.engine().observe(UiObserveParams())
		XCTAssertEqual(r.state, "s1")
		XCTAssertEqual(r.app.id, "com.apple.Notes")
		XCTAssertEqual(r.window.bounds, Rect(100, 50, 800, 600))
		XCTAssertEqual(r.nodes.map(\.role), ["window", "group", "button", "textbox", "text", "textbox", "menuitem"])
		let save = node(r, "Save")!
		XCTAssertEqual(save.bounds, Rect(20, 20, 80, 30), "bounds are in window points")
		XCTAssertEqual(save.parent, r.nodes[1].ref)
		XCTAssertEqual(save.actions, ["AXPress", "AXShowMenu"])
		XCTAssertNil(node(r, "Password")!.value, "a secure field's value is never sent")
		XCTAssertEqual(node(r, "Password")!.flags, [.secure])
		XCTAssertEqual(node(r, "super+s")!.flags, [.offscreen], "no frame is offscreen")
		XCTAssertTrue(r.nodes.allSatisfy { isRef($0.ref) })
		XCTAssertFalse(r.truncated)
	}

	func testFullKeepsEverything() async throws {
		let r = try await os.engine().observe(UiObserveParams(full: true))
		XCTAssertEqual(r.nodes.count, 8)
	}

	func testRefsSurviveAcrossStatesAndDiffSays() async throws {
		let engine = os.engine()
		let first = try await engine.observe(UiObserveParams())
		let save = ref(first, "Save")
		let title = ref(first, "Title")
		os.add(9, "button", name: "Share", frame: Rect(300, 70, 80, 30), parent: 2, actions: ["AXPress"])
		os.with { $0.elements[5]!.name = "Hello there" }
		os.remove(4)
		let second = try await engine.observe(UiObserveParams(since: first.state))
		XCTAssertEqual(second.state, "s2")
		XCTAssertEqual(ref(second, "Save"), save)
		XCTAssertEqual(second.diff?.added, [ref(second, "Share")])
		XCTAssertEqual(second.diff?.changed, [ref(first, "Hello")])
		XCTAssertEqual(second.diff?.removed, [title])
	}

	func testImage() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams(image: .image(maxEdge: nil)))
		XCTAssertEqual(r.image?.format, "png")
		XCTAssertEqual(r.image?.width, 1568)
		XCTAssertEqual(r.image?.height, 1176)
		_ = await throwsKind(.limit) { try await engine.observe(UiObserveParams(image: .image(maxEdge: 100))) }
		os.screenRecording = false
		let words = await throwsKind(.unsupported) { try await engine.observe(UiObserveParams(image: .image(maxEdge: nil))) }
		XCTAssertTrue(words?.contains("Screen Recording") == true)
		_ = try await engine.observe(UiObserveParams())
	}

	func testWithoutTheTreeTheImageComesAndPointsStillWork() async throws {
		os.trusted = false
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		XCTAssertEqual(r.nodes, [])
		XCTAssertTrue(r.empty?.contains("ui.tree is off here: Accessibility") == true, r.empty ?? "no empty")
		XCTAssertEqual(r.image?.width, 1568, "the image comes unasked")
		XCTAssertEqual(r.window.id, "7")
		XCTAssertTrue(os.entries.contains("capture.resolve"))

		let act = try await engine.act(UiActParams(state: r.state, steps: [.click(.point(Point(10, 20)), button: nil, count: nil), .type("hi", into: nil)]))
		XCTAssertEqual(act.steps, [.ran(route: .background, verified: false), .ran(route: .background, verified: false)])
		XCTAssertEqual(os.entries.filter { $0.hasPrefix("bg.") }, ["bg.click 110,70 left 1", "bg.type hi"])

		let expect = await throwsKind(.unsupported) { try await engine.act(UiActParams(steps: [], expect: Expect(text: "hi"))) }
		XCTAssertTrue(expect?.contains("ui.tree is off") == true)

		os.screenRecording = false
		let both = await throwsKind(.denied) { try await engine.observe(UiObserveParams()) }
		XCTAssertTrue(both?.contains("Accessibility") == true && both?.contains("Screen Recording") == true, both ?? "")
	}

	func testWithoutTheTreeAPointIsStaleOnceTheImageChanged() async throws {
		os.trusted = false
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let click = Step.click(.point(Point(10, 20)), button: nil, count: nil)
		os.with { $0.frameHash = 1 }
		let changed = try await engine.act(UiActParams(state: r.state, steps: [click]))
		XCTAssertEqual(stepError(changed, 0)?.kind, .stale)
		XCTAssertTrue(stepError(changed, 0)?.message.contains("shows something else than at state s1") == true, stepError(changed, 0)?.message ?? "")
		XCTAssertEqual(os.entries.filter { $0.hasPrefix("bg.") }, [], "nothing was posted")
	}

	func testDescIsShownAndExpected() async throws {
		os.add(30, "listitem", name: "Wi-Fi", desc: "Connected, secured", frame: Rect(110, 300, 200, 40))
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		XCTAssertEqual(r.nodes.first { $0.name == "Wi-Fi" }?.desc, "Connected, secured")
		let act = try await engine.act(UiActParams(steps: [], expect: Expect(text: "Connected")))
		XCTAssertEqual(act.expect, .met)
	}

	func testPolicyLimitsApps() async {
		let engine = os.engine(policy: Policy(apps: ["com.apple.Safari"]))
		_ = await throwsKind(.denied) { try await engine.observe(UiObserveParams()) }
		_ = await throwsKind(.denied) { try await engine.observe(UiObserveParams(target: Target(app: "com.apple.Notes"))) }
	}

	func testUnknownAppIsNotFound() async {
		_ = await throwsKind(.notFound) { try await self.os.engine().observe(UiObserveParams(target: Target(app: "com.example.none"))) }
	}

	// MARK: act: the route ladder

	func testPressRunsSemanticAndVerifiesByChange() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		os.react = { entry, os in
			if entry == "ax.AXPress 3" { os.with { $0.elements[5]!.name = "Saved" } }
		}
		let result = try await engine.act(UiActParams(state: r.state, steps: [.press(ref(r, "Save"))], expect: Expect(text: "Saved")))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertEqual(result.expect, .met)
		XCTAssertTrue(result.changed)
		XCTAssertEqual(result.state, "s2")
		XCTAssertEqual(os.entries, ["ax.AXPress 3"])
	}

	func testPressWithoutAnActionClicksInTheBackground() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Hello"))]))
		XCTAssertEqual(ran(result, 0)?.0, .background)
		XCTAssertEqual(ran(result, 0)?.1, false, "nothing changed")
		XCTAssertFalse(result.changed)
		XCTAssertEqual(os.entries, ["bg.click 170,210 left 1"])
	}

	func testForegroundOnlyWhenTheCallAllowsIt() async throws {
		let engine = os.engine(background: .off("SkyLight's SLEventPostToPid is missing"))
		let r = try await engine.observe(UiObserveParams())
		let refused = try await engine.act(UiActParams(steps: [.press(ref(r, "Hello")), .press(ref(r, "Save"))]))
		XCTAssertEqual(refused.steps.count, 1, "a refused step is the last")
		XCTAssertEqual(stepError(refused, 0)?.kind, .denied, "the call can allow the one route left")
		let words = stepError(refused, 0)?.message ?? ""
		XCTAssertTrue(words.contains("semantic: \(ref(r, "Hello")) has no AXPress"), words)
		XCTAssertTrue(words.contains("background: ui.background is off here: SkyLight"), words)
		XCTAssertTrue(words.contains("foreground: it moves the user's pointer and focus, and this call does not allow it: pass foreground: true"), words)
		XCTAssertEqual(os.entries, [])
		let allowed = try await engine.act(UiActParams(steps: [.press(ref(r, "Hello"))], foreground: true))
		XCTAssertEqual(ran(allowed, 0)?.0, .foreground)
		XCTAssertEqual(os.entries, ["fg.click 170,210 left 1"])
	}

	func testForegroundOffForTheGrant() async throws {
		let engine = os.engine(background: .off("no SkyLight"), foreground: .off("Post Event is not granted"))
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Hello"))], foreground: true))
		XCTAssertEqual(stepError(result, 0)?.kind, .unsupported, "no route reaches it here")
		XCTAssertTrue(stepError(result, 0)?.message.contains("ui.foreground is off here: Post Event") == true)
	}

	func testSetReadsBack() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.set(ref(r, "Title"), value: "Groceries"), .set(ref(r, "Password"), value: "x"), .set(ref(r, "Hello"), value: "x"), .press(ref(r, "Save"))]))
		XCTAssertEqual(result.steps.count, 3)
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertEqual(ran(result, 1)?.1, false, "a secure field is never read back")
		XCTAssertEqual(stepError(result, 2)?.kind, .unsupported)
		XCTAssertTrue(stepError(result, 2)?.message.contains("cannot be set") == true)
		XCTAssertEqual(os.with { $0.elements[4]!.value }, "Groceries")
	}

	func testASetOnAnItemThatOpensSaysToRenameItByKeys() async throws {
		os.add(10, "listitem", name: "report.txt", frame: Rect(120, 450, 200, 20), parent: 2, actions: ["AXOpen", "AXShowMenu"])
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams(full: true))
		let result = try await engine.act(UiActParams(steps: [.set(ref(r, "report.txt"), value: "final.txt")]))
		XCTAssertEqual(stepError(result, 0)?.kind, .unsupported)
		XCTAssertEqual(stepError(result, 0)?.message, "no route could set here. semantic: report.txt is a list item that opens: select it and press Return to edit its name, then type")
	}

	func testPerformNamesThePlatformsAction() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.perform(ref(r, "Save"), action: "AXShowMenu"), .perform(ref(r, "Save"), action: "AXIncrement")]))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertTrue(stepError(result, 1)?.message.contains("it has AXPress, AXShowMenu") == true)
	}

	func testClickARefRightOpensItsMenuAndDoubleClicksByPointer() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let save = ref(r, "Save")
		_ = try await engine.act(UiActParams(steps: [.click(.ref(save), button: .right, count: 1), .click(.ref(save), button: nil, count: 2)]))
		XCTAssertEqual(os.entries, ["ax.AXShowMenu 3", "bg.click 160,85 left 2"])
	}

	func testTypeInsertsOrFocusesAndPosts() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.type("milk", into: ref(r, "Title")), .type("pw", into: ref(r, "Password"))]))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertEqual(ran(result, 1)?.0, .background)
		XCTAssertEqual(os.entries, ["ax.insert 4 milk", "ax.focus 7", "bg.type pw"])
	}

	/// A step on a disabled control, or a type into a ref that is no text field, is refused with nothing sent.
	func testStepsOnADisabledControlOrANonFieldAreRefused() async throws {
		os.add(11, "button", name: "Off", frame: Rect(120, 520, 50, 20), parent: 2, actions: ["AXPress"], flags: [.disabled])
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let pressed = try await engine.act(UiActParams(steps: [.press(ref(r, "Off"))]))
		XCTAssertEqual(stepError(pressed, 0)?.kind, .refused)
		let typed = try await engine.act(UiActParams(steps: [.type("x", into: ref(r, "Save"))]))
		XCTAssertEqual(stepError(typed, 0)?.kind, .refused)
		XCTAssertTrue(os.entries.isEmpty, "nothing was sent: \(os.entries)")
	}

	/// A field that did not take the focus is not typed into: the text would go to whatever has it.
	func testATypeIntoAFieldThatDidNotTakeTheFocusIsRefusedWithNothingTyped() async throws {
		os.with { $0.ignoresFocus = true }
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.type("pw", into: ref(r, "Password"))]))
		guard case .error(let error)? = result.steps.first else { return XCTFail("the step ran: \(result.steps)") }
		XCTAssertEqual(error.kind, .refused)
		XCTAssertFalse(os.entries.contains { $0.hasSuffix("type pw") }, "nothing was typed")
	}

	/// A document's text area (TextEdit's) takes an edit as one only by typed keys: they go first, and an insert only
	/// when the keys showed nothing.
	func testADocumentsTextTakesTypedKeysFirst() async throws {
		os.add(10, "textbox", name: "Body", value: "Pears: 41", frame: Rect(120, 450, 600, 100), parent: 2, settable: true, textInput: true)
		os.with { $0.elements[10]?.keysFirst = true }
		os.react = { entry, os in
			if entry == "bg.type 42" { os.with { $0.elements[10]?.value = "Pears: 42" } }
		}
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.type("42", into: ref(r, "Body"))]))
		XCTAssertEqual(ran(result, 0)?.0, .background)
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertEqual(os.entries.filter { !$0.hasPrefix("ax.focus") }, ["bg.type 42"])

		os.react = nil
		let r2 = try await engine.observe(UiObserveParams())
		let climbed = try await engine.act(UiActParams(steps: [.type(" more", into: ref(r2, "Body"))]))
		XCTAssertEqual(ran(climbed, 0)?.0, .semantic, "the keys showed nothing, so the insert went")
		XCTAssertEqual(ran(climbed, 0)?.1, true)
		XCTAssertEqual(os.entries.filter { $0.contains("more") }, ["bg.type  more", "ax.insert 10  more"])
	}

	func testKeyChoosesTheMenuItemThenPosts() async throws {
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.key("super+s"), .key("enter")]))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 1)?.0, .background)
		XCTAssertEqual(os.entries, ["ax.AXPress 8", "bg.key enter"])
	}

	func testNavIsOffOnTheMac() async throws {
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.nav(.back)]))
		XCTAssertEqual(stepError(result, 0)?.kind, .unsupported)
		XCTAssertTrue(stepError(result, 0)?.message.contains("ui.nav is off here") == true)
	}

	func testScrollAndDragPostScreenPoints() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		_ = try await engine.act(UiActParams(state: r.state, steps: [.scroll(.ref(ref(r, "Hello")), dx: nil, dy: 40), .drag([Point(400, 300), Point(450, 320)], ms: nil)]))
		XCTAssertEqual(os.entries, ["bg.scroll 170,210 0 40", "bg.drag 500,350 550,370 300"])
	}

	// MARK: act: refs and points

	func testAGoneRefIsStale() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		os.remove(3)
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))], expect: Expect(text: "Hello")))
		XCTAssertEqual(stepError(result, 0)?.kind, .stale)
		XCTAssertNil(result.expect, "no expect after a refused step")
	}

	func testARefPastTheWalksCapStillWorks() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		os.maxNodes = 2
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))]))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
	}

	func testAnUnknownRefFailsTheCall() async {
		let engine = os.engine()
		let words = await throwsKind(.invalid) { try await engine.act(UiActParams(steps: [.press("@e99")])) }
		XCTAssertTrue(words?.contains("observe first") == true)
	}

	func testAPointNeedsItsState() async throws {
		let engine = os.engine()
		_ = await throwsKind(.invalid) { try await engine.act(UiActParams(steps: [.click(.point(Point(70, 35)), button: nil, count: nil)])) }
		let result = try await engine.act(UiActParams(state: "s9", steps: [.click(.point(Point(70, 35)), button: nil, count: nil)]))
		XCTAssertEqual(stepError(result, 0)?.kind, .stale)
	}

	func testAPointLandsInTheWindowWhereverItIs() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let click = Step.click(.point(Point(70, 35)), button: nil, count: nil)
		_ = try await engine.act(UiActParams(state: r.state, steps: [click]))
		XCTAssertEqual(os.entries, ["bg.click 170,85 left 1"])
		// The window moved, and the whole tree with it: the point is the window's, so it follows.
		os.with { os in
			os.window.bounds = Rect(200, 100, 800, 600)
			for id in os.order { os.elements[id]!.frame = os.elements[id]!.frame?.offset(100, 50) }
		}
		_ = try await engine.act(UiActParams(state: r.state, steps: [click]))
		XCTAssertEqual(os.entries.last, "bg.click 270,135 left 1")
	}

	func testAPointIsStaleWhenTheWindowResizedOrWhatIsUnderItChanged() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let click = Step.click(.point(Point(70, 35)), button: nil, count: nil)
		os.with { $0.elements[3]!.name = "Saved" }
		let changed = try await engine.act(UiActParams(state: r.state, steps: [click]))
		XCTAssertEqual(stepError(changed, 0)?.kind, .stale)
		XCTAssertTrue(stepError(changed, 0)?.message.contains("changed since state s1") == true)
		os.with { $0.window.bounds = Rect(100, 50, 700, 600) }
		let resized = try await engine.act(UiActParams(state: r.state, steps: [click]))
		XCTAssertTrue(stepError(resized, 0)?.message.contains("changed size") == true)
		XCTAssertEqual(os.entries, [])
	}

	func testAPointOutsideTheWindowIsInvalid() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(state: r.state, steps: [.click(.point(Point(900, 10)), button: nil, count: nil)]))
		XCTAssertEqual(stepError(result, 0)?.kind, .invalid)
	}

	// MARK: act: checks, settle and expect

	func testActRefusesBadShapes() async {
		let engine = os.engine()
		_ = await throwsKind(.invalid) { try await engine.act(UiActParams(steps: [])) }
		_ = await throwsKind(.limit) { try await engine.act(UiActParams(steps: Array(repeating: .key("a"), count: 101))) }
		_ = await throwsKind(.limit) { try await engine.act(UiActParams(steps: [], expect: Expect(text: "x", timeoutMs: 60_001))) }
		_ = await throwsKind(.invalid) { try await engine.act(UiActParams(steps: [], expect: Expect(gone: true))) }
		_ = await throwsKind(.invalid) { try await engine.act(UiActParams(steps: [.key("cmd+s")])) }
		_ = await throwsKind(.limit) { try await engine.act(UiActParams(state: "s1", steps: [.drag([Point(1, 1), Point(2, 2)], ms: 300_001)])) }
	}

	func testExpectWaitsForALateChange() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		os.react = { entry, os in
			if entry == "ax.AXPress 3" { os.after(1200) { $0.add(9, "text", name: "Done", frame: Rect(120, 500, 50, 20), parent: 2) } }
		}
		let start = os.now
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))], expect: Expect(text: "Done", timeoutMs: 3000)))
		XCTAssertEqual(result.expect, .met)
		XCTAssertGreaterThanOrEqual(os.now - start, 1200)
		XCTAssertLessThan(os.now - start, 1600)
	}

	func testTheStateAfterAMetExpectIsTheSettledWindow() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		os.react = { entry, os in
			guard entry == "ax.AXPress 3" else { return }
			// "Done" shows mid-transition; the window is still changing 100 ms later.
			os.after(1200) { $0.add(9, "text", name: "Done", frame: Rect(120, 500, 50, 20), parent: 2) }
			os.after(1300) { $0.add(10, "text", name: "Later", frame: Rect(200, 500, 50, 20), parent: 2) }
		}
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))], expect: Expect(text: "Done", timeoutMs: 3000)))
		XCTAssertEqual(result.expect, .met)
		let since = try await engine.observe(UiObserveParams(since: result.state))
		XCTAssertEqual(since.diff, UiDiff(added: [], removed: [], changed: []), "the act's state already shows Later")
	}

	func testAClickOnARefWithNoPressSelectsIt() async throws {
		os.add(9, "image", name: "draft.txt", frame: Rect(200, 300, 64, 64), parent: 2)
		os.with { $0.elements[9]?.selectable = true }
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let result = try await engine.act(UiActParams(steps: [.click(.ref(ref(r, "draft.txt")), button: nil, count: nil)]))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 0)?.1, true, "the selection read back")
		XCTAssertTrue(os.entries.contains("ax.select 9"))
		XCTAssertFalse(os.entries.contains { $0.hasPrefix("bg.click") }, "no point while the element is reachable")
	}

	func testObservingAnAppFollowsAWindowItSwappedMidLook() async throws {
		os.swapAfterResolve = UiWindow(id: "8", title: "Notes", bounds: Rect(100, 50, 800, 600))
		let r = try await os.engine().observe(UiObserveParams(target: Target(app: "com.apple.Notes")))
		XCTAssertEqual(r.window.id, "8")
		os.swapAfterResolve = UiWindow(id: "9", title: "Notes", bounds: Rect(100, 50, 800, 600))
		_ = await throwsKind(.notFound) { try await self.os.engine().observe(UiObserveParams(target: Target(app: "com.apple.Notes", window: "8"))) }
	}

	func testAStepThatClosesItsWindowFollowsTheAppsNextWindow() async throws {
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		os.add(9, "menuitem", name: "super+w", actions: ["AXPress"])
		os.react = { entry, os in
			guard entry == "ax.AXPress 9" else { return }
			// Window 7 closes; window 8, the app's other one, is now its main window.
			os.with { os in
				os.window = UiWindow(id: "8", title: "Other", bounds: Rect(200, 80, 600, 400))
				os.elements[5]?.name = "Other note"
			}
		}
		let result = try await engine.act(UiActParams(steps: [.key("super+w"), .key("super+s")], expect: Expect(text: "Other note", timeoutMs: 1000)))
		XCTAssertEqual(ran(result, 0)?.0, .semantic)
		XCTAssertEqual(ran(result, 0)?.1, true, "the window it closed is gone: a change")
		XCTAssertNotNil(ran(result, 1), "the next step runs on the next window")
		XCTAssertEqual(result.expect, .met)
		let after = try await engine.observe(UiObserveParams(since: result.state))
		XCTAssertEqual(after.window.id, "8", "the act's state is the next window's")
	}

	func testAStepThatClosesTheLastWindowIsNotFoundInWords() async throws {
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		os.add(9, "menuitem", name: "super+w", actions: ["AXPress"])
		os.react = { entry, os in
			if entry == "ax.AXPress 9" { os.with { $0.hasWindow = false } }
		}
		let message = await throwsKind(.notFound) { try await engine.act(UiActParams(steps: [.key("super+w")])) }
		XCTAssertTrue(message?.contains("has no window left: the step closed window 7") == true, message ?? "")
	}

	func testExpectUnmetAfterItsTimeout() async throws {
		let engine = os.engine()
		let start = os.now
		let result = try await engine.act(UiActParams(steps: [], expect: Expect(text: "Nope", timeoutMs: 500)))
		XCTAssertEqual(result.expect, .unmet)
		XCTAssertGreaterThanOrEqual(os.now - start, 500)
		XCTAssertTrue(result.steps.isEmpty)
	}

	func testExpectRefTextAndGone() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let hello = ref(r, "Hello")
		var result = try await engine.act(UiActParams(steps: [], expect: Expect(text: "Hell", ref: hello, timeoutMs: 0)))
		XCTAssertEqual(result.expect, .met)
		result = try await engine.act(UiActParams(steps: [], expect: Expect(text: "Save", ref: hello, timeoutMs: 0)))
		XCTAssertEqual(result.expect, .unmet, "both: that element holds the text")
		os.after(200) { $0.remove(5) }
		result = try await engine.act(UiActParams(steps: [], expect: Expect(ref: hello, gone: true, timeoutMs: 1000)))
		XCTAssertEqual(result.expect, .met)
		result = try await engine.act(UiActParams(steps: [], expect: Expect(text: "hunter2", timeoutMs: 0)))
		XCTAssertEqual(result.expect, .unmet, "a secure field's value never matches")
		result = try await engine.act(UiActParams(steps: [], expect: Expect(text: "save", timeoutMs: 0)))
		XCTAssertEqual(result.expect, .unmet, "text matches with its case")
	}

	func testSettleWaitsForQuietButNotForever() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		// A window whose tree changes for 600 ms after the press, then holds still.
		os.react = { entry, os in
			guard entry == "ax.AXPress 3" else { return }
			for t in stride(from: 100.0, through: 600, by: 100) { os.after(t) { $0.elements[2]?.value = "\(t)" } }
		}
		var start = os.now
		_ = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))]))
		XCTAssertGreaterThanOrEqual(os.now - start, 600)
		XCTAssertLessThan(os.now - start, 1000)
		// One that never holds still: the act answers after maxSettleMs.
		os.react = { entry, os in
			guard entry == "ax.AXPress 3" else { return }
			for t in stride(from: 50.0, through: 10_000, by: 50) { os.after(t) { $0.elements[2]?.value = "\(t)" } }
		}
		start = os.now
		_ = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))]))
		XCTAssertLessThanOrEqual(os.now - start, Double(Limits.maxSettleMs) + 200)
	}

	func testASetTheAppThrowsAwayIsNotVerified() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		// Finder's name field outside rename mode: it shows the new name, settles, then goes back to the old one.
		os.react = { entry, os in
			guard entry.hasPrefix("ax.set 4") else { return }
			os.after(400) { $0.elements[4]?.value = "" }
		}
		let thrown = try await engine.act(UiActParams(steps: [.set(ref(r, "Title"), value: "final.txt")]))
		XCTAssertEqual(ran(thrown, 0)?.0, .semantic)
		XCTAssertEqual(ran(thrown, 0)?.1, false, "the value did not last")
		os.react = nil
		let kept = try await engine.act(UiActParams(steps: [.set(ref(r, "Title"), value: "kept")]))
		XCTAssertEqual(ran(kept, 0)?.1, true)
	}

	/// A menu item that does nothing when pressed; its key, posted, goes back a page.
	func backMenuItemThatDoesNothing() {
		os.add(9, "menuitem", name: "super+[", actions: ["AXPress"])
		os.react = { entry, os in
			guard entry == "bg.key super+[" || entry == "fg.key super+[" else { return }
			os.with { $0.elements[5]?.name = "Quarterly report" }
		}
	}

	func testAStepThatShowsNothingClimbsToTheNextRouteWhileTheExpectWaits() async throws {
		backMenuItemThatDoesNothing()
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		let start = os.now
		let result = try await engine.act(UiActParams(steps: [.key("super+[")], expect: Expect(text: "Quarterly report", timeoutMs: 10_000)))
		XCTAssertEqual(ran(result, 0)?.0, .background, "the menu item showed nothing, so the keys went")
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertEqual(result.expect, .met)
		XCTAssertLessThan(os.now - start, 2000, "no wait for the expect's timeout")
		XCTAssertEqual(os.entries.filter { $0.contains("key") || $0.hasPrefix("ax.AXPress") }, ["ax.AXPress 9", "bg.key super+["])
	}

	func testKeysGoTheForegroundWayFirstWhenAllowedAndTheAppIsInFront() async throws {
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		os.react = { entry, os in
			if entry.hasSuffix(".key enter") { os.with { $0.elements[5]?.name = "Renaming" } }
		}
		os.with { $0.frontPID = 42 }
		let front = try await engine.act(UiActParams(steps: [.key("enter")], foreground: true))
		XCTAssertEqual(ran(front, 0)?.0, .foreground)
		let r = try await engine.observe(UiObserveParams())
		let click = try await engine.act(UiActParams(state: r.state, steps: [.click(.point(Point(30, 30)), button: nil, count: nil)], foreground: true))
		XCTAssertEqual(ran(click, 0)?.0, .background, "a pointer step keeps the background way first")
		os.with { $0.elements[5]?.name = "Hello" }
		let alone = try await engine.act(UiActParams(steps: [.key("enter")]))
		XCTAssertEqual(ran(alone, 0)?.0, .background, "in front, but foreground not allowed")
		os.with { $0.frontPID = 7 }
		os.with { $0.elements[5]?.name = "Hello" }
		let behind = try await engine.act(UiActParams(steps: [.key("enter")], foreground: true))
		XCTAssertEqual(ran(behind, 0)?.0, .background, "another app in front: the background way first")
	}

	func testAStepThatShowsNothingStaysPutWithNoExpectOrNoRouteAllowed() async throws {
		backMenuItemThatDoesNothing()
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		let alone = try await engine.act(UiActParams(steps: [.key("super+[")]))
		XCTAssertEqual(ran(alone, 0)?.0, .semantic, "no expect: nothing says the step is still to do")
		XCTAssertEqual(ran(alone, 0)?.1, false)
		XCTAssertFalse(os.entries.contains("bg.key super+["))

		// The background route shows nothing either; the foreground one is not allowed, so the step ends unverified.
		os.react = nil
		let result = try await engine.act(UiActParams(steps: [.key("super+[")], expect: Expect(text: "Quarterly report", timeoutMs: 1000)))
		XCTAssertEqual(ran(result, 0)?.0, .background)
		XCTAssertEqual(ran(result, 0)?.1, false)
		XCTAssertEqual(result.expect, .unmet)
		XCTAssertFalse(os.entries.contains("fg.key super+["), "foreground: true was not passed")

		// With foreground allowed, it climbs there.
		os.react = { entry, os in
			if entry == "fg.key super+[" { os.with { $0.elements[5]?.name = "Quarterly report" } }
		}
		let front = try await engine.act(UiActParams(steps: [.key("super+[")], expect: Expect(text: "Quarterly report", timeoutMs: 10_000), foreground: true))
		XCTAssertEqual(ran(front, 0)?.0, .foreground)
		XCTAssertEqual(ran(front, 0)?.1, true)
		XCTAssertEqual(front.expect, .met)
	}

	func testASlowEffectIsWaitedForNotRepeatedOnTheNextRoute() async throws {
		backMenuItemThatDoesNothing()
		let engine = os.engine()
		_ = try await engine.observe(UiObserveParams())
		// The background key lands, and its effect shows 300 ms after the quiet settle looked.
		os.react = { entry, os in
			if entry == "bg.key super+[" { os.after(300) { $0.elements[5]?.name = "Quarterly report" } }
		}
		let result = try await engine.act(UiActParams(steps: [.key("super+[")], expect: Expect(text: "Quarterly report", timeoutMs: 10_000), foreground: true))
		XCTAssertEqual(ran(result, 0)?.0, .background)
		XCTAssertEqual(ran(result, 0)?.1, true)
		XCTAssertFalse(os.entries.contains("fg.key super+["), "the slow effect was waited for, so the step was not done a second time")
	}

	func testARedrawAloneNeitherHoldsASettleNorVerifiesAStep() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		// A blinking caret: the window's image changes every 50 ms, and its tree never does.
		os.react = { entry, os in
			guard entry == "ax.AXPress 3" else { return }
			for t in stride(from: 50.0, through: 10_000, by: 50) { os.after(t) { $0.frameHash += 1 } }
		}
		let start = os.now
		let result = try await engine.act(UiActParams(steps: [.press(ref(r, "Save"))]))
		XCTAssertLessThan(os.now - start, 500, "the tree held still, so the settle did")
		XCTAssertEqual(ran(result, 0)?.1, false, "a redraw is not the step's effect")
		XCTAssertFalse(result.changed)
	}

	func testCallsRunOneAtATime() async throws {
		let engine = os.engine()
		let r = try await engine.observe(UiObserveParams())
		let save = ref(r, "Save")
		async let a = engine.act(UiActParams(steps: [.press(save), .key("enter")]))
		async let b = engine.act(UiActParams(steps: [.key("tab"), .key("space")]))
		_ = try await (a, b)
		let log = os.entries
		XCTAssertEqual(log.count, 4)
		let first = log.firstIndex(of: "ax.AXPress 3")!
		XCTAssertTrue(log[first + 1] == "bg.key enter", "\(log)")
	}

	// MARK: the driver

	func testFeaturesSayWhy() {
		let driver = Driver(platform: os.platform(background: .off("SkyLight is missing")), policy: Policy(), machine: MachineInfo(os: "macos", osVersion: "26.1 (25B78)", device: Device(maker: "Apple", model: "MacBook Pro")))
		var f = driver.features()
		XCTAssertEqual(f["ui.tree"], .on)
		XCTAssertEqual(f["ui.image"], .on)
		XCTAssertEqual(f["ui.background"], .off("SkyLight is missing"))
		XCTAssertEqual(f["apps.background"], .on)
		XCTAssertEqual(Set(f.keys), Set(FeatureName.all))
		os.trusted = false
		f = driver.features()
		XCTAssertEqual(f["ui.tree"], .off("Accessibility is not granted to Computerd"))
		XCTAssertEqual(f["ui.image"], .on, "the image does not need the tree")
		XCTAssertEqual(f["ui.foreground"], .on)
		let hello = driver.hello()
		XCTAssertEqual(hello.device, Device(maker: "Apple", model: "MacBook Pro"))
		XCTAssertEqual(hello.protocol, "0.2")
		XCTAssertEqual(hello.groups, [.exec, .files, .screen, .inputPointer, .inputKeys, .apps, .ui])
		XCTAssertEqual(hello.screen, ScreenInfo(width: 1440, height: 900, scale: 2))
	}

	func testDriverAppsHonorThePolicy() async throws {
		let driver = Driver(platform: os.platform(), policy: Policy(apps: ["com.apple.Notes"]), machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
		let r = driver.router()
		let list = try await r.handler("apps.list")!(nil)
		XCTAssertEqual(list, .object(["apps": .array([.object(["id": .string("com.apple.Notes"), "name": .string("Notes")])]), "foreground": .null]))
		_ = try await r.handler("apps.launch")!(.object(["id": .string("com.apple.Notes"), "background": .bool(true)]))
		XCTAssertEqual(os.entries, ["launch com.apple.Notes - true"])
		_ = await throwsKind(.denied) { try await r.handler("apps.launch")!(.object(["id": .string("com.apple.Safari")])) }
		_ = await throwsKind(.invalid) { try await r.handler("apps.terminate")!(.object(["id": .string("com.apple.Notes"), "background": .bool(true)])) }
	}

	func testScreenShotIsChunked() async throws {
		let driver = Driver(platform: os.platform(), policy: Policy(), machine: MachineInfo(os: "macos", osVersion: nil, device: nil))
		let r = driver.router()
		let shot = try await r.handler("screen.shot")!(nil)
		XCTAssertEqual(shot["eof"], .bool(false))
		XCTAssertEqual(shot["width"], .int(2880))
		let id = shot["id"]!
		let rest = try await r.handler("screen.read")!(.object(["id": id, "offset": .int(Int64(Limits.maxChunkBytes))]))
		XCTAssertEqual(rest["eof"], .bool(true))
		_ = await throwsKind(.notFound) { try await r.handler("screen.read")!(.object(["id": id, "offset": .int(0)])) }
	}
}
