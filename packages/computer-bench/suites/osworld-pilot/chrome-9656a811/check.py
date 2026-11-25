# OSWorld passed when Chrome's safebrowsing.enabled was true, after setup set it false. Firefox's "Block dangerous and
# deceptive content" box is browser.safebrowsing.malware.enabled and browser.safebrowsing.phishing.enabled; setup set
# both false, and this passes when neither is false any more (true, or absent: true is their default). Firefox writes
# prefs.js about half a second after a change.
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
off = [name for name in ("browser.safebrowsing.malware.enabled", "browser.safebrowsing.phishing.enabled") if prefs.get(name) == "false"]
print("Safe browsing is on." if not off else "Still off: " + ", ".join(off) + ".")
