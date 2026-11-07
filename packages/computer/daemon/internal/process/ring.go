package process

// ring keeps the last size bytes of a stream, addressed by offset since the stream began. It grows as bytes come, so a
// quiet process holds little. A released ring holds nothing and counts what still comes: every byte reads as dropped.
type ring struct {
	size     int
	data     []byte
	total    int64
	released bool
}

// write keeps p and returns how many bytes the ring's buffer grew by.
func (r *ring) write(p []byte) (grew int) {
	end := r.total + int64(len(p))
	if r.released {
		r.total = end
		return 0
	}
	before := cap(r.data)
	if len(p) > r.size {
		p = p[len(p)-r.size:]
	}
	if end <= int64(r.size) {
		r.grow(len(r.data) + len(p))
		r.data = append(r.data, p...)
		r.total = end
		return cap(r.data) - before
	}
	if len(r.data) < r.size {
		r.grow(r.size)
		r.data = r.data[:r.size]
	}
	for at := end - int64(len(p)); len(p) > 0; {
		n := copy(r.data[at%int64(r.size):], p)
		p, at = p[n:], at+int64(n)
	}
	r.total = end
	return cap(r.data) - before
}

// grow makes room for n bytes (at most size), doubling, so the buffer never holds more than size.
func (r *ring) grow(n int) {
	if n <= cap(r.data) {
		return
	}
	data := make([]byte, len(r.data), min(r.size, max(n, 2*cap(r.data))))
	copy(data, r.data)
	r.data = data
}

// release lets the ring's bytes go and returns how many it held.
func (r *ring) release() int {
	held := cap(r.data)
	r.data, r.released = nil, true
	return held
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
