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

// The children this test binary runs as: ownNetworkChild, denySocketsChild and vsockChild.
const (
	ownNetworkArg  = "own-network-child"
	denySocketsArg = "deny-sockets-child"
	vsockArg       = "vsock-child"
	waitArg        = "wait-child"
	prSetNoNewPriv = 38
	heldThreads    = 4
)

func TestMain(m *testing.M) {
	if len(os.Args) >= 2 {
		switch os.Args[1] {
		case ownNetworkArg:
			os.Exit(ownNetworkChild(os.Args[2:]))
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

// ownNetworkChild holds threads of its own, calls OwnNetwork, and prints what a program of its would see: "refused <why>"
// and exit 3 when OwnNetwork refuses; else "first <ns>", "thread <ns>" for each thread, "interfaces <names>", "parent
// <reached|refused: why>" for a dial to the parent's loopback listener at args[0], and "loopback <ok|why>" for a
// listener of its own on its loopback.
func ownNetworkChild(args []string) int {
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
	if err := OwnNetwork(); err != nil {
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
