// Copyright 2026 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/server/process.go (killProcessTree,
// killDescendants, readProcChildren, exitStatus). Changed for the open platform: functions instead of ProcessServer
// methods, no logger, the signal is a parameter, and exitStatus reports a signal by name instead of 128+n.

package execrun

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// signalGroup signals the command's whole process group, then every descendant still found under /proc (runtimes
// such as gVisor do not always carry a group signal to grandchildren), then the leader itself.
func signalGroup(ctx context.Context, cmd *exec.Cmd, sig syscall.Signal) {
	pid := cmd.Process.Pid
	_ = syscall.Kill(-pid, sig)
	signalDescendants(ctx, pid, sig)
	_ = cmd.Process.Signal(sig)
}

// signalDescendants signals the descendants of rootPID by walking /proc, leaves first, so a child reaped mid-walk
// cannot hand its children to init before they are signalled.
func signalDescendants(ctx context.Context, rootPID int, sig syscall.Signal) {
	for _, cpid := range readProcChildren(ctx, rootPID) {
		if ctx.Err() != nil {
			return
		}
		signalDescendants(ctx, cpid, sig)
		_ = syscall.Kill(cpid, sig)
	}
}

// readProcChildren returns the direct children of pid from every thread's /proc/<pid>/task/<tid>/children: a child
// forked by another thread is listed only under that thread. Returns nil when the directory is unavailable.
func readProcChildren(ctx context.Context, pid int) []int {
	taskDir := fmt.Sprintf("/proc/%d/task", pid)
	entries, err := os.ReadDir(taskDir)
	if err != nil {
		return nil
	}
	seen := make(map[int]struct{})
	var children []int
	for _, entry := range entries {
		if ctx.Err() != nil {
			break
		}
		data, err := os.ReadFile(fmt.Sprintf("%s/%s/children", taskDir, entry.Name()))
		if err != nil {
			continue
		}
		for f := range strings.FieldsSeq(string(data)) {
			if cpid, err := strconv.Atoi(f); err == nil && cpid > 0 {
				if _, ok := seen[cpid]; !ok {
					seen[cpid] = struct{}{}
					children = append(children, cpid)
				}
			}
		}
	}
	return children
}

// exitStatus is the exit code, or the name of the signal that ended the process.
func exitStatus(state *os.ProcessState) (*int, string) {
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return nil, signalName(ws.Signal())
	}
	code := state.ExitCode()
	return &code, ""
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "SIGHUP", syscall.SIGINT: "SIGINT", syscall.SIGQUIT: "SIGQUIT", syscall.SIGILL: "SIGILL",
	syscall.SIGTRAP: "SIGTRAP", syscall.SIGABRT: "SIGABRT", syscall.SIGBUS: "SIGBUS", syscall.SIGFPE: "SIGFPE",
	syscall.SIGKILL: "SIGKILL", syscall.SIGUSR1: "SIGUSR1", syscall.SIGSEGV: "SIGSEGV", syscall.SIGUSR2: "SIGUSR2",
	syscall.SIGPIPE: "SIGPIPE", syscall.SIGALRM: "SIGALRM", syscall.SIGTERM: "SIGTERM", syscall.SIGXCPU: "SIGXCPU",
	syscall.SIGXFSZ: "SIGXFSZ", syscall.SIGSYS: "SIGSYS",
}

func signalName(sig syscall.Signal) string {
	if name, ok := signalNames[sig]; ok {
		return name
	}
	return "SIG" + strconv.Itoa(int(sig))
}
