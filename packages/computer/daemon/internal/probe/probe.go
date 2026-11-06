// Package probe is what a provider asks of a computer from inside it, where the vendor's API reads nothing back: who
// the daemon's programs run as, the kernel (gVisor names itself in its release), and which outbound addresses a TCP
// connection reaches. For a computer with network none, nothing reached is the only read-back there is; it shows
// those addresses are blocked, not that every one is.
package probe

import (
	"net"
	"os"
	"sync"
	"syscall"
	"time"
)

// DialTimeout bounds each connection the probe tries.
const DialTimeout = 3 * time.Second

// Result is the probe's report, one JSON line.
type Result struct {
	UID     int      `json:"uid"`
	GID     int      `json:"gid"`
	Kernel  string   `json:"kernel"`
	Reached []string `json:"reached"`
}

// Run tries each host:port target at once, each for at most timeout, and reports the ones a connection reached, in
// the order given.
func Run(targets []string, timeout time.Duration) Result {
	reached := make([]bool, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if conn, err := net.DialTimeout("tcp", target, timeout); err == nil {
				reached[i] = true
				_ = conn.Close()
			}
		}()
	}
	wg.Wait()
	result := Result{UID: os.Getuid(), GID: os.Getgid(), Kernel: kernel(), Reached: []string{}}
	for i, target := range targets {
		if reached[i] {
			result.Reached = append(result.Reached, target)
		}
	}
	return result
}

// kernel is uname's release, or "" when it cannot be read.
func kernel() string {
	var name syscall.Utsname
	if err := syscall.Uname(&name); err != nil {
		return ""
	}
	release := make([]byte, 0, len(name.Release))
	for _, c := range name.Release {
		if c == 0 {
			break
		}
		release = append(release, byte(c))
	}
	return string(release)
}
