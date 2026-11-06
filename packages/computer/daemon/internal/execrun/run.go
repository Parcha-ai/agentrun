// Package execrun runs one program to its end: argv only, never a shell, under a guard that ends everything it starts.
package execrun

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/rpc"
)

// MaxOutput is the most bytes kept of each stream. Two full streams, in base64, fit one 1 MiB reply line.
const MaxOutput = 360 << 10

// KillGrace is how long a run has between SIGTERM and SIGKILL.
const KillGrace = 2 * time.Second

// Spec is one run.
type Spec struct {
	Argv    []string
	Cwd     string
	Env     map[string]string
	User    string
	Timeout time.Duration
	// MaxOutput is the bytes kept of each stream: nil is MaxOutput.
	MaxOutput *int
}

// Result is what a run that ended, or timed out, reports. Stdout and Stderr marshal as base64.
type Result struct {
	ExitCode  *int   `json:"exitCode"`
	Signal    string `json:"signal,omitempty"`
	Stdout    []byte `json:"stdout"`
	Stderr    []byte `json:"stderr"`
	TimedOut  bool   `json:"timedOut"`
	Truncated bool   `json:"truncated"`
}

// Run runs spec to its end, through a guard (guard.go) that is a child subreaper for this one run. On timeout or cancel
// the guard sends SIGTERM to the program's group and every descendant, then SIGKILL KillGrace later; a timeout is a
// result with TimedOut set, a cancel an aborted error. When the program ends, the guard kills and reaps every
// descendant it left, in its group or not: nothing a run starts outlives it.
func Run(ctx context.Context, spec Spec) (Result, error) {
	if len(spec.Argv) == 0 || spec.Argv[0] == "" {
		return Result{}, rpc.Errorf(rpc.KindInvalid, "argv needs at least a program")
	}
	if spec.Timeout <= 0 {
		return Result{}, rpc.Errorf(rpc.KindInvalid, "the timeout must be positive")
	}
	limit, err := resolveByteLimit("maxOutput", spec.MaxOutput, MaxOutput, MaxOutput)
	if err != nil {
		return Result{}, err
	}
	acct, err := resolveUser(spec.User)
	if err != nil {
		return Result{}, err
	}
	cred, err := credential(acct)
	if err != nil {
		return Result{}, err
	}
	dir, err := resolveCwd(spec.Cwd, acct)
	if err != nil {
		return Result{}, err
	}
	env := environment(acct, spec.Env)
	path, err := lookPath(spec.Argv[0], env)
	if err != nil {
		return Result{}, err
	}

	stdout, err := newOutputStream(limit)
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(stdout.reader, stdout.writer)
	stderr, err := newOutputStream(limit)
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(stderr.reader, stderr.writer)
	specReader, specWriter, err := os.Pipe()
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(specReader, specWriter)
	statusReader, statusWriter, err := os.Pipe()
	if err != nil {
		return Result{}, fmt.Errorf("cannot make a pipe: %w", err)
	}
	defer closeAll(statusReader, statusWriter)
	guard := &exec.Cmd{
		Path:        "/proc/self/exe",
		Args:        []string{"computerd", GuardCommand},
		Env:         []string{},
		Stdout:      stdout.writer,
		Stderr:      stderr.writer,
		ExtraFiles:  []*os.File{specReader, statusWriter},
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true},
	}

	if ctx.Err() != nil {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled before it started")
	}
	if err := guard.Start(); err != nil {
		return Result{}, fmt.Errorf("cannot start the guard for %s: %w", spec.Argv[0], err)
	}
	closeAll(specReader, statusWriter)
	stdout.collect()
	stderr.collect()
	statusRead := make(chan []byte, 1)
	go func() {
		data, _ := io.ReadAll(io.LimitReader(statusReader, 4096))
		statusRead <- data
	}()
	guardDone := make(chan struct{})
	go func() {
		_ = guard.Wait()
		close(guardDone)
	}()
	if err := json.NewEncoder(specWriter).Encode(guardSpec{Path: path, Argv: spec.Argv, Env: env, Dir: dir, Credential: cred}); err != nil {
		_ = syscall.Kill(guard.Process.Pid, syscall.SIGKILL)
		<-guardDone
		drain(stdout, stderr)
		return Result{}, fmt.Errorf("cannot hand %s to its guard: %w", spec.Argv[0], err)
	}
	_ = specWriter.Close()

	timer := time.NewTimer(spec.Timeout)
	defer timer.Stop()
	timedOut, aborted := false, false
	select {
	case <-guardDone:
	case <-timer.C:
		timedOut = true
	case <-ctx.Done():
		aborted = true
	}
	if timedOut || aborted {
		if err := stopGuard(guard.Process.Pid, guardDone); err != nil {
			return Result{}, err
		}
	}
	drain(stdout, stderr)
	if aborted {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled; the program and everything it started were ended")
	}
	res := Result{Stdout: stdout.bytes(), Stderr: stderr.bytes(), TimedOut: timedOut, Truncated: stdout.truncated || stderr.truncated}
	var status guardStatus
	switch {
	case json.Unmarshal(<-statusRead, &status) != nil:
		res.ExitCode, res.Signal = exitStatus(guard.ProcessState)
		if !timedOut {
			return Result{}, fmt.Errorf("the guard for %s ended with no status (exit code %v, signal %q)", spec.Argv[0], res.ExitCode, res.Signal)
		}
		// The timeout's signal ended the guard before it could report, so its own end is the run's.
	case status.StartError != "":
		return Result{}, startError(spec.Argv[0], status.StartErrno, status.StartError)
	case status.Signal != 0:
		res.Signal = signalName(syscall.Signal(status.Signal))
	default:
		res.ExitCode = status.ExitCode
	}
	return res, nil
}

