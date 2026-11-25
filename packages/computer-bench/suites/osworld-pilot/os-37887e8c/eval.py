# From OSWorld (https://github.com/xlang-ai/OSWorld, Apache-2.0, Copyright 2024 XLANG NLP Lab): task
# os/37887e8c-da15-4192-923c-08fa390a176d's eval_20250703.sh, from its file cache, rewritten in Python for
# computer-bench. Changed: the box has no `file` program, so a file is compressed by its first bytes (gzip, zip, bzip2,
# xz, 7z, rar), by being a tar archive, or by its extension, as the original's fallback was; the base folder is
# test_files in the run's folder, and method 2 looks for archives in the run's folder instead of all of /tmp. Two rules
# are ours, stricter than the original: each old file must be found compressed (a compressed file named after it, a
# gzip that names it, or a member of an archive), and both new files must still be in new_files.
import gzip
import os
import tarfile
import zipfile

D = "/tmp/computer-bench-{{nonce}}"
BASE = D + "/test_files"
MAGIC = (b"\x1f\x8b", b"PK\x03\x04", b"BZh", b"\xfd7zXZ\x00", b"7z\xbc\xaf\x27\x1c", b"Rar!")
EXTENSIONS = ("gz", "bz2", "xz", "zip", "7z", "rar", "tar", "tgz", "tbz2", "txz")
ARCHIVES = (".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".zip", ".7z")
OLD = ("old_file1.txt", "old_file2.txt")
NEW = ("new_file1.txt", "new_file2.txt")


def is_compressed(path):
    with open(path, "rb") as f:
        head = f.read(8)
    if head.startswith(MAGIC):
        return True
    try:
        if tarfile.is_tarfile(path):
            return True
    except OSError:
        pass
    return os.path.basename(path).rsplit(".", 1)[-1] in EXTENSIONS


def regular_files(folder):
    if not os.path.isdir(folder):
        return []
    return [os.path.join(folder, name) for name in sorted(os.listdir(folder)) if os.path.isfile(os.path.join(folder, name))]


def directory_ok(folder, should_be_compressed):
    # A folder that is not there passes, as in the original.
    return all(is_compressed(path) == should_be_compressed for path in regular_files(folder))


def archives_under(root):
    found = []
    for at, _dirs, names in os.walk(root):
        found += [os.path.join(at, name) for name in names if name.endswith(ARCHIVES)]
    return found


def names_held(path):
    """The names a compressed file holds: an archive's members, a gzip's stored name, and its own name less the suffix."""
    names = set()
    base = os.path.basename(path)
    for suffix in (".gz", ".bz2", ".xz", ".zip", ".7z"):
        if base.endswith(suffix):
            names.add(base[: -len(suffix)])
    try:
        if tarfile.is_tarfile(path):
            with tarfile.open(path) as archive:
                names |= {os.path.basename(member.name) for member in archive.getmembers()}
        elif zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                names |= {os.path.basename(name) for name in archive.namelist()}
        else:
            with open(path, "rb") as f:
                head = f.read(10)
                if head[:2] == b"\x1f\x8b" and len(head) == 10 and head[3] & 0x08:
                    stored = b""
                    while (byte := f.read(1)) not in (b"", b"\x00"):
                        stored += byte
                    names.add(os.path.basename(stored.decode("latin-1")))
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError, gzip.BadGzipFile):
        pass
    return names


print("=== Checking old files compression ===")
handled = False
if directory_ok(BASE + "/old_files", True):
    handled = True
    print("Method 1: Old files are compressed in place")
if not handled:
    left = [path for path in regular_files(BASE + "/old_files") if not is_compressed(path)]
    if not left and (archives_under(BASE) or archives_under(D)):
        handled = True
        print("Method 2: Old files moved to compressed archives")
if not handled and archives_under(BASE):
    handled = True
    print("Method 3: Compressed archives created (original files may still exist)")

held = set()
for at, _dirs, names in os.walk(D):
    for name in names:
        path = os.path.join(at, name)
        if os.path.isfile(path) and is_compressed(path):
            held |= names_held(path)
missing_old = [name for name in OLD if name not in held]

print("=== Checking new files ===")
new_ok = directory_ok(BASE + "/new_files", False)
missing_new = [name for name in NEW if not os.path.isfile(os.path.join(BASE, "new_files", name))]

print("=== Final Evaluation ===")
if handled and new_ok and not missing_old and not missing_new:
    print("SUCCESS: The task was completed correctly.")
else:
    print("FAILURE: The task was not completed correctly.")
    if not handled:
        print("   - Old files were not compressed or archived")
    if missing_old:
        print("   - No compressed file holds " + ", ".join(missing_old))
    if not new_ok:
        print("   - New files were incorrectly compressed")
    if missing_new:
        print("   - new_files no longer holds " + ", ".join(missing_new))
