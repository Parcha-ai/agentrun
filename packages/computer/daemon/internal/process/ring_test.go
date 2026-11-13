package process

import (
	"bytes"
	"testing"
)

// pattern is n bytes from offset from of a stream whose byte at offset o is o mod 251.
func pattern(from, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte((from + i) % 251)
	}
	return b
}

// A limited ring keeps the newest bytes in order, at their offsets, before and after it wraps, and reads report what
// it dropped.
func TestALimitedRingKeepsItsNewestBytesInOrder(t *testing.T) {
	for _, tc := range []struct {
		name          string
		size, limit   int
		before, after int
	}{
		{"not yet full, within the limit", 64, 32, 20, 40},
		{"not yet full, past the limit", 64, 16, 40, 30},
		{"wrapped", 64, 24, 150, 37},
		{"wrapped at the limit's edge", 64, 16, 128, 16},
		{"a limit at its size changes nothing", 64, 64, 100, 10},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := ring{size: tc.size}
			for at := 0; at < tc.before; at += 7 {
				r.write(pattern(at, min(7, tc.before-at)))
			}
			held := cap(r.data)
			freed := r.limit(tc.limit)
			if cap(r.data) > max(tc.limit, min(held, tc.size)) || freed != held-cap(r.data) {
				t.Fatalf("after limit(%d) the ring holds %d bytes and says it freed %d of %d", tc.limit, cap(r.data), freed, held)
			}
			check := func(total int) {
				t.Helper()
				keep := min(total, tc.limit, tc.size)
				data, next, dropped := r.read(0, total)
				if int(next) != total || int(dropped) != total-keep || !bytes.Equal(data, pattern(total-keep, keep)) {
					t.Fatalf("read of %d bytes: next %d, dropped %d, data %v, want the last %d", total, next, dropped, data, keep)
				}
			}
			check(tc.before)
			for at := tc.before; at < tc.before+tc.after; at += 5 {
				r.write(pattern(at, min(5, tc.before+tc.after-at)))
			}
			check(tc.before + tc.after)
			if cap(r.data) > tc.limit {
				t.Fatalf("the ring grew past its limit of %d to %d", tc.limit, cap(r.data))
			}
		})
	}
}
