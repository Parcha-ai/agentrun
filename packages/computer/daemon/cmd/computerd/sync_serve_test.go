package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
)

// sync-serve returns: the helper's serve verb is the last root step a provider's exec runs and waits for (Daytona's
// session command, Modal's exec, E2B's root command, each bounded), so the command must exit 0 once it serves, leaving
// the server in a session of its own, which answers, and exits when the mount goes. Run on the real binary, built here,
// since the server it leaves is computerd itself.
func TestSyncServeReturnsAndLeavesTheServerBehind(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain to build computerd with")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "computerd")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	mountpoint := filepath.Join(dir, "workspace")
	mounts := filepath.Join(dir, "mounts")
	if err := os.WriteFile(mounts, []byte("d:/agents/a/runs/r/work "+mountpoint+" fuse.archil rw 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	archil := filepath.Join(dir, "archil")
	if err := os.WriteFile(archil, []byte("#!/bin/sh\nexit 6\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "run", "archil.sock")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "sync-serve", "--socket", socket, "--mountpoint", mountpoint, "--mounts", mounts, "--archil", archil, "--gid", strconv.Itoa(os.Getegid()))
	// Its stdout and stderr are pipes a provider's exec reads to their end: the command must not leave them open.
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("sync-serve did not return: %s", out)
	}
	if err != nil {
		t.Fatalf("sync-serve: %v: %s", err, out)
	}
	code, err := archilsync.Ask(context.Background(), socket, archilsync.Owner{UID: os.Geteuid(), GID: os.Getegid()})
	if err != nil || code != 6 {
		t.Fatalf("the server it left: Ask = %d, %v; want 6, the client's exit code", code, err)
	}
	// The mount goes: the server exits and removes its socket.
	if err := os.WriteFile(mounts, []byte("proc /proc proc rw 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Lstat(socket); os.IsNotExist(err) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the server did not exit when the mount went")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

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
