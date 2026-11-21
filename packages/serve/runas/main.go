//go:build linux

// Command agentrun-runas starts a run's process as a uid of its own.
//
// The runner runs as uid 1000 with no root, in its own group (1000) alone.
// This helper is installed root:node 0750 with file capabilities
// cap_chown,cap_setuid,cap_setgid,cap_setpcap+ep and can only reach the
// compiled range firstID..firstID+slots-1. It never takes an id from its
// input except through that slot mapping, and it refuses uid and gid 0
// outright.
//
// A slot's uid is in its own group alone, never the runner's: a run's
// folders are its slot's uid's and the runner's group's (2770, setgid), so
// the runner reads them through its one group and no other slot reaches
// them. Between runs they are the runner's (own runner), so a slot's next
// run reaches nothing an earlier one left. The runner is in no slot's group.
//
// Build with CGO_ENABLED=0: Go's syscall.Setresuid, Setresgid and Setgroups
// then apply to every thread (AllThreadsSyscall).
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	firstID = 1001
	slots   = 256
	// serverGID is the runner's group: every run folder's group, the one
	// group through which the runner reads what a run writes.
	serverGID = 1000

	exitRefused = 126
	exitUsage   = 2

	killTries = 2000
	killPause = 5 * time.Millisecond
)

const usageLine = "usage: agentrun-runas run <slot> [--keep-fd N]... -- <program> [args...]" +
	" | reap <slot> [--sweep DIR]..." +
	" | own <slot>|runner DIR... | check"

// Capabilities are per thread, so every step runs on the main thread.
func init() { runtime.LockOSThread() }

func main() {
	os.Exit(runMain(os.Args[1:], realSys{}, os.Stdout, os.Stderr))
}

func say(w io.Writer, format string, a ...any) {
	fmt.Fprintf(w, "agentrun-runas: "+format+"\n", a...)
}

func fail(w io.Writer, code int, format string, a ...any) int {
	say(w, format, a...)
	return code
}

func usage(w io.Writer) int { return fail(w, exitUsage, "%s", usageLine) }

func runMain(args []string, s sys, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return usage(stderr)
	}
	switch args[0] {
	case "run":
		return cmdRun(args[1:], s, stderr)
	case "reap":
		return cmdReap(args[1:], s, stderr)
	case "own":
		return cmdOwn(args[1:], s, stderr)
	case "check":
		return cmdCheck(args[1:], s, stdout, stderr)
	}
	return usage(stderr)
}

// parseSlot accepts a plain decimal 0..slots-1: no sign, no spaces, no
// leading zeros, no exponent.
func parseSlot(s string) (int, error) {
	bad := fmt.Errorf("slot %q is not a decimal 0..%d", s, slots-1)
	if s == "" || len(s) > len(strconv.Itoa(slots-1)) {
		return 0, bad
	}
	if len(s) > 1 && s[0] == '0' {
		return 0, bad
	}
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, bad
		}
		n = n*10 + int(c-'0')
	}
	if n >= slots {
		return 0, bad
	}
	return n, nil
}

// slotID is the only way from input to an id.
func slotID(slot int) (int, error) {
	if slot < 0 || slot >= slots {
		return 0, fmt.Errorf("slot %d is outside 0..%d", slot, slots-1)
	}
	id := firstID + slot
	if err := checkIDs(id, id); err != nil {
		return 0, err
	}
	return id, nil
}

// checkIDs refuses uid or gid 0 and anything outside the compiled range.
func checkIDs(uid, gid int) error {
	if uid == 0 || gid == 0 {
		return errors.New("refusing uid or gid 0")
	}
	if !inRange(uid) || !inRange(gid) {
		return fmt.Errorf("uid %d gid %d outside %d-%d", uid, gid, firstID, firstID+slots-1)
	}
	return nil
}

// checkGroup allows a slot group alone, never 0 and never the runner's: a
// process this helper starts holds no group of the runner's.
func checkGroup(g int) error {
	if g == 0 {
		return errors.New("refusing group 0")
	}
	if !inRange(g) {
		return fmt.Errorf("group %d outside %d-%d", g, firstID, firstID+slots-1)
	}
	return nil
}

func inRange(id int) bool { return id >= firstID && id < firstID+slots }

// parseFd accepts a plain decimal fd.
func parseFd(s string) (int, error) {
	if s == "" || len(s) > 9 || (len(s) > 1 && s[0] == '0') {
		return 0, fmt.Errorf("fd %q is not a decimal", s)
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("fd %q is not a decimal", s)
		}
	}
	return strconv.Atoi(s)
}

