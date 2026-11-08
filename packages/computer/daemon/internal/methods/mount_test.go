package methods_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/archilsync"
	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/methods"
)

// mount.sync asks the resident Archil sync server for one sync and answers its exit code; with none, not_found.
func TestMountSyncAnswersTheServersExitCode(t *testing.T) {
	dir := t.TempDir()
	mountpoint := filepath.Join(dir, "workspace")
	mounts := filepath.Join(dir, "mounts")
	if err := os.WriteFile(mounts, []byte("d:/agents/a/runs/r/work "+mountpoint+" fuse.archil rw 0 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := archilsync.Config{Socket: filepath.Join(dir, "run", "archil.sock"), Mountpoint: mountpoint, Mounts: mounts, GID: os.Getegid(), Poll: 20 * time.Millisecond}
	l, err := archilsync.Listen(config)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = archilsync.Serve(ctx, l, config, func(context.Context) int { return 3 }) }()

	r := callWith(t, methods.Options{SyncSocket: config.Socket}, `{"jsonrpc":"2.0","id":1,"method":"mount.sync","params":{}}`)
	if r.Error != nil || string(r.Result) != `{"exitCode":3}` {
		t.Fatalf("mount.sync = %s, %+v; want {\"exitCode\":3}", r.Result, r.Error)
	}
	r = callWith(t, methods.Options{SyncSocket: filepath.Join(dir, "none.sock")}, `{"jsonrpc":"2.0","id":1,"method":"mount.sync","params":{}}`)
	if r.Error == nil || r.Error.Data.Kind != "not_found" {
		t.Fatalf("mount.sync with no server = %s, %+v; want not_found", r.Result, r.Error)
	}
	r = callWith(t, methods.Options{SyncSocket: config.Socket}, `{"jsonrpc":"2.0","id":1,"method":"mount.sync","params":{"x":1}}`)
	if r.Error == nil || r.Error.Data.Kind != "invalid" {
		t.Fatalf("mount.sync with a param = %+v; want invalid", r.Error)
	}
}

// With no socket given, mount.sync asks the one every computer's serve listens on.
func TestMountSyncsSocketIsTheFixedOne(t *testing.T) {
	if archilsync.SocketPath != "/run/agentrun-archil/archil.sock" {
		t.Fatalf("SocketPath = %q", archilsync.SocketPath)
	}
}
