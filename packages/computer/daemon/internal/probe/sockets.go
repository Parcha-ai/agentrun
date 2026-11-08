package probe

import (
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

// The walk's bounds, so a large tree (a mounted run folder) costs the probe a bounded time.
const (
	socketWalkEntries = 50_000
	socketWalkDepth   = 8
)

// ConnectableSockets lists the unix sockets with a path that the calling process can connect to: every socket found by
// walking roots (each root by its real path, links never followed, within the walk's bounds) and every path in netUnix
// (the text of /proc/net/unix; abstract names, @..., are the namespace's own and left out). Each is tried with one
// connect bounded by timeout, at once; the real paths of those that accept, sorted.
func ConnectableSockets(roots []string, netUnix string, timeout time.Duration) []string {
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
	entries := 0
	seen := map[string]bool{}
	for _, root := range roots {
		real, err := filepath.EvalSymlinks(root)
		if err != nil || seen[real] {
			continue
		}
		seen[real] = true
		base := strings.Count(real, string(filepath.Separator))
		_ = filepath.WalkDir(real, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable: skipped, as a program could not reach in either
			}
			entries++
			if entries > socketWalkEntries {
				return filepath.SkipAll
			}
			if entry.IsDir() && strings.Count(path, string(filepath.Separator))-base >= socketWalkDepth {
				return filepath.SkipDir
			}
			if entry.Type()&fs.ModeSocket != 0 {
				add(path)
			}
			return nil
		})
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
	connects := []string{}
	for path := range candidates {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := net.DialTimeout("unix", path, timeout)
			if err != nil {
				return
			}
			conn.Close()
			mu.Lock()
			connects = append(connects, path)
			mu.Unlock()
		}()
	}
	wg.Wait()
	sort.Strings(connects)
	return connects
}
