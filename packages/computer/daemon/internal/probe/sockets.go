package probe

import (
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// SocketRoots are where a unix socket with a path that a program could reach is looked for. A network namespace does not
// cut a path socket, and /proc/net/unix lists only the sockets of the reader's own namespace, so the filesystem is walked.
var SocketRoots = []string{"/run", "/tmp", "/var/run", "/var/tmp", "/dev/shm", "/workspace", "/work", "/home", "/opt"}

// SocketBounds bound the walk of each root, so a large tree (a mounted run folder) costs the probe a bounded time and
// cannot leave another root unsearched: Entries per root, and folders at most Depth levels below it.
type SocketBounds struct {
	Entries int
	Depth   int
}

// DefaultSocketBounds are the probe's.
var DefaultSocketBounds = SocketBounds{Entries: 50_000, Depth: 8}

// Socket is one socket a program could connect to: its real path, and the type that connected (stream, dgram or
// seqpacket).
type Socket struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

// SocketSearch is what ConnectableSockets found: the sockets, and, for each root it could not search whole, why, in
// words. A search with any Incomplete is no proof that nothing else is reachable.
type SocketSearch struct {
	Sockets    []Socket `json:"sockets"`
	Incomplete []string `json:"incomplete"`
}

// The socket types a connect is tried with, each by Go's network name and the name reported.
var socketTypes = []struct{ network, name string }{{"unix", "stream"}, {"unixgram", "dgram"}, {"unixpacket", "seqpacket"}}

// ConnectableSockets lists the unix sockets with a path that the calling process can connect to: every socket found by
// walking roots (each root by its real path, links never followed, each within bounds of its own) and every path in
// netUnix (the text of /proc/net/unix; abstract names, @..., are the namespace's own and left out). Each is tried with a
// connect of each type, bounded by timeout, at once; the real paths of those that accept, with the type, sorted by path.
// A root whose walk reached a bound is named in Incomplete.
func ConnectableSockets(roots []string, netUnix string, bounds SocketBounds, timeout time.Duration) SocketSearch {
	candidates := map[string]bool{}
	add := func(path string) {
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return
		}
		if info, err := os.Lstat(real); err == nil && info.Mode()&fs.ModeSocket != 0 {
			candidates[real] = true
		}
	}
	incomplete := []string{}
	seen := map[string]bool{}
	for _, root := range roots {
		real, err := filepath.EvalSymlinks(root)
		if err != nil || seen[real] {
			continue
		}
		seen[real] = true
		base := strings.Count(real, string(filepath.Separator))
		entries, tooDeep, stopped := 0, false, false
		_ = filepath.WalkDir(real, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable: skipped, as a program could not reach in either
			}
			entries++
			if entries > bounds.Entries {
				stopped = true
				return filepath.SkipAll
			}
			if entry.IsDir() && path != real && strings.Count(path, string(filepath.Separator))-base >= bounds.Depth {
				tooDeep = true
				return filepath.SkipDir
			}
			if entry.Type()&fs.ModeSocket != 0 {
				add(path)
			}
			return nil
		})
		switch {
		case stopped:
			incomplete = append(incomplete, fmt.Sprintf("%s: the walk stopped after %d entries, its budget", real, bounds.Entries))
		case tooDeep:
			incomplete = append(incomplete, fmt.Sprintf("%s: folders deeper than %d levels were not searched", real, bounds.Depth))
		}
	}
	for _, line := range strings.Split(netUnix, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 8 || !strings.HasPrefix(fields[7], "/") {
			continue
		}
		add(fields[7])
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sockets := []Socket{}
	for path := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, kind := range socketTypes {
				conn, err := net.DialTimeout(kind.network, path, timeout)
				if err != nil {
					continue
				}
				conn.Close()
				mu.Lock()
				sockets = append(sockets, Socket{Path: path, Type: kind.name})
				mu.Unlock()
				return
			}
		}()
	}
	wg.Wait()
	sort.Slice(sockets, func(i, j int) bool { return sockets[i].Path < sockets[j].Path })
	return SocketSearch{Sockets: sockets, Incomplete: incomplete}
}
