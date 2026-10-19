package logpipe

// Ring keeps the last n lines pushed into it.
type Ring struct {
	lines []string
	next  int
	full  bool
}

// NewRing returns an empty ring holding at most n lines.
func NewRing(n int) *Ring {
	return &Ring{lines: make([]string, n)}
}

// Push adds a line, dropping the oldest one when the ring is full.
func (r *Ring) Push(line string) {
	if len(r.lines) == 0 {
		return
	}
	r.lines[r.next] = line
	r.next++
	if r.next == len(r.lines) {
		r.next = 0
		r.full = true
	}
}

// Lines returns a copy of the held lines, oldest first.
func (r *Ring) Lines() []string {
	if !r.full {
		return append([]string(nil), r.lines[:r.next]...)
	}
	out := make([]string, 0, len(r.lines))
	out = append(out, r.lines[r.next:]...)
	return append(out, r.lines[:r.next]...)
}
