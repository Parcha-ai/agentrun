-- osascript -e <this file> <mode>
--   start     the calendar "computer-bench {{nonce}}" exists and holds one event, "{{title}} {{nonce}}", tomorrow from
--             14:00 to 15:00, with no location
--   count     how many events of that calendar are titled "{{title}} {{nonce}}"
--   location  the one such event's location ("" when none), or "(N events)"
--   when      the one such event as "+<days from today>d HH:MM <length>m", or "all-day", or "(N events)"
--   place     set the event's location to "{{room}}"
--   teardown  delete the calendar and its events
on pad(n)
	if n < 10 then return "0" & n
	return n as text
end pad

on run argv
	set mode to item 1 of argv
	set calName to "computer-bench {{nonce}}"
	set wanted to "{{title}} {{nonce}}"
	if mode is "start" then
		set s to (current date) + 1 * days
		set time of s to 14 * hours
		tell application "Calendar"
			if not (exists calendar calName) then make new calendar with properties {name:calName}
			try
				delete (every event of calendar calName)
			end try
			tell calendar calName
				make new event at end of events with properties {summary:wanted, start date:s, end date:s + 1 * hours}
			end tell
		end tell
		return "ready"
	end if
	if mode is "teardown" then
		tell application "Calendar"
			if exists calendar calName then
				try
					delete (every event of calendar calName)
				end try
				delete calendar calName
			end if
		end tell
		return "clean"
	end if
	tell application "Calendar"
		if not (exists calendar calName) then return "(no calendar)"
		set found to (every event of calendar calName whose summary is wanted)
		if mode is "count" then return count of found
		if (count of found) is not 1 then return "(" & (count of found) & " events)"
		set e to item 1 of found
		if mode is "place" then
			set location of e to "{{room}}"
			return "placed"
		end if
		if mode is "location" then
			set loc to location of e
			if loc is missing value then return ""
			return loc
		end if
		set s to start date of e
		set f to end date of e
		set allDay to allday event of e
	end tell
	if allDay then return "all-day"
	set today to current date
	set time of today to 0
	set startDay to s - (time of s)
	set offsetDays to round ((startDay - today) / days)
	return "+" & offsetDays & "d " & pad(hours of s) & ":" & pad(minutes of s) & " " & ((f - s) div minutes) & "m"
end run
