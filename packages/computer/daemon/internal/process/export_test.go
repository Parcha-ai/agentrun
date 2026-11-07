package process

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
