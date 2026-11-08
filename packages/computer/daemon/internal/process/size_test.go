package process_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/Parcha-ai/agentrun/packages/computer/daemon/internal/process"
)

// sizeOf is a read's size as its reply line carries it: the stream's bytes so far, every one since the start.
func sizeOf(t *testing.T, res process.ReadResult) any {
	t.Helper()
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	return fields["size"]
}

// A read says how many bytes the stream holds so far, whatever part of it the read returned, and past what the ring
// dropped: a caller pages and says "bytes 1 to 3 of 5" with no read to the end.
func TestReadSize(t *testing.T) {
	tbl := table(t, process.Options{RingBytes: 4})
	p := start(t, tbl, process.StartParams{Argv: []string{"sh", "-c", "printf hello; printf oops >&2"}})
	wait(t, tbl, p.ID)
	two := 2
	res, err := tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(1), MaxBytes: &two})
	if err != nil || string(res.Data) != "el" || res.Dropped != 0 {
		// The ring of 4 holds "ello": a read from 1 drops nothing.
		t.Fatalf("read at 1, 2 bytes: %+v %v", res, err)
	}
	if got := sizeOf(t, res); got != float64(5) {
		t.Fatalf("size %v, not 5", got)
	}
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stdout", Offset: off(0)})
	if err != nil || string(res.Data) != "ello" || res.Dropped != 1 {
		t.Fatalf("read at 0: %+v %v", res, err)
	}
	if got := sizeOf(t, res); got != float64(5) {
		t.Fatalf("size after a drop %v, not 5", got)
	}
	res, err = tbl.Read(context.Background(), process.ReadParams{ID: p.ID, Stream: "stderr", Offset: off(4)})
	if err != nil || len(res.Data) != 0 {
		t.Fatalf("stderr at its end: %+v %v", res, err)
	}
	if got := sizeOf(t, res); got != float64(4) {
		t.Fatalf("stderr's size %v, not 4", got)
	}
}
