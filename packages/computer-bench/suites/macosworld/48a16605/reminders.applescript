-- osascript -e <this file> <mode> [name...]
--   names         the names of reminders made since setup (the time in /tmp/computer-bench-{{nonce}}/t0), in any list,
--                 that are not completed, one per line
--   make <name>…  (the oracle) make a reminder of each name in the default list
--   purge         delete every reminder made since setup
on run argv
	set mode to item 1 of argv
	if mode is "make" then
		tell application "Reminders"
			repeat with i from 2 to count of argv
				tell default list to make new reminder with properties {name:(item i of argv)}
			end repeat
		end tell
		return "made"
	end if
	set elapsed to (do shell script "t=$(cat /tmp/computer-bench-{{nonce}}/t0 2> /dev/null) || exit 0; echo $(( $(date +%s) - t ))")
	if elapsed is "" then return ""
	set since to (current date) - (elapsed as integer)
	tell application "Reminders"
		if mode is "purge" then
			repeat with x in (every reminder whose creation date > since)
				delete (contents of x)
			end repeat
			return "purged"
		end if
		set found to name of (every reminder whose creation date > since and completed is false)
	end tell
	set AppleScript's text item delimiters to linefeed
	return found as text
end run
