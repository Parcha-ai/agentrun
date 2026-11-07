package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// argsEnv makes the test binary run computerd's main with these arguments (JSON), as a process of its own.
const argsEnv = "COMPUTERD_TEST_ARGS"

func TestMain(m *testing.M) {
	if args := os.Getenv(argsEnv); args != "" {
		os.Args = []string{"computerd"}
		if err := json.Unmarshal([]byte(args), &os.Args); err != nil {
			os.Exit(99)
		}
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// computerd runs main with args, not as PID 1, and returns its exit code and stderr; it is killed after bound.
func computerd(t *testing.T, bound time.Duration, args ...string) (int, string) {
	t.Helper()
	encoded, _ := json.Marshal(append([]string{"computerd"}, args...))
	ctx, cancel := context.WithTimeout(context.Background(), bound)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0])
	cmd.Env = append(os.Environ(), argsEnv+"="+string(encoded))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		t.Fatalf("computerd %q still ran after %v; stderr: %s", args, bound, stderr.String())
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), stderr.String()
	}
	if err != nil {
		t.Fatal(err)
	}
	return 0, stderr.String()
}

func TestInitRefusesToStartWithoutADeadline(t *testing.T) {
	for _, args := range [][]string{
		{"init"},
		{"init", "--deadline"},
		{"init", "--deadline", ""},
		{"init", "--deadline", "tomorrow"},
		{"init", "--deadline", "2026-11-06"},
		{"init", "--deadline", "2026-11-06T10:00:00Z", "extra"},
	} {
		code, stderr := computerd(t, 30*time.Second, args...)
		if code == 0 {
			t.Errorf("computerd %q exited 0; want a refusal", args)
		}
		if !strings.Contains(stderr, "--deadline") || !strings.Contains(stderr, "RFC 3339") {
			t.Errorf("computerd %q: stderr does not say why in words: %q", args, stderr)
		}
	}
}

func TestInitEndsAtItsDeadline(t *testing.T) {
	deadline := time.Now().Add(500 * time.Millisecond)
	code, stderr := computerd(t, 30*time.Second, "init", "--deadline", deadline.UTC().Format(time.RFC3339Nano))
	if code != 0 {
		t.Fatalf("exit code %d at the deadline, want 0; stderr: %s", code, stderr)
	}
	if time.Now().Before(deadline) {
		t.Fatalf("init ended before its deadline; stderr: %s", stderr)
	}
	if !strings.Contains(stderr, "deadline") {
		t.Errorf("init did not say it ended at its deadline: %q", stderr)
	}
}

func TestInitTakesTheProvidersDeadline(t *testing.T) {
	// The form JavaScript's toISOString writes, which the provider passes.
	code, stderr := computerd(t, 30*time.Second, "init", "--deadline", time.Now().Add(-time.Second).UTC().Format("2006-01-02T15:04:05.000Z"))
	if code != 0 {
		t.Fatalf("exit code %d, want 0 at a deadline already past; stderr: %s", code, stderr)
	}
}
