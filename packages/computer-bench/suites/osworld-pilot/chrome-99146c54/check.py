# OSWorld passed when Chrome's Preferences held profile.default_content_setting_values. Firefox deletes data when it
# closes when privacy.sanitize.sanitizeOnShutdown is true: the "Delete cookies and site data when Firefox is closed"
# box and "Clear history when Firefox closes" both set it. "Never remember history" (browser.privatebrowsing.autostart)
# keeps no data past closing, so it passes too. Firefox writes prefs.js about half a second after a change; a pref at
# its default (false for all of these) is absent.
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
if prefs.get("privacy.sanitize.sanitizeOnShutdown") == "true" or prefs.get("browser.privatebrowsing.autostart") == "true":
    print("Firefox deletes browsing data when it closes.")
else:
    print("Firefox keeps browsing data when it closes.")