// stopGuard asks the guard to end the run with SIGTERM. The guard takes KillGrace before its SIGKILL; should it still be
// there guardSlack after that, it and every descendant are sent SIGKILL from here.
func stopGuard(pid int, guardDone <-chan struct{}) error {
	_ = syscall.Kill(pid, syscall.SIGTERM)
	select {
	case <-guardDone:
		return nil
	case <-time.After(KillGrace + guardSlack):
	}
	for _, d := range descendants(pid) {
		_ = syscall.Kill(d, syscall.SIGKILL)
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	select {
	case <-guardDone:
		return nil
	case <-time.After(cleanupTimeout):
		return fmt.Errorf("the guard, process %d, did not end %v after SIGKILL", pid, cleanupTimeout)
	}
}

// guardSlack is how long past KillGrace the guard has to kill, reap and report.
const guardSlack = 3 * time.Second

// cleanupTimeout bounds the wait for a guard after SIGKILL.
const cleanupTimeout = 10 * time.Second

// drain waits for both streams to reach end of file. A pipe still held open (only if the guard itself was killed) is
// closed on this side after drainGrace, and what was read so far is kept.
func drain(streams ...*outputStream) {
	deadline := time.After(drainGrace)
	for _, s := range streams {
		select {
		case <-s.done:
		case <-deadline:
			for _, other := range streams {
				_ = other.reader.Close()
			}
			<-s.done
		}
	}
}

const drainGrace = 2 * time.Second

func closeAll(files ...*os.File) {
	for _, f := range files {
		_ = f.Close()
	}
}

func startError(program string, errno int, message string) error {
	switch syscall.Errno(errno) {
	case syscall.EPERM, syscall.EACCES:
		return rpc.Errorf(rpc.KindDenied, "cannot start %s: %s", program, message)
	case syscall.ENOENT:
		return rpc.Errorf(rpc.KindNotFound, "cannot start %s: %s", program, message)
	default:
		return rpc.Errorf(rpc.KindInvalid, "cannot start %s: %s", program, message)
	}
}
