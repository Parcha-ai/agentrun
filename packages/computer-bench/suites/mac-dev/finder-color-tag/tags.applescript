-- osascript -e <this file> <mode>
-- Reads and writes Finder tags through NSURL's tag names, the same store Finder's tag menu writes.
--   target  the tags of "{{target}}", joined by ","
--   others  the tags of the folder's other two files, joined by ","
--   set     give "{{target}}" the tag "{{color}}"
use AppleScript version "2.4"
use framework "Foundation"
use scripting additions

on tagsOf(p)
	set u to current application's NSURL's fileURLWithPath:p
	set {ok, theTags} to u's getResourceValue:(reference) forKey:(current application's NSURLTagNamesKey) |error|:(missing value)
	if theTags is missing value then return ""
	set AppleScript's text item delimiters to ","
	set s to (theTags as list) as text
	set AppleScript's text item delimiters to ""
	return s
end tagsOf

on run argv
	set mode to item 1 of argv
	set d to (POSIX path of (path to documents folder)) & "computer-bench-{{nonce}}/"
	if mode is "target" then return tagsOf(d & "{{target}}")
	if mode is "set" then
		set u to current application's NSURL's fileURLWithPath:(d & "{{target}}")
		u's setResourceValue:{"{{color}}"} forKey:(current application's NSURLTagNamesKey) |error|:(missing value)
		return "tagged"
	end if
	set found to {}
	repeat with f in {"plan.txt", "budget.txt", "ideas.txt"}
		if (contents of f) is not "{{target}}" then
			set t to tagsOf(d & (contents of f))
			if t is not "" then set end of found to t
		end if
	end repeat
	set AppleScript's text item delimiters to ","
	return found as text
end run
