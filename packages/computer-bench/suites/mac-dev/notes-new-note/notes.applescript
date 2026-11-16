-- osascript -e <this file> <mode> [arg]
--   purge        delete every note titled "{{title}} {{nonce}}"; a delete only moves a note to Recently Deleted, so it
--                runs again until none is left there either
--   count        how many notes with the title are live (not in Recently Deleted)
--   lines        the live note's non-empty lines, joined by "|"
--   make <html>  make a note in the Notes folder of the default account, with this body
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
		if mode is "make" then
			make new note at folder "Notes" of default account with properties {body:item 2 of argv}
			return "made"
		end if
		set live to {}
		repeat with x in (every note whose name is wanted)
			set theNote to contents of x
			if name of container of theNote is not "Recently Deleted" then set end of live to theNote
		end repeat
		if mode is "count" then return count of live
		if (count of live) is not 1 then return "(" & (count of live) & " notes)"
		set txt to plaintext of (item 1 of live)
	end tell
	set kept to {}
	repeat with p in paragraphs of txt
		if (contents of p) is not "" then set end of kept to (contents of p)
	end repeat
	set AppleScript's text item delimiters to "|"
	return kept as text
end run
