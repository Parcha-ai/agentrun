// Package probe is what a provider asks of a computer from inside it: who the daemon's programs run as, the kernel,
// and which outbound addresses a connection reaches. Not built yet.
package probe

import "time"

// DialTimeout bounds each connection the probe tries.
const DialTimeout = 3 * time.Second

// Result is the probe's report, one JSON line.
type Result struct {
	UID     int      `json:"uid"`
	GID     int      `json:"gid"`
	Kernel  string   `json:"kernel"`
	Reached []string `json:"reached"`
}

// Run is not built yet.
func Run(targets []string, timeout time.Duration) Result {
	return Result{}
}
