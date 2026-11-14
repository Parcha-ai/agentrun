-- osascript -e <this file> <mode>
--   purge  delete every note titled "{{art.title}} {{nonce}}"; a delete only moves a note to Recently Deleted, so it
--          runs again until none is left there either
--   seed   make the note: its title, then an empty line before each of its two paragraphs
--   label  (the oracle) write "Paragraph 1" and "Paragraph 2" into those empty lines
--   lines  the live note's non-empty lines, joined by "|"
on run argv
	set mode to item 1 of argv
	set wanted to "{{art.title}} {{nonce}}"
	set p1 to "{{art.p1}}"
	set p2 to "{{art.p2}}"
	tell application "Notes"
		if mode is "purge" then
			repeat 3 times
				set found to (every note whose name is wanted)
				if (count of found) is 0 then exit repeat
				repeat with x in found
					delete (contents of x)
				end repeat
			end repeat
			return "purged"
		end if
		if mode is "seed" then
			make new note at folder "Notes" of default account with properties {body:my page(wanted, "", p1, "", p2)}
			return "made"
		end if
		set live to {}
		repeat with x in (every note whose name is wanted)
			set theNote to contents of x
			if name of container of theNote is not "Recently Deleted" then set end of live to theNote
		end repeat
		if (count of live) is not 1 then return "(" & (count of live) & " notes)"
		set theNote to item 1 of live
		if mode is "label" then
			set body of theNote to my page(wanted, "Paragraph 1", p1, "Paragraph 2", p2)
			return "labelled"
		end if
		set txt to plaintext of theNote
	end tell
	set kept to {}
	repeat with p in paragraphs of txt
		if (contents of p) is not "" then set end of kept to (contents of p)
	end repeat
	set AppleScript's text item delimiters to "|"
	return kept as text
end run

-- The note's HTML: the title as a heading, then each paragraph after a line that holds its label, or is empty.
on page(theTitle, label1, para1, label2, para2)
	return "<div><h1>" & theTitle & "</h1></div>" & my slot(label1) & "<div>" & para1 & "</div>" & my slot(label2) & "<div>" & para2 & "</div>"
end page

on slot(label)
	if label is "" then return "<div><br></div>"
	return "<div>" & label & "</div>"
end slot
