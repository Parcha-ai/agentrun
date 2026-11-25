# OSWorld passed when the URLs bookmarked on Chrome's bookmarks bar were exactly
# {https://jalammar.github.io/illustrated-transformer/}. Firefox keeps bookmarks in places.sqlite; the toolbar is the
# folder with guid toolbar_____. Firefox holds the database open with a write-ahead log, so this copies the database and
# its log aside and reads the copy. A fresh Firefox may put its own links (mozilla.org, firefox.com) on the toolbar;
# those are left out, and the rest must be exactly OSWorld's set.
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from urllib.parse import urlsplit

PROFILE = "/tmp/computer-bench-{{nonce}}/profile"
WANT = {"https://jalammar.github.io/illustrated-transformer/"}
FIREFOX_OWN = ("mozilla.org", "mozilla.com", "firefox.com")

time.sleep(2)
copy = tempfile.mkdtemp(prefix="computer-bench-{{nonce}}-places-")
try:
    for suffix in ("", "-wal"):
        if os.path.exists(PROFILE + "/places.sqlite" + suffix):
            shutil.copy(PROFILE + "/places.sqlite" + suffix, copy + "/places.sqlite" + suffix)
    if not os.path.exists(copy + "/places.sqlite"):
        print("no places.sqlite")
        sys.exit(1)
    rows = sqlite3.connect(copy + "/places.sqlite").execute(
        "SELECT p.url FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk JOIN moz_bookmarks f ON f.id = b.parent"
        " WHERE b.type = 1 AND f.guid = 'toolbar_____'"
    ).fetchall()
finally:
    shutil.rmtree(copy, ignore_errors=True)
urls = {url for (url,) in rows if not (urlsplit(url).hostname or "").endswith(FIREFOX_OWN)}
print("The toolbar holds the transformer page." if urls == WANT else "The toolbar holds " + repr(sorted(urls)) + ".")
