package isolate

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/nocgo"
)

// The children this test binary runs as: ownNetworkChild (with OwnNetwork, or KeepOwnNetwork), denySocketsChild and
// vsockChild.
const (
	ownNetworkArg     = "own-network-child"
	keepOwnNetworkArg = "keep-own-network-child"
	denySocketsArg    = "deny-sockets-child"
	vsockArg          = "vsock-child"
	waitArg           = "wait-child"
	prSetNoNewPriv    = 38
	heldThreads       = 4
)

func TestMain(m *testing.M) {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case ownNetworkArg:
			os.Exit(ownNetworkChild(os.Args[2:], func(string) error { return OwnNetwork() }))
		case keepOwnNetworkArg:
			// args: the parent's listener, then the network namespace the child was started from.
			if len(os.Args) != 4 {
				fmt.Fprintln(os.Stderr, "keep-own-network child: <parent's loopback address> <first network namespace>")
				os.Exit(2)
			}
			os.Exit(ownNetworkChild(os.Args[2:3], func(string) error { return KeepOwnNetwork(os.Args[3]) }))
		case denySocketsArg:
			os.Exit(denySocketsChild())
		case vsockArg:
			fmt.Println("vsock", errnoWords(socketErr(afVsock)))
			os.Exit(0)
		case waitArg:
			_, _ = io.Copy(io.Discard, os.Stdin)
			os.Exit(0)
		}
	}
	os.Exit(nocgo.Run(m))
}

// holdThreads starts n goroutines each locked to a thread of its own, so a call made on one thread alone is seen to
// miss the others.
func holdThreads(n int) {
	ready := make(chan struct{})
	for range n {
		go func() {
			runtime.LockOSThread()
			ready <- struct{}{}
			select {}
		}()
	}
	for range n {
		<-ready
	}
}

// threadNamespaces is each thread's network namespace, by its link in /proc.
func threadNamespaces() ([]string, error) {
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		return nil, err
	}
	links := []string{}
	for _, task := range tasks {
		link, err := os.Readlink(filepath.Join("/proc/self/task", task.Name(), "ns", "net"))
		if err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, nil
}

// ownNetworkChild holds threads of its own, calls own (OwnNetwork, or KeepOwnNetwork), and prints what a program of its
// would see: "refused <why>" and exit 3 when own refuses; else "first <ns>", "thread <ns>" for each thread, "interfaces
// <names>", "parent <reached|refused: why>" for a dial to the parent's loopback listener at args[0], and "loopback
// <ok|why>" for a listener of its own on its loopback.
func ownNetworkChild(args []string, own func(string) error) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "own-network child: <parent's loopback address>")
		return 2
	}
	holdThreads(heldThreads)
	first, err := os.Readlink("/proc/self/ns/net")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := own(first); err != nil {
		fmt.Println("refused", err)
		return 3
	}
	fmt.Println("first", first)
	links, err := threadNamespaces()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	for _, link := range links {
		fmt.Println("thread", link)
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	names := []string{}
	for _, iface := range ifaces {
		names = append(names, fmt.Sprintf("%s:%v", iface.Name, iface.Flags&net.FlagUp != 0))
	}
	fmt.Println("interfaces", strings.Join(names, ","))
	if conn, err := net.DialTimeout("tcp", args[0], 2*time.Second); err != nil {
		fmt.Println("parent refused:", err)
	} else {
		conn.Close()
		fmt.Println("parent reached")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0") // key-gate: loopback-rule the test's own namespace's loopback
	if err != nil {
		fmt.Println("loopback", err)
		return 0
	}
	defer listener.Close()
	go func() {
		if conn, err := listener.Accept(); err == nil {
			conn.Close()
		}
	}()
	if conn, err := net.DialTimeout("tcp", listener.Addr().String(), 2*time.Second); err != nil {
		fmt.Println("loopback", err)
	} else {
		conn.Close()
		fmt.Println("loopback ok")
	}
	return 0
}

// mayMakeNamespaces says whether this process may make a network namespace itself: root with CAP_SYS_ADMIN.
func mayMakeNamespaces() bool {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return false
	}
	for line := range strings.Lines(string(status)) {
		if value, found := strings.CutPrefix(line, "CapEff:"); found {
			var caps uint64
			fmt.Sscanf(strings.TrimSpace(value), "%x", &caps)
			return os.Geteuid() == 0 && caps&(1<<21) != 0 && caps&(1<<12) != 0
		}
	}
	return false
}

