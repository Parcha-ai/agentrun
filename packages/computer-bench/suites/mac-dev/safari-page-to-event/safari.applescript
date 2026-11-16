-- osascript -e <this file> <mode>
--   start     open a new Safari window on the invitation
--   teardown  close every Safari window whose current tab is on the run's folder
on run argv
	set mode to item 1 of argv
	tell application "Safari"
		if mode is "start" then
			activate
			make new document with properties {URL:"file:///tmp/computer-bench-{{nonce}}/invite.html"}
			return "opened"
		end if
		repeat with i from (count of windows) to 1 by -1
			try
				if (URL of current tab of window i) contains "/computer-bench-{{nonce}}/" then close window i
			end try
		end repeat
		return "closed"
	end tell
end run
