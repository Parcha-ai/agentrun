// Package proctree reads the process tree from /proc: who is whose child, and who has ended.
package proctree

import (
	"bytes"
	"os"
	"strconv"
	"strings"
)

// Children maps each parent pid to its children's pids, from one pass over /proc/*/stat. It needs no
// CONFIG_PROC_CHILDREN; a process that forks during the pass is found by the next one.
func Children() map[int][]int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		if ppid, _, _, ok := stat(pid); ok {
			children[ppid] = append(children[ppid], pid)
		}
	}
	return children
}

// Descendants lists every process under root.
func Descendants(root int) []int {
	children := Children()
	var found []int
	for queue := []int{root}; len(queue) > 0; queue = queue[1:] {
		for _, child := range children[queue[0]] {
			found = append(found, child)
			queue = append(queue, child)
		}
	}
	return found
}

// Zombie reports whether pid has ended and waits to be reaped.
func Zombie(pid int) bool {
	_, state, _, ok := stat(pid)
	return ok && state == "Z"
}

// Started reads when pid started, in clock ticks after boot. A pid and its start time name one process, even once the
// pid is reused.
func Started(pid int) (started uint64, ok bool) {
	_, _, started, ok = stat(pid)
	return started, ok
}

// Running reports whether the process that is pid and started at started still runs. One that has ended is a zombie
// (Z) until its parent reaps it, and dead (X) while it is reaped; one gone from /proc, or whose pid now names a process
// with another start time, has ended too.
func Running(pid int, started uint64) bool {
	_, state, now, ok := stat(pid)
	return ok && now == started && state != "Z" && state != "X"
}

// stat reads the parent, state and start time from /proc/<pid>/stat: the fields after the command name, which may hold
// spaces and parentheses, so it is cut at the last ')'. The state is field 3, the parent field 4, the start time field 22.
func stat(pid int) (ppid int, state string, started uint64, ok bool) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, "", 0, false
	}
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return 0, "", 0, false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 20 {
		return 0, "", 0, false
	}
	ppid, err = strconv.Atoi(fields[1])
	if err != nil {
		return 0, "", 0, false
	}
	started, err = strconv.ParseUint(fields[19], 10, 64)
	return ppid, fields[0], started, err == nil
}
