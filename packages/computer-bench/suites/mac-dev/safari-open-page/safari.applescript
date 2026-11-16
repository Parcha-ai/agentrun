-- osascript -e <this file> <mode>
--   start     open a new Safari window on https://www.iana.org/
--   url       the URL of the front window's current tab
--   go        load {{page.url}} in the front window's current tab and give it time to commit
--   teardown  close every Safari window whose current tab is on iana.org
on run argv
	set mode to item 1 of argv
	tell application "Safari"
		if mode is "start" then
			activate
			make new document with properties {URL:"https://www.iana.org/"}
			return "opened"
		end if
		if mode is "url" then return URL of current tab of front window
		if mode is "go" then
			set URL of current tab of front window to "{{page.url}}"
			delay 5
			return URL of current tab of front window
		end if
		repeat with i from (count of windows) to 1 by -1
			try
				if (URL of current tab of window i) contains "iana.org" then close window i
			end try
		end repeat
		return "closed"
	end tell
end run
