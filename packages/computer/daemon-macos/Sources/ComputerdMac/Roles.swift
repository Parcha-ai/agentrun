#if os(macOS)

/// AppKit's accessibility roles and subroles mapped onto the protocol's (ARIA's) names. What is not here is generic.
enum Roles {
	static let bySubrole: [String: String] = [
		"AXDialog": "dialog", "AXSystemDialog": "dialog", "AXFloatingWindow": "window", "AXStandardWindow": "window",
		"AXSearchField": "searchbox", "AXSecureTextField": "textbox",
		"AXSwitch": "switch", "AXToggle": "switch",
		"AXTabButton": "tab",
		"AXOutlineRow": "row", "AXTableRow": "row",
		"AXTextLink": "link",
	]

	static let byRole: [String: String] = [
		"AXWindow": "window", "AXSheet": "dialog", "AXDrawer": "dialog",
		"AXMenu": "menu", "AXMenuBar": "menu",
		"AXMenuItem": "menuitem", "AXMenuBarItem": "menuitem",
		"AXToolbar": "toolbar",
		"AXButton": "button", "AXPopUpButton": "button", "AXMenuButton": "button", "AXDisclosureTriangle": "button",
		"AXLink": "link",
		"AXTextField": "textbox", "AXTextArea": "textbox",
		"AXCheckBox": "checkbox", "AXRadioButton": "radio",
		"AXSlider": "slider", "AXIncrementor": "slider",
		"AXComboBox": "combobox",
		"AXProgressIndicator": "progressbar", "AXBusyIndicator": "progressbar", "AXLevelIndicator": "progressbar",
		"AXList": "list",
		"AXTable": "table", "AXOutline": "table", "AXBrowser": "table",
		"AXRow": "row", "AXCell": "cell",
		"AXScrollArea": "scrollarea", "AXWebArea": "scrollarea",
		"AXImage": "image",
		"AXStaticText": "text",
		"AXHeading": "heading",
		"AXGroup": "group", "AXSplitGroup": "group", "AXRadioGroup": "group", "AXTabGroup": "group", "AXLayoutArea": "group",
	]

	/// A window's role, as UiWindow.role sends it: "dialog" for a sheet, an alert or a panel (a floating window), and
	/// nil, which means "window", for any other.
	static func window(role: String?, subrole: String?) -> String? {
		if role == "AXSheet" || role == "AXDrawer" { return "dialog" }
		switch subrole {
		case "AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow": return "dialog"
		default: return nil
		}
	}

	/// The protocol's role for an element; a list's children are its items.
	static func map(role: String?, subrole: String?, parentRole: String?) -> String {
		if let subrole, let mapped = bySubrole[subrole] { return mapped }
		guard let role else { return "generic" }
		if parentRole == "list", role == "AXGroup" || role == "AXStaticText" { return "listitem" }
		return byRole[role] ?? "generic"
	}

	/// A window's title-bar buttons, by subrole: AppKit gives them no title and no description.
	static let titleBarButtons: [String: String] = [
		"AXCloseButton": "Close", "AXMinimizeButton": "Minimize", "AXZoomButton": "Zoom", "AXFullScreenButton": "Full Screen",
	]

	/// An element's name: its title, else its description, else what its subrole says it is (a title-bar button).
	static func name(title: String?, description: String?, subrole: String?) -> String? {
		title ?? description ?? subrole.flatMap { titleBarButtons[$0] }
	}

	/// The roles that take typed text.
	static let textInput: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

	/// The roles whose value is on or off.
	static let toggles: Set<String> = ["checkbox", "radio", "switch"]
}
#endif
