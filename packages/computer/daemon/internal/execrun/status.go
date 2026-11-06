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
// open platform: a signal is reported by name instead of 128+n. Its process-tree kill is not used: the run's guard
// (guard.go) ends every descendant.

package execrun

import (
	"os"
	"strconv"
	"syscall"
)

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
