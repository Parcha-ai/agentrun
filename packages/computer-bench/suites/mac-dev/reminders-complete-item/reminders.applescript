-- osascript -e <this file> <mode>
--   start        the list "computer-bench {{nonce}}" exists and holds exactly four open reminders
--   target-done  how many reminders named "{{item}}" are completed
--   others-done  how many other reminders of the list are completed
--   total        how many reminders the list holds, completed or not
--   complete     tick off "{{item}}"
--   teardown     delete the list and its reminders
on run argv
	set mode to item 1 of argv
	set listName to "computer-bench {{nonce}}"
	set wanted to "{{item}}"
	tell application "Reminders"
		if mode is "start" then
			if not (exists list listName) then make new list with properties {name:listName}
			try
				delete (every reminder of list listName)
			end try
			tell list listName
				repeat with n in {"Buy stamps", "Return library books", "Email the landlord", "Charge the camera"}
					make new reminder with properties {name:(contents of n)}
				end repeat
			end tell
			return "ready"
		end if
		if mode is "teardown" then
			if exists list listName then delete list listName
			return "clean"
		end if
		if not (exists list listName) then return "(no list)"
		if mode is "complete" then
			set completed of (first reminder of list listName whose name is wanted) to true
			return "completed"
		end if
		if mode is "target-done" then return count of (every reminder of list listName whose name is wanted and completed is true)
		if mode is "others-done" then return count of (every reminder of list listName whose name is not wanted and completed is true)
		return count of (every reminder of list listName)
	end tell
end run
