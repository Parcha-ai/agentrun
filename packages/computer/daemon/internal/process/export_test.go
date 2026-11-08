package process

import "os"

// SetLogWriteAt has every log write go through fn until the returned restore is called.
func SetLogWriteAt(fn func(f *os.File, p []byte, off int64) (int, error)) (restore func()) {
	before := logWriteAt
	logWriteAt = fn
	return func() { logWriteAt = before }
}

// Held is how many bytes of output every ring in tbl holds now, counted ring by ring.
func Held(tbl *Table) int64 {
	tbl.mu.Lock()
	defer tbl.mu.Unlock()
	var held int64
	for _, p := range tbl.procs {
		p.mu.Lock()
		for _, s := range p.streams {
			held += int64(cap(s.data))
		}
		p.mu.Unlock()
	}
	return held
}
