// A box loss, simulated: preloaded into a writer, this keeps a copy of every file under FSYNC_SNAPSHOT_DIR as it stood at
// its last fsync or fdatasync (`<file>.synced`). What was written and never synced is what a lost box takes with it, so
// a reader that puts each `.synced` copy back in place of its file sees what a box loss would have left. The store's own
// copy of pi-durable-disk's shim (which the cutover deletes with that package).
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void snapshot(int fd) {
  const char *root = getenv("FSYNC_SNAPSHOT_DIR");
  if (root == NULL || *root == '\0') return;
  char link[64], path[PATH_MAX];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, path, sizeof path - 1);
  if (n <= 0) return;
  path[n] = '\0';
  size_t len = strlen(root);
  if (strncmp(path, root, len) != 0 || (path[len] != '/' && path[len] != '\0')) return;
  char tmp[PATH_MAX + 16], dst[PATH_MAX + 16];
  snprintf(tmp, sizeof tmp, "%s.syncing", path);
  snprintf(dst, sizeof dst, "%s.synced", path);
  int out = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (out < 0) return;
  char buf[65536];
  off_t at = 0;
  for (;;) {
    ssize_t got = pread(fd, buf, sizeof buf, at);
    if (got <= 0) break;
    if (write(out, buf, (size_t)got) != got) break;
    at += got;
  }
  close(out);
  rename(tmp, dst);
}

int fsync(int fd) {
  static int (*real)(int);
  if (real == NULL) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
  int rc = real(fd);
  if (rc == 0) snapshot(fd);
  return rc;
}

int fdatasync(int fd) {
  static int (*real)(int);
  if (real == NULL) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
  int rc = real(fd);
  if (rc == 0) snapshot(fd);
  return rc;
}