func TestOwnNetworkLeavesEveryThreadOnlyItsOwnLoopback(t *testing.T) {
	nocgo.Require(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0") // key-gate: loopback-rule the test's stand-in for a vendor agent on the box's loopback
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	cmd := exec.Command(os.Args[0], ownNetworkArg, listener.Addr().String())
	if !mayMakeNamespaces() {
		// Root of a user namespace of its own, which holds every capability over the namespaces it makes.
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Cloneflags:  syscall.CLONE_NEWUSER,
			UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
			GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
		}
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	// A host may refuse the user namespace, or make one whose root holds nothing (Ubuntu's AppArmor userns restriction).
	if err != nil && cmd.SysProcAttr != nil && (cmd.ProcessState == nil || strings.Contains(string(out), "refused") && strings.Contains(string(out), "operation not permitted")) {
		t.Skipf("this host gives this user no user namespace whose root may make a network namespace (%v: %s), and this process is not root with CAP_SYS_ADMIN: run this test binary as root in a container with CAP_SYS_ADMIN and CAP_NET_ADMIN", err, strings.TrimSpace(string(out)))
	}
	if err != nil {
		t.Fatalf("the child: %v; stdout %q, stderr %s", err, out, stderr.String())
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var first string
	threads := 0
	for _, line := range lines {
		word, rest, _ := strings.Cut(line, " ")
		switch word {
		case "first":
			first = rest
		case "thread":
			threads++
			if rest == first {
				t.Errorf("a thread is still in the network namespace init started in (%s)", rest)
			}
		case "interfaces":
			if rest != "lo:true" {
				t.Errorf("interfaces %q, want lo alone, up", rest)
			}
		case "parent":
			if !strings.HasPrefix(rest, "refused") {
				t.Errorf("a program reached a listener on the box's loopback: %s", rest)
			}
		case "loopback":
			if rest != "ok" {
				t.Errorf("a program cannot use its own loopback: %s", rest)
			}
		}
	}
	if first == "" || threads < heldThreads+1 {
		t.Fatalf("the child's lines: %q; want its first namespace and every thread (%d or more)", lines, heldThreads+1)
	}
}

// KeepOwnNetwork, in a child started as InitInUserNamespace starts init: in a user namespace and a network namespace of
// its own, made at its start, with root of that user namespace mapped to this user (as an unprivileged user may; the
// computer's init maps every id). The child brings the loopback up and reads back that no thread is in the namespace
// it was started from, and its programs see the loopback alone: the box's listener unreached, their own loopback usable.
// Started in no network namespace of its own, it refuses in words: every thread is still in the first one.
func TestKeepOwnNetworkHoldsAnInitStartedInItsOwnNetworkAndRefusesOneThatWasNot(t *testing.T) {
	nocgo.Require(t)
	first, err := os.Readlink("/proc/thread-self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0") // key-gate: loopback-rule the test's stand-in for a vendor agent on the box's loopback
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	start := func(flags uintptr) (string, error) {
		cmd := exec.Command(os.Args[0], keepOwnNetworkArg, listener.Addr().String(), first)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Cloneflags:  flags,
			UidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getuid(), Size: 1}},
			GidMappings: []syscall.SysProcIDMap{{ContainerID: 0, HostID: os.Getgid(), Size: 1}},
		}
		out, err := cmd.Output()
		return string(out), err
	}
	out, err := start(syscall.CLONE_NEWUSER | syscall.CLONE_NEWNET)
	// A host may refuse the user namespace, or make one whose root holds nothing (Ubuntu's AppArmor userns restriction).
	if err != nil && (!strings.HasPrefix(out, "refused") || strings.Contains(out, "operation not permitted")) {
		t.Skipf("this host gives this user no user namespace with a network namespace (%v: %s): run this test binary where it does, as gVisor on Modal does", err, strings.TrimSpace(out))
	}
	if err != nil {
		t.Fatalf("KeepOwnNetwork in a user and network namespace of its own: %v, %q", err, out)
	}
	threads := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		word, rest, _ := strings.Cut(line, " ")
		switch word {
		case "thread":
			threads++
			if rest == first {
				t.Errorf("a thread is in the network namespace the child was started from (%s)", rest)
			}
		case "interfaces":
			if rest != "lo:true" {
				t.Errorf("interfaces %q, want lo alone, up", rest)
			}
		case "parent":
			if !strings.HasPrefix(rest, "refused") {
				t.Errorf("a program reached a listener on the box's loopback: %s", rest)
			}
		case "loopback":
			if rest != "ok" {
				t.Errorf("a program cannot use its own loopback: %s", rest)
			}
		}
	}
	if threads < heldThreads+1 {
		t.Fatalf("the child's lines: %q; want every thread (%d or more)", out, heldThreads+1)
	}

	refused, err := start(syscall.CLONE_NEWUSER)
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 3 || !strings.Contains(refused, "still in the network namespace init started in") {
		t.Fatalf("KeepOwnNetwork started in the first network namespace: %v, %q; want a refusal (exit 3) that says a thread is still in it", err, refused)
	}
}

