package methods_test

import (
	"strings"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
)

type listedProcess struct {
	ID          string   `json:"id"`
	Argv        []string `json:"argv"`
	ArgvClipped bool     `json:"argvClipped"`
	Running     bool     `json:"running"`
}

type listPage struct {
	Processes []listedProcess `json:"processes"`
	Truncated bool            `json:"truncated"`
	Next      int64           `json:"next"`
}

// A full table of processes with large argvs is listed in pages that each fit a line: every entry once, in start
// order, with an argv too large for a listing clipped to its first arguments and said to be.
func TestAFullTableWithLargeArgvsIsListedInPagesUnderTheLineLimit(t *testing.T) {
	c := dial(t)
	moderate := strings.Repeat("x", 40<<10)
	// '<' is escaped as < in JSON, six bytes for one.
	huge := strings.Repeat("<x", 50<<10)
	var ids []string
	for i := range process.MaxEntries {
		argv := []string{"true", moderate}
		if i%2 == 1 {
			argv = []string{"true", "short", huge, huge}
		}
		var started struct {
			ID string `json:"id"`
		}
		c.ok("process.start", map[string]any{"argv": argv}, &started)
		ids = append(ids, started.ID)
	}
	var seen []listedProcess
	pages := 0
	params := map[string]any{}
	for {
		var page listPage
		// c.call fails the test on any line over rpc.MaxLine; a reply over it would come back as a limit error.
		c.ok("process.list", params, &page)
		pages++
		if len(page.Processes) == 0 && page.Truncated {
			t.Fatalf("an empty page that says it is truncated, from %v", params["from"])
		}
		seen = append(seen, page.Processes...)
		if !page.Truncated {
			break
		}
		params = map[string]any{"from": page.Next}
	}
	if len(seen) != process.MaxEntries || pages < 2 {
		t.Fatalf("listed %d processes in %d pages", len(seen), pages)
	}
	for i, p := range seen {
		if p.ID != ids[i] {
			t.Fatalf("entry %d is %s, want %s", i, p.ID, ids[i])
		}
		if i%2 == 0 && (p.ArgvClipped || len(p.Argv) != 2 || p.Argv[1] != moderate) {
			t.Fatalf("entry %d should be whole: clipped %v, %d args", i, p.ArgvClipped, len(p.Argv))
		}
		if i%2 == 1 && (!p.ArgvClipped || strings.Join(p.Argv, " ") != "true short") {
			t.Fatalf("entry %d should be clipped to its first arguments: clipped %v, %.40q", i, p.ArgvClipped, p.Argv)
		}
	}
	c.fails("process.list", map[string]any{"from": -1}, "invalid")
	c.fails("process.list", map[string]any{"offset": 0}, "invalid")
	var past listPage
	c.ok("process.list", map[string]any{"from": 1000}, &past)
	if len(past.Processes) != 0 || past.Truncated || past.Processes == nil {
		t.Fatalf("a list past the end: %+v", past)
	}
}
