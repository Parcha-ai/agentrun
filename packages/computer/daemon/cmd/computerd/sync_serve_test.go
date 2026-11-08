package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sync-serve takes the helper's fixed arguments alone: any other exits 2 and starts nothing.
func TestSyncServeRefusesOtherArguments(t *testing.T) {
	for _, args := range [][]string{
		{"sync-serve"},
		{"sync-serve", "--socket", "/run/agentrun-archil/archil.sock"},
		{"sync-serve", "--socket", "/s", "--mountpoint", "/workspace", "--mounts", "/proc/self/mounts", "--archil", "/usr/bin/archil", "--gid", "2510", "--token", "x"},
		{"sync-serve-run"},
	} {
		code, stderr := computerd(t, 10*time.Second, args...)
		if code != 2 || !strings.Contains(stderr, "sync-serve takes --socket") {
			t.Errorf("computerd %q: exit %d, stderr %q; want exit 2 and the arguments it takes", args, code, stderr)
		}
	}
}

// With no archil mount at the mountpoint, sync-serve exits 3 and makes nothing.
func TestSyncServeWithNothingMountedExits3(t *testing.T) {
	dir := t.TempDir()
	mounts := filepath.Join(dir, "mounts")
	if err := os.WriteFile(mounts, []byte("proc /proc proc rw 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "run", "archil.sock")
	code, stderr := computerd(t, 10*time.Second, "sync-serve", "--socket", socket, "--mountpoint", filepath.Join(dir, "workspace"), "--mounts", mounts, "--archil", "/usr/bin/archil", "--gid", "2510")
	if code != 3 || !strings.Contains(stderr, "nothing is mounted") {
		t.Fatalf("exit %d, stderr %q; want 3", code, stderr)
	}
	if _, err := os.Lstat(filepath.Dir(socket)); !os.IsNotExist(err) {
		t.Fatalf("the socket's folder was made: %v", err)
	}
}
