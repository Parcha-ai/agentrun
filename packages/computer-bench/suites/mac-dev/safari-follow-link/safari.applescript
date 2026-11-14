-- osascript -e <this file> <mode>
--   start     open a new Safari window on the local site's index
--   url       the URL of the front window's current tab
--   go        load the city's page in the front window's current tab
--   teardown  close every Safari window whose current tab is on the local site
on run argv
	set mode to item 1 of argv
	set site to "file:///tmp/computer-bench-{{nonce}}/"
	tell application "Safari"
		if mode is "start" then
			activate
			make new document with properties {URL:site & "index.html"}
			return "opened"
		end if
		if mode is "url" then return URL of current tab of front window
		if mode is "go" then
			set URL of current tab of front window to site & "{{city.file}}"
			delay 2
			return URL of current tab of front window
		end if
		repeat with i from (count of windows) to 1 by -1
			try
				if (URL of current tab of window i) contains "/computer-bench-{{nonce}}/" then close window i
			end try
		end repeat
		return "closed"
	end tell
end run
