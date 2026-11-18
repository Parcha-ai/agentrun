//go:build linux

package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// procStatus is what this helper reads from /proc/<pid>/status.
type procStatus struct {
	state      string
	uid, gid   [4]int // real, effective, saved, fs
	groups     []int
	caps       map[string]uint64
	noNewPrivs int
	seen       map[string]bool
}

var capFields = []string{"CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"}

// parseStatus parses the fields it knows and fails on a malformed or
// repeated one. It does not require any field.
func parseStatus(text string) (procStatus, error) {
	st := procStatus{caps: map[string]uint64{}, seen: map[string]bool{}}
	for _, line := range strings.Split(text, "\n") {
		key, val, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		known := true
		var err error
		switch key {
		case "State":
			st.state = val
		case "Uid":
			st.uid, err = parseFour(val)
		case "Gid":
			st.gid, err = parseFour(val)
		case "Groups":
			st.groups, err = parseInts(val)
		case "CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb":
			var v uint64
			v, err = strconv.ParseUint(val, 16, 64)
			st.caps[key] = v
		case "NoNewPrivs":
			st.noNewPrivs, err = strconv.Atoi(val)
		default:
			known = false
		}
		if !known {
			continue
		}
		if err != nil {
			return st, fmt.Errorf("%s: %q: %v", key, val, err)
		}
		if st.seen[key] {
			return st, fmt.Errorf("%s appears twice", key)
		}
		st.seen[key] = true
	}
	return st, nil
}

func parseInts(val string) ([]int, error) {
	var out []int
	for _, f := range strings.Fields(val) {
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, nil
}

func parseFour(val string) ([4]int, error) {
	var out [4]int
	ns, err := parseInts(val)
	if err != nil {
		return out, err
	}
	if len(ns) != 4 {
		return out, fmt.Errorf("want 4 fields, got %d", len(ns))
	}
	copy(out[:], ns)
	return out, nil
}

// verifyStatus accepts only every uid and gid field equal to id, Groups
// exactly groups, every capability set empty and NoNewPrivs 1.
func verifyStatus(text string, id int, groups []int) error {
	st, err := parseStatus(text)
	if err != nil {
		return err
	}
	for _, k := range append([]string{"Uid", "Gid", "Groups", "NoNewPrivs"}, capFields...) {
		if !st.seen[k] {
			return fmt.Errorf("%s is missing", k)
		}
	}
	for i := 0; i < 4; i++ {
		if st.uid[i] != id {
			return fmt.Errorf("Uid is %v, want all %d", st.uid, id)
		}
		if st.gid[i] != id {
			return fmt.Errorf("Gid is %v, want all %d", st.gid, id)
		}
	}
	got := append([]int(nil), st.groups...)
	want := append([]int(nil), groups...)
	sort.Ints(got)
	sort.Ints(want)
	if len(got) != len(want) {
		return fmt.Errorf("Groups is %v, want %v", st.groups, groups)
	}
	for i := range got {
		if got[i] != want[i] {
			return fmt.Errorf("Groups is %v, want %v", st.groups, groups)
		}
	}
	for _, k := range capFields {
		if st.caps[k] != 0 {
			return fmt.Errorf("%s is %016x, want 0", k, st.caps[k])
		}
	}
	if st.noNewPrivs != 1 {
		return fmt.Errorf("NoNewPrivs is %d, want 1", st.noNewPrivs)
	}
	return nil
}

const (
	capSetgid  = 6
	capSetuid  = 7
	capSetpcap = 8
)

// missingCaps names the capabilities this helper needs that CapEff lacks.
func missingCaps(text string) ([]string, error) {
	st, err := parseStatus(text)
	if err != nil {
		return nil, err
	}
	if !st.seen["CapEff"] {
		return nil, fmt.Errorf("CapEff is missing")
	}
	eff := st.caps["CapEff"]
	var missing []string
	for _, c := range []struct {
		bit  uint
		name string
	}{{capSetuid, "CAP_SETUID"}, {capSetgid, "CAP_SETGID"}, {capSetpcap, "CAP_SETPCAP"}} {
		if eff&(1<<c.bit) == 0 {
			missing = append(missing, c.name)
		}
	}
	return missing, nil
}

// procAlive reports a process that is not a zombie and whose real or saved
// uid is uid: the ones kill(-1) as uid reaches. A status it cannot read
// counts as alive.
func procAlive(text string, uid int) bool {
	st, err := parseStatus(text)
	if err != nil || !st.seen["Uid"] {
		return true
	}
	if strings.HasPrefix(st.state, "Z") || strings.HasPrefix(st.state, "X") {
		return false
	}
	return st.uid[0] == uid || st.uid[2] == uid
}
