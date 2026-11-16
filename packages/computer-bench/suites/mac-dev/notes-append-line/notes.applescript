-- osascript -e <this file> <mode> [arg]
--   purge          delete every note titled "{{title}} {{nonce}}"; a delete only moves a note to Recently Deleted, so it
--                  runs again until none is left there either
--   start          make the note the task starts from: the title and three lines
--   count          how many notes with the title are live (not in Recently Deleted)
--   lines          the live note's non-empty lines, joined by "|"
--   append <text>  add a last line to the live note
on run argv
	set mode to item 1 of argv
	set wanted to "{{title}} {{nonce}}"
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
		if mode is "start" then
			make new note at folder "Notes" of default account with properties {body:"<div>" & wanted & "</div><div>passport</div><div>charger</div><div>socks</div>"}
			return "made"
		end if
		set live to {}
		repeat with x in (every note whose name is wanted)
			set theNote to contents of x
			if name of container of theNote is not "Recently Deleted" then set end of live to theNote
		end repeat
		if mode is "count" then return count of live
		if (count of live) is not 1 then return "(" & (count of live) & " notes)"
		set theNote to item 1 of live
		if mode is "append" then
			set body of theNote to (body of theNote) & "<div>" & (item 2 of argv) & "</div>"
			return "appended"
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
