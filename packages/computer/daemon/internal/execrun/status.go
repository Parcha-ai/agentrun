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
// From kubernetes-sigs/agent-sandbox@bfc8505 packages/sandboxd/pkg/server/process.go (exitStatus). Changed for the
// open platform: a signal is reported by its name without SIG ("TERM") instead of 128+n. Its process-tree kill is not used: the run's guard
// (guard.go) ends every descendant.

package execrun

import (
	"os"
	"strconv"
	"syscall"
)

// exitStatus is the exit code, or the name of the signal that ended the process, without SIG. With no state another
// wait reaped the process first: init's shutdown, which sends SIGKILL to every process left before it reaps. So KILL.
func exitStatus(state *os.ProcessState) (*int, string) {
	if state == nil {
		return nil, "KILL"
	}
	if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return nil, signalName(ws.Signal())
	}
	code := state.ExitCode()
	return &code, ""
}

var signalNames = map[syscall.Signal]string{
	syscall.SIGHUP: "HUP", syscall.SIGINT: "INT", syscall.SIGQUIT: "QUIT", syscall.SIGILL: "ILL",
	syscall.SIGTRAP: "TRAP", syscall.SIGABRT: "ABRT", syscall.SIGBUS: "BUS", syscall.SIGFPE: "FPE",
	syscall.SIGKILL: "KILL", syscall.SIGUSR1: "USR1", syscall.SIGSEGV: "SEGV", syscall.SIGUSR2: "USR2",
	syscall.SIGPIPE: "PIPE", syscall.SIGALRM: "ALRM", syscall.SIGTERM: "TERM", syscall.SIGXCPU: "XCPU",
	syscall.SIGXFSZ: "XFSZ", syscall.SIGSYS: "SYS",
}

func signalName(sig syscall.Signal) string {
	if name, ok := signalNames[sig]; ok {
		return name
	}
	return strconv.Itoa(int(sig))
}
