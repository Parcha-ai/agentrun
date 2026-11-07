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
		if ppid, _, ok := stat(pid); ok {
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
	_, state, ok := stat(pid)
	return ok && state == "Z"
}

// stat reads the parent and state from /proc/<pid>/stat: the fields after the command name, which may hold spaces and
// parentheses, so it is cut at the last ')'.
func stat(pid int) (ppid int, state string, ok bool) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, "", false
	}
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return 0, "", false
	}
	fields := strings.Fields(string(data[end+1:]))
	if len(fields) < 2 {
		return 0, "", false
	}
	ppid, err = strconv.Atoi(fields[1])
	return ppid, fields[0], err == nil
}
