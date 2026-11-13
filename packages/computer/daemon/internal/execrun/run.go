// Package execrun runs one program to its end: argv only, never a shell, under a guard that ends everything it starts.
package execrun

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"syscall"
	"time"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/proctree"
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

// Run runs spec to its end, through a guard (guard.go) that is a child subreaper for this one run. The timeout counts
// from the call, so it covers the start too: a guard that never reports the program's pid is killed with everything
// under it, as on a timeout or cancel before the program started. On timeout or cancel
// the guard sends SIGTERM to the program's group and every descendant, then SIGKILL KillGrace later; a timeout is a
// result with TimedOut set, a cancel an aborted error. When the program ends, the guard kills and reaps every
// descendant it left, in its group or not: nothing a run starts outlives it.
func Run(ctx context.Context, spec Spec) (Result, error) {
	deadline := time.Now().Add(spec.Timeout)
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
	if ctx.Err() != nil {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled before it started")
	}
	startCtx, cancelStart := context.WithDeadline(ctx, deadline)
	g, err := Start(startCtx, Program{Argv: spec.Argv, Cwd: spec.Cwd, Env: spec.Env, User: spec.User}, nil, stdout.writer, stderr.writer)
	cancelStart()
	stdout.collect()
	stderr.collect()
	if err != nil {
		drain(stdout, stderr)
		var late *startTimedOut
		timedOut := errors.As(err, &late)
		var e *rpc.Error
		if ctx.Err() != nil && (timedOut || errors.As(err, &e) && e.Kind == rpc.KindAborted) {
			return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled; the program and everything it started were ended")
		}
		if timedOut {
			return Result{ExitCode: late.code, Signal: late.signal, Stdout: stdout.bytes(), Stderr: stderr.bytes(), TimedOut: true, Truncated: stdout.truncated || stderr.truncated}, nil
		}
		return Result{}, err
	}
	defer g.Close()

	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	timedOut, aborted := false, false
	select {
	case <-g.Done():
	case <-timer.C:
		timedOut = true
	case <-ctx.Done():
		aborted = true
	}
	if timedOut || aborted {
		if err := stopGuard(g); err != nil {
			return Result{}, err
		}
	}
	drain(stdout, stderr)
	if aborted {
		return Result{}, rpc.Errorf(rpc.KindAborted, "exec.run was cancelled; the program and everything it started were ended")
	}
	res := Result{Stdout: stdout.bytes(), Stderr: stderr.bytes(), TimedOut: timedOut, Truncated: stdout.truncated || stderr.truncated}
	var reported bool
	res.ExitCode, res.Signal, reported = g.Exit()
	if !reported && !timedOut {
		// Only the timeout's signal may end the guard before it reports; then its own end is the run's.
		return Result{}, fmt.Errorf("the guard for %s ended with no status (exit code %v, signal %q)", spec.Argv[0], res.ExitCode, res.Signal)
	}
	return res, nil
}

// stopGuard asks the guard to end the run with SIGTERM. The guard takes KillGrace before its SIGKILL; should it still be
// there guardSlack after that, it and every descendant are sent SIGKILL from here.
func stopGuard(g *Guarded) error {
	g.Stop()
	select {
	case <-g.Done():
		return nil
	case <-time.After(KillGrace + guardSlack):
	}
	return killGuard(g)
}

// killGuard sends SIGKILL to every descendant of the guard and then to the guard, waits for the guard to be reaped, and
// then for every descendant it sent SIGKILL to have ended.
func killGuard(g *Guarded) error {
	// Once the guard was reaped its pid is free and may already belong to another process: signal nothing.
	select {
	case <-g.Done():
		return nil
	default:
	}
	pid := g.guard.Process.Pid
	killed := map[int]uint64{}
	for _, d := range proctree.Descendants(pid) {
		if started, ok := proctree.Started(d); ok {
			killed[d] = started
		}
		if killDescendant != nil {
			killDescendant(d)
		} else {
			_ = syscall.Kill(d, syscall.SIGKILL)
		}
	}
	_ = syscall.Kill(pid, syscall.SIGKILL)
	select {
	case <-g.Done():
	case <-time.After(cleanupTimeout):
		return fmt.Errorf("the guard, process %d, did not end %v after SIGKILL", pid, cleanupTimeout)
	}
	return awaitEnded(killed)
}

// awaitEnded waits until no process in killed (each pid with its start time) still runs, polling with a short backoff.
// SIGKILL lands asynchronously, so one sent it may run on for a moment. A zombie has ended: its new parent reaps it.
// Any still running descendantsTimeout on are named in the error.
func awaitEnded(killed map[int]uint64) error {
	deadline := time.Now().Add(descendantsTimeout)
	for pause := time.Millisecond; ; pause = min(2*pause, 50*time.Millisecond) {
		var running []int
		for pid, started := range killed {
			if proctree.Running(pid, started) {
				running = append(running, pid)
			}
		}
		if len(running) == 0 {
			return nil
		}
		if !time.Now().Before(deadline) {
			slices.Sort(running)
			return fmt.Errorf("processes %v under the guard still run %v after SIGKILL", running, descendantsTimeout)
		}
		time.Sleep(min(pause, time.Until(deadline)))
	}
}

// guardSlack is how long past KillGrace the guard has to kill, reap and report.
const guardSlack = 3 * time.Second

// cleanupTimeout bounds the wait for a guard after SIGKILL.
const cleanupTimeout = 10 * time.Second

// descendantsTimeout bounds the wait for the guard's descendants after SIGKILL. A test shortens it.
var descendantsTimeout = cleanupTimeout

// killDescendant is nil outside tests: killGuard calls it in place of sending SIGKILL to a descendant.
var killDescendant func(pid int)

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