// fdsToClose returns the open fds >= 3 that are not kept, in order.
func fdsToClose(open, keep []int) ([]int, error) {
	kept := map[int]bool{}
	for _, fd := range keep {
		if fd < 3 {
			return nil, fmt.Errorf("--keep-fd %d: kept fds must be >= 3", fd)
		}
		kept[fd] = true
	}
	var out []int
	seen := map[int]bool{}
	for _, fd := range open {
		if fd >= 3 && !kept[fd] && !seen[fd] {
			seen[fd] = true
			out = append(out, fd)
		}
	}
	sort.Ints(out)
	return out, nil
}

// dropPrivs moves this thread to id with exactly groups and no capabilities.
func dropPrivs(s sys, id int, groups []int) error {
	if err := checkIDs(id, id); err != nil {
		return err
	}
	for _, g := range groups {
		if err := checkGroup(g); err != nil {
			return err
		}
	}
	if err := s.Setgroups(groups); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	if err := s.Setresgid(id, id, id); err != nil {
		return fmt.Errorf("setresgid: %w", err)
	}
	if err := s.Setresuid(id, id, id); err != nil {
		return fmt.Errorf("setresuid: %w", err)
	}
	last, err := s.CapLastCap()
	if err != nil {
		return fmt.Errorf("cap_last_cap: %w", err)
	}
	if last < 0 || last > 63 {
		return fmt.Errorf("cap_last_cap: %d is out of range", last)
	}
	// PR_CAPBSET_DROP needs CAP_SETPCAP; that is the only use of setpcap.
	for c := 0; c <= last; c++ {
		if err := s.CapbsetDrop(c); err != nil {
			return fmt.Errorf("drop bounding cap %d: %w", c, err)
		}
	}
	if err := s.AmbientClearAll(); err != nil {
		return fmt.Errorf("clear ambient caps: %w", err)
	}
	if err := s.CapsetZero(); err != nil {
		return fmt.Errorf("capset: %w", err)
	}
	if err := s.SetNoNewPrivs(); err != nil {
		return fmt.Errorf("no_new_privs: %w", err)
	}
	return nil
}

// verifyDropped reads this thread's status and checks it against id/groups.
func verifyDropped(s sys, id int, groups []int) error {
	text, err := s.ReadStatus()
	if err != nil {
		return fmt.Errorf("read status: %w", err)
	}
	if err := verifyStatus(text, id, groups); err != nil {
		return fmt.Errorf("status check: %w", err)
	}
	return nil
}

func cmdRun(args []string, s sys, stderr io.Writer) int {
	if len(args) < 1 {
		return usage(stderr)
	}
	slot, err := parseSlot(args[0])
	if err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	id, err := slotID(slot)
	if err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	var keep []int
	rest := args[1:]
	for {
		if len(rest) == 0 {
			return usage(stderr)
		}
		if rest[0] == "--" {
			rest = rest[1:]
			break
		}
		if rest[0] != "--keep-fd" || len(rest) < 2 {
			return usage(stderr)
		}
		fd, err := parseFd(rest[1])
		if err != nil {
			return fail(stderr, exitRefused, "%v", err)
		}
		keep = append(keep, fd)
		rest = rest[2:]
	}
	if len(rest) == 0 {
		return usage(stderr)
	}
	program := rest[0]
	if !filepath.IsAbs(program) {
		return fail(stderr, exitRefused, "program %q must be an absolute path", program)
	}

	ppid := s.Getppid()

	open, err := s.ListFds()
	if err != nil {
		return fail(stderr, exitRefused, "list fds: %v", err)
	}
	toClose, err := fdsToClose(open, keep)
	if err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	for _, fd := range toClose {
		if err := s.CloseFd(fd); err != nil && !errors.Is(err, syscall.EBADF) {
			return fail(stderr, exitRefused, "close fd %d: %v", fd, err)
		}
	}

	if err := dropPrivs(s, id, []int{id}); err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	// The kernel clears the death signal on a credential change, so it is
	// set after it.
	if err := s.SetPdeathsig(); err != nil {
		return fail(stderr, exitRefused, "pdeathsig: %v", err)
	}
	if s.Getppid() != ppid {
		return fail(stderr, exitRefused, "parent exited before exec")
	}
	s.Umask(0o007)
	if err := verifyDropped(s, id, []int{id}); err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	argv := append([]string{program}, rest[1:]...)
	if err := s.Exec(program, argv, os.Environ()); err != nil {
		return fail(stderr, exitRefused, "exec %s: %v", program, err)
	}
	// Only a fake exec returns without an error.
	return 0
}

