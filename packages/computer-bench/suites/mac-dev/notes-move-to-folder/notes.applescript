-- osascript -e <this file> <mode>
--   start     no note titled "{{title}} {{nonce}}" is left (in Recently Deleted either); the folder "{{folder}} {{nonce}}"
--             exists and is empty; the note is made in the Notes folder
--   where     the folder of the live note (not in Recently Deleted), or "(N notes)" when there isn't exactly one
--   lines     the live note's non-empty lines, joined by "|"
--   move      move the live note into the folder
--   teardown  delete the note (again from Recently Deleted) and the folder
on purgeNotes(wanted)
	tell application "Notes"
		repeat 3 times
			set found to (every note whose name is wanted)
			if (count of found) is 0 then exit repeat
			repeat with x in found
				delete (contents of x)
			end repeat
		end repeat
	end tell
end purgeNotes

on run argv
	set mode to item 1 of argv
	set wanted to "{{title}} {{nonce}}"
	set folderName to "{{folder}} {{nonce}}"
	if mode is "start" then
		purgeNotes(wanted)
		tell application "Notes"
			tell default account
				if not (exists folder folderName) then make new folder with properties {name:folderName}
				make new note at folder "Notes" with properties {body:"<div>" & wanted & "</div><div>filed by computer-bench</div>"}
			end tell
		end tell
		return "ready"
	end if
	if mode is "teardown" then
		purgeNotes(wanted)
		tell application "Notes"
			tell default account
				if exists folder folderName then delete folder folderName
			end tell
		end tell
		purgeNotes(wanted)
		return "clean"
	end if
	tell application "Notes"
		set live to {}
		repeat with x in (every note whose name is wanted)
			set theNote to contents of x
			if name of container of theNote is not "Recently Deleted" then set end of live to theNote
		end repeat
		if (count of live) is not 1 then return "(" & (count of live) & " notes)"
		set theNote to item 1 of live
		if mode is "where" then return name of container of theNote
		if mode is "move" then
			move theNote to folder folderName of default account
			return "moved"
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
