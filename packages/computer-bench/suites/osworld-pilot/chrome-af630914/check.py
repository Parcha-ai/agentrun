# OSWorld read Chrome's default font size and passed one above 16 (check_font_size, range 16 to 99999, both open).
# Firefox's default font size is font.size.variable.x-western in the profile's prefs.js, absent while it is the default,
# 16; Firefox writes prefs.js about half a second after a change.
import json
import re
import sys
import time

time.sleep(3)
try:
    with open("/tmp/computer-bench-{{nonce}}/profile/prefs.js", encoding="utf-8") as f:
        prefs = dict(re.findall(r'^user_pref\("([^"]+)",\s*(.*)\);$', f.read(), re.M))
except OSError as error:
    print("no prefs.js: " + str(error))
    sys.exit(1)
size = json.loads(prefs.get("font.size.variable.x-western", "16"))
print("The default font size is above 16." if isinstance(size, int) and size > 16 else "The default font size is " + str(size) + ".")
