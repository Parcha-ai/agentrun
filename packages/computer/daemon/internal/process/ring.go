package process

// ring keeps the last size bytes of a stream, addressed by offset since the stream began. It grows as bytes come, so a
// quiet process holds little.
type ring struct {
	size  int
	data  []byte
	total int64
}

func (r *ring) write(p []byte) {
	end := r.total + int64(len(p))
	if len(p) > r.size {
		p = p[len(p)-r.size:]
	}
	if end <= int64(r.size) {
		r.data = append(r.data, p...)
		r.total = end
		return
	}
	if len(r.data) < r.size {
		r.data = append(r.data, make([]byte, r.size-len(r.data))...)
	}
	for at := end - int64(len(p)); len(p) > 0; {
		n := copy(r.data[at%int64(r.size):], p)
		p, at = p[n:], at+int64(n)
	}
	r.total = end
}

// read returns at most max bytes from offset (at most r.total), and how many bytes before offset the ring has dropped:
// a read below the ring's start begins at its start.
func (r *ring) read(offset int64, max int) (data []byte, next, dropped int64) {
	if first := r.total - int64(len(r.data)); offset < first {
		dropped, offset = first-offset, first
	}
	n := int(min(int64(max), r.total-offset))
	data = make([]byte, n)
	for i := 0; i < n; {
		i += copy(data[i:], r.data[(offset+int64(i))%int64(r.size):])
	}
	return data, offset + int64(n), dropped
}