func TestOwnNetworkRefusesInWordsWithoutThePrivilegeToMakeOne(t *testing.T) {
	nocgo.Require(t)
	if mayMakeNamespaces() {
		t.Skip("runs as root with CAP_SYS_ADMIN, which may make one")
	}
	out, err := exec.Command(os.Args[0], ownNetworkArg, "127.0.0.1:9").Output() // key-gate: loopback-rule a port nothing dials before the refusal
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 3 {
		t.Fatalf("OwnNetwork as uid %d without CAP_SYS_ADMIN: %v, %q; want a refusal (exit 3)", os.Geteuid(), err, out)
	}
	if !strings.Contains(string(out), "network namespace") || !strings.Contains(string(out), "CAP_SYS_ADMIN") {
		t.Fatalf("the refusal %q does not say it could not make a network namespace, nor what it needs", out)
	}
}

// socketErr opens a socket of family domain and closes it: nil when it opened.
func socketErr(domain int) error {
	fd, err := syscall.Socket(domain, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err == nil {
		syscall.Close(fd)
	}
	return err
}

func errnoWords(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("errno %d", int(errno))
	}
	if err == nil {
		return "opened"
	}
	return err.Error()
}

// denySocketsChild sets no_new_privs on every thread, holds threads of its own, calls DenySockets, and prints what its
// threads and a program it starts then see: each thread's Seccomp field, the errno a vsock socket and io_uring_setup
// meet, whether an IPv4 and a unix socket open, and the program's vsock errno.
func denySocketsChild() int {
	if _, _, errno := syscall.AllThreadsSyscall(syscall.SYS_PRCTL, prSetNoNewPriv, 1, 0); errno != 0 {
		fmt.Fprintln(os.Stderr, "no_new_privs:", errno)
		return 1
	}
	holdThreads(heldThreads)
	if err := DenySockets(); err != nil {
		fmt.Println("refused", err)
		return 3
	}
	tasks, err := os.ReadDir("/proc/self/task")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	for _, task := range tasks {
		status, err := os.ReadFile(filepath.Join("/proc/self/task", task.Name(), "status"))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		for line := range strings.Lines(string(status)) {
			if value, found := strings.CutPrefix(line, "Seccomp:"); found {
				fmt.Println("thread seccomp", strings.TrimSpace(value))
			}
		}
	}
	fmt.Println("vsock", errnoWords(socketErr(afVsock)))
	_, _, errno := syscall.Syscall(sysIOURingSetup, 1, uintptr(unsafe.Pointer(nil)), 0)
	fmt.Println("io_uring", errnoWords(errno))
	fmt.Println("inet", errnoWords(socketErr(syscall.AF_INET)))
	fmt.Println("unix", errnoWords(socketErr(syscall.AF_UNIX)))
	program, err := exec.Command(os.Args[0], vsockArg).Output()
	if err != nil {
		fmt.Fprintln(os.Stderr, "the program:", err)
		return 1
	}
	fmt.Print("program ", string(program))
	return 0
}

func TestDenySocketsRefusesVsockAndIOURingOnEveryThreadAndInEveryProgram(t *testing.T) {
	nocgo.Require(t)
	var stderr strings.Builder
	cmd := exec.Command(os.Args[0], denySocketsArg)
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("the child: %v; stdout %q, stderr %s", err, out, stderr.String())
	}
	eperm := fmt.Sprintf("errno %d", int(syscall.EPERM))
	want := map[string]string{"vsock": eperm, "io_uring": eperm, "inet": "opened", "unix": "opened", "program vsock": eperm}
	threads := 0
	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if value, found := strings.CutPrefix(line, "thread seccomp "); found {
			threads++
			if value != "2" {
				t.Errorf("a thread reads Seccomp %s, want 2 (a filter)", value)
			}
			continue
		}
		key, value, _ := strings.Cut(line, " ")
		if key == "program" {
			word, rest, _ := strings.Cut(value, " ")
			key, value = key+" "+word, rest
		}
		got[key] = value
	}
	for key, value := range want {
		if got[key] != value {
			t.Errorf("%s: %q, want %s", key, got[key], value)
		}
	}
	if threads < heldThreads+1 {
		t.Errorf("%d threads read back, want every thread (%d or more): %q", threads, heldThreads+1, out)
	}
}

