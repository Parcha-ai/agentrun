package daemon

import (
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
)

// UserNamespaceInitArg is the subcommand init starts itself again as, inside a user and a network namespace of its own:
// `computerd userns-init --started-in <the network namespace it left> <init's own arguments>`.
const UserNamespaceInitArg = "userns-init"

// threadNetwork is this thread's network namespace, as a link to read.
const threadNetwork = "/proc/thread-self/ns/net"

// identityMap maps every uid (or gid) to itself, 0 to 2^32-2: the files, the tool user and root keep their own ids
// inside the user namespace and out of it.
var identityMap = []syscall.SysProcIDMap{{ContainerID: 0, HostID: 0, Size: 1<<32 - 1}}

// InitInUserNamespace is init's start with --own-network-userns, where root may make a user namespace but not a network
// namespace: gVisor on Modal, whose root holds no CAP_SYS_ADMIN, so unshare(CLONE_NEWNET) is EPERM while
// unshare(CLONE_NEWUSER|CLONE_NEWNET) is not (measured in a gVisor sandbox with a T4, 11-11). A process with more than
// one thread cannot enter a new user namespace, and a Go process has several, so this init starts itself again as a
// child, self with UserNamespaceInitArg, in a new user namespace that maps every uid and gid to itself and a new network
// namespace. The child is the init that holds the computer: it brings its loopback up and reads it back
// (isolate.KeepOwnNetwork), refuses strangers, closes the system's sockets, drops to the tool user and installs the
// filter, as --own-network does, then serves. This init, the sandbox's main process, then keeps no capability
// (Unprivileged), passes SIGTERM and SIGINT on to the child, reaps whatever it is handed, and exits with the child's
// code once the child ends: the computer lives as long as the init that serves it. Any failure is said on stderr and
// this init exits 1, so the computer fails closed.
func InitInUserNamespace(self string, args []string, logger *log.Logger) int {
	// The child's parent-death signal is tied to the thread that starts it: this one, for the whole of init's life.
	runtime.LockOSThread()
	first, err := os.Readlink(threadNetwork)
	if err != nil {
		logger.Printf("init refuses to start: cannot read its network namespace, so cannot name the one its programs must leave: %v", err)
		return 1
	}
	signals := make(chan os.Signal, 16)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGCHLD)
	child := exec.Command(self, append([]string{UserNamespaceInitArg, "--started-in", first}, args...)...)
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
	child.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:                 syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET,
		UidMappings:                identityMap,
		GidMappings:                identityMap,
		GidMappingsEnableSetgroups: true,
		Pdeathsig:                  syscall.SIGKILL,
	}
	if err := child.Start(); err != nil {
		logger.Printf("init refuses to start: cannot start itself again in a user and a network namespace of its own: %v; init needs root that may make a user namespace and map every uid and gid to itself (CAP_SETUID, CAP_SETGID), and a computer without one is refused, since its programs could reach the vendor's agent on the computer's loopback", err)
		return 1
	}
	pid := child.Process.Pid
	// The child holds the computer; this init keeps nothing it could be made to use.
	if err := Unprivileged(); err != nil {
		logger.Printf("init refuses to start: %v", err)
		_ = syscall.Kill(pid, syscall.SIGKILL)
		return 1
	}
	for sig := range signals {
		if sig != syscall.SIGCHLD {
			_ = syscall.Kill(pid, sig.(syscall.Signal))
			continue
		}
		for {
			var status syscall.WaitStatus
			reaped, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
			if err != nil || reaped <= 0 {
				break
			}
			if reaped == pid {
				return codeOf(status)
			}
		}
	}
	return 1
}

// codeOf is a process's end as an exit code: its own, or 128 plus the signal that ended it.
func codeOf(status syscall.WaitStatus) int {
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}
