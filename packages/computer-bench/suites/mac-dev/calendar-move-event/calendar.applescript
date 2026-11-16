-- osascript -e <this file> <mode>
--   start     the calendar "computer-bench {{nonce}}" exists and holds one event, "{{title}} {{nonce}}", the day after
--             tomorrow from 10:00 to 11:00
--   count     how many events of that calendar are titled "{{title}} {{nonce}}"
--   when      the one such event as "+<days from today>d HH:MM <length>m", or "all-day", or "(N events)"
--   move      move the event to {{slot.say}} the same day, an hour long
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
		set s to (current date) + 2 * days
		set time of s to 10 * hours
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
	if mode is "move" then
		set ns to (current date) + 2 * days
		set time of ns to {{slot.h}} * hours + {{slot.m}} * minutes
		tell application "Calendar"
			set e to first event of calendar calName whose summary is wanted
			-- keep the start before the end at every step
			if ns > (start date of e) then
				set end date of e to ns + 1 * hours
				set start date of e to ns
			else
				set start date of e to ns
				set end date of e to ns + 1 * hours
			end if
		end tell
		return "moved"
	end if
	tell application "Calendar"
		if not (exists calendar calName) then return "(no calendar)"
		set found to (every event of calendar calName whose summary is wanted)
		if mode is "count" then return count of found
		if (count of found) is not 1 then return "(" & (count of found) & " events)"
		set e to item 1 of found
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