// fakeProc writes a /proc of the given processes: pid to its Name and Uid lines.
func fakeProc(t *testing.T, processes map[string][2]string) string {
	t.Helper()
	root := t.TempDir()
	for pid, fields := range processes {
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if fields[1] == "" {
			continue // a process that ended between the listing and the read
		}
		status := fmt.Sprintf("Name:\t%s\nUmask:\t0022\nState:\tS (sleeping)\nUid:\t%s\nGid:\t0\t0\t0\t0\n", fields[0], fields[1])
		if err := os.WriteFile(filepath.Join(dir, "status"), []byte(status), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("77", filepath.Join(root, "self")); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestStrangersAreTheOtherProcessesThatHoldTheToolUidInAnyOfTheirIds(t *testing.T) {
	proc := fakeProc(t, map[string][2]string{
		"1":   {"systemd", "0\t0\t0\t0"},
		"42":  {"toolbox", "2510\t2510\t2510\t2510"},
		"77":  {"computerd", "0\t0\t0\t0"},
		"99":  {"helper", "1000\t1000\t2510\t1000"},
		"120": {"gone", ""},
		"130": {"other", "1000\t1000\t1000\t1000"},
	})
	found, err := Strangers(proc, 2510, 77)
	if err != nil {
		t.Fatal(err)
	}
	want := []Stranger{{PID: 42, Name: "toolbox"}, {PID: 99, Name: "helper"}}
	if fmt.Sprint(found) != fmt.Sprint(want) {
		t.Fatalf("strangers %v, want %v", found, want)
	}
	err = RefuseStrangers(proc, 2510, 77)
	if err == nil || !strings.Contains(err.Error(), "42 (toolbox)") || !strings.Contains(err.Error(), "99 (helper)") || !strings.Contains(err.Error(), "uid 2510") {
		t.Fatalf("RefuseStrangers: %v; want a refusal that names each process and the uid", err)
	}
	if err := RefuseStrangers(proc, 3000, 77); err != nil {
		t.Fatalf("RefuseStrangers of a uid no process holds: %v", err)
	}
}

func TestStrangersReadsThisMachinesProcAndFindsNoOtherProcessOfAnUnusedUid(t *testing.T) {
	found, err := Strangers("/proc", 2147483000, os.Getpid())
	if err != nil || len(found) != 0 {
		t.Fatalf("Strangers of an unused uid: %v, %v", found, err)
	}
	// Another process of this test's own uid: a child that waits on its stdin.
	child := exec.Command(os.Args[0], waitArg)
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { stdin.Close(); _ = child.Wait() }()
	found, err = Strangers("/proc", os.Getuid(), os.Getpid())
	if err != nil || !strings.Contains(fmt.Sprint(found), fmt.Sprintf("{%d ", child.Process.Pid)) {
		t.Fatalf("Strangers of this test's own uid: %v, %v; want its child %d among them", found, err, child.Process.Pid)
	}
}

// The E2B live run: a program of the computer's user connected to rpcbind, sshd's unix-local socket, systemd's varlink
// sockets (some PID 1's own) and the journal's stdout socket, all world-writable under /run. Init, still root, takes
// others' access off every such socket: connecting takes write, and a network namespace does not cut a path socket.
func TestCloseSystemSocketsTakesOthersAccessOffEveryWorldWritableSocketUnderTheRoot(t *testing.T) {
	// Short folders: a unix socket's path holds at most 107 bytes, and t.TempDir's carries the test's long name.
	short := func() string {
		dir, err := os.MkdirTemp("/tmp", "css-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.RemoveAll(dir) })
		real, err := filepath.EvalSymlinks(dir)
		if err != nil {
			t.Fatal(err)
		}
		return real
	}
	root := short()
	listen := func(path string, mode os.FileMode) string {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		l, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { l.Close() })
		if err := os.Chmod(path, mode); err != nil {
			t.Fatal(err)
		}
		return path
	}
	world := listen(filepath.Join(root, "systemd", "userdb", "io.systemd.DynamicUser"), 0o666)
	rpcbind := listen(filepath.Join(root, "rpcbind.sock"), 0o777)
	grouped := listen(filepath.Join(root, "agentrun-archil", "archil.sock"), 0o660)
	display := listen(filepath.Join(short(), "X0"), 0o777)
	if err := os.Symlink(display, filepath.Join(root, "link.sock")); err != nil {
		t.Fatal(err)
	}
	if err := CloseSystemSockets(root); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{world: 0o660, rpcbind: 0o770, grouped: 0o660, display: 0o777} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s: mode %o; want %o", path, got, want)
		}
	}
}
