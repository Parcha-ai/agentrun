-- Close, without saving, every TextEdit document whose file is in the folder computer-bench-{{nonce}}. Leaves TextEdit
-- alone when it is not running.
if application id "com.apple.TextEdit" is running then
	tell application id "com.apple.TextEdit"
		repeat with i from (count of documents) to 1 by -1
			try
				if (path of document i) contains "/computer-bench-{{nonce}}/" then close document i saving no
			end try
		end repeat
	end tell
end if
return "closed"
