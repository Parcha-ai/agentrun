-- osascript -e <this file> <mode> [html]
--   make <html>  (the oracle) make a note in the Notes folder of the default account, with this body
--   purge        delete every note made since setup (the time in /tmp/computer-bench-{{nonce}}/t0); a delete only moves
--                a note to Recently Deleted, so it runs again until none is left there either
on run argv
	set mode to item 1 of argv
	tell application "Notes"
		if mode is "make" then
			make new note at folder "Notes" of default account with properties {body:item 2 of argv}
			return "made"
		end if
	end tell
	set elapsed to (do shell script "t=$(cat /tmp/computer-bench-{{nonce}}/t0 2> /dev/null) || exit 0; echo $(( $(date +%s) - t ))")
	if elapsed is "" then return "no t0"
	set since to (current date) - (elapsed as integer)
	tell application "Notes"
		repeat 3 times
			set found to (every note whose creation date > since)
			if (count of found) is 0 then exit repeat
			repeat with x in found
				delete (contents of x)
			end repeat
		end repeat
	end tell
	return "purged"
end run