func cmdReap(args []string, s sys, stderr io.Writer) int {
	if len(args) < 1 {
		return usage(stderr)
	}
	slot, err := parseSlot(args[0])
	if err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	id, err := slotID(slot)
	if err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	var sweep []string
	rest := args[1:]
	for len(rest) > 0 {
		if len(rest) < 2 || rest[0] != "--sweep" {
			return usage(stderr)
		}
		if !filepath.IsAbs(rest[1]) {
			return fail(stderr, exitRefused, "%s %q must be an absolute path", rest[0], rest[1])
		}
		sweep = append(sweep, rest[1])
		rest = rest[2:]
	}
	groups := []int{id}
	if err := dropPrivs(s, id, groups); err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	if err := verifyDropped(s, id, groups); err != nil {
		return fail(stderr, exitRefused, "%v", err)
	}
	if err := killAll(s, id); err != nil {
		return fail(stderr, 1, "%v", err)
	}
	ok := true
	for _, dir := range sweep {
		if !sweepDir(dir, id, stderr) {
			ok = false
		}
	}
	if !ok {
		return 1
	}
	return 0
}

// killAll signals every process of this uid until none is left alive.
// kill(-1) as an unprivileged uid returns 0 while any other process exists
// in the pid namespace, even one it may not signal, so ESRCH alone never
// ends the loop under a runner; a /proc count of this uid's live
// processes does.
func killAll(s sys, id int) error {
	for i := 0; i < killTries; i++ {
		err := s.Kill(-1, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("kill: %w", err)
		}
		n, err := s.LiveProcs(id)
		if err != nil {
			return fmt.Errorf("count processes: %w", err)
		}
		if n == 0 {
			return nil
		}
		s.Sleep(killPause)
	}
	return fmt.Errorf("processes of uid %d still alive after %d kills", id, killTries)
}

// cmdOwn gives a run's folders to a slot (`own <slot> DIR...`, before its
// run starts) or back to the runner (`own runner DIR...`, after its reap):
// every entry under each DIR owned by the runner or any slot, to that uid
// and the runner's group, its mode fixMode's. It keeps CAP_CHOWN alone, the
// one it uses, and runs as the runner (its real uid), never as a slot.
func cmdOwn(args []string, s sys, stderr io.Writer) int {
	if len(args) < 2 {
		return usage(stderr)
	}
	runner := s.Getuid()
	if runner == 0 || inRange(runner) {
		return fail(stderr, exitRefused, "refusing to run as uid %d: own runs as the runner", runner)
	}
	to := runner
	if args[0] != "runner" {
		slot, err := parseSlot(args[0])
		if err != nil {
			return fail(stderr, exitRefused, "%v", err)
		}
		if to, err = slotID(slot); err != nil {
			return fail(stderr, exitRefused, "%v", err)
		}
	}
	dirs := args[1:]
	for _, dir := range dirs {
		if !filepath.IsAbs(dir) {
			return fail(stderr, exitRefused, "DIR %q must be an absolute path", dir)
		}
	}
	if err := s.CapsetOnly(1 << capChown); err != nil {
		return fail(stderr, exitRefused, "capset: %v", err)
	}
	text, err := s.ReadStatus()
	if err != nil {
		return fail(stderr, exitRefused, "read status: %v", err)
	}
	if err := verifyOnlyCap(text, capChown); err != nil {
		return fail(stderr, exitRefused, "status check: %v", err)
	}
	owned := func(uid int) bool { return uid == runner || inRange(uid) }
	ok := true
	for _, dir := range dirs {
		if !s.Own(dir, owned, runner, to, serverGID, stderr) {
			ok = false
		}
	}
	if !ok {
		return 1
	}
	return 0
}

func cmdCheck(args []string, s sys, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		return usage(stderr)
	}
	text, err := s.ReadStatus()
	if err != nil {
		return fail(stderr, 1, "read status: %v", err)
	}
	missing, err := missingCaps(text)
	if err != nil {
		return fail(stderr, 1, "%v", err)
	}
	if len(missing) > 0 {
		return fail(stderr, 1, "missing %s in the effective set: this platform strips file capabilities, or sets no-new-privileges",
			strings.Join(missing, ", "))
	}
	fmt.Fprintf(stdout, "agentrun-runas: range %d-%d\n", firstID, firstID+slots-1)
	return 0
}
