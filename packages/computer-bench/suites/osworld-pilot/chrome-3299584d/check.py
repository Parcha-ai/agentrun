# OSWorld passed when Chrome's Preferences had no session key or restore_on_startup 5 (open the New Tab page), after
# setup set startup_urls to http://funbrain.com/. Firefox opens browser.startup.homepage at launch when
# browser.startup.page is 1 (its default) and a blank page when it is 0; setup set the homepage to http://funbrain.com/.
# This passes when Firefox will open its own home or a blank page: page 0, or page 1 with a homepage that is not
# funbrain. Restoring the last session (page 3) leaves funbrain as the homepage, as OSWorld's restore modes did, and
# fails. Firefox writes prefs.js about half a second after a change; a pref at its default is absent.
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
page = json.loads(prefs.get("browser.startup.page", "1"))
homepage = str(json.loads(prefs.get("browser.startup.homepage", '"about:home"')))
if page == 0 or (page == 1 and "funbrain" not in homepage.lower()):
    print("Firefox no longer opens funbrain.com at launch.")
else:
    print("Firefox still opens funbrain.com at launch (page " + str(page) + ", homepage " + homepage + ").")
