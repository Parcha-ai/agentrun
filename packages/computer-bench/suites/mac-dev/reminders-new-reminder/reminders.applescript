-- osascript -e <this file> <mode>
--   start     the list "computer-bench {{nonce}}" exists and holds no reminders
--   count     how many reminders of that list are named "{{item}} {{nonce}}"
--   priority  the one such reminder's priority (0 none, 1 high, 5 medium, 9 low), "completed" when it is ticked off,
--             or "(N reminders)"
--   make      make the reminder the task asks for
--   teardown  delete the list and its reminders
on run argv
	set mode to item 1 of argv
	set listName to "computer-bench {{nonce}}"
	set wanted to "{{item}} {{nonce}}"
	tell application "Reminders"
		if mode is "start" then
			if not (exists list listName) then make new list with properties {name:listName}
			try
				delete (every reminder of list listName)
			end try
			return "ready"
		end if
		if mode is "teardown" then
			if exists list listName then delete list listName
			return "clean"
		end if
		if mode is "make" then
			tell list listName to make new reminder with properties {name:wanted, priority:{{prio.set}}}
			return "made"
		end if
		if not (exists list listName) then return "(no list)"
		set found to (every reminder of list listName whose name is wanted)
		if mode is "count" then return count of found
		if (count of found) is not 1 then return "(" & (count of found) & " reminders)"
		set r to item 1 of found
		if completed of r then return "completed"
		return (priority of r) as text
	end tell
end run
