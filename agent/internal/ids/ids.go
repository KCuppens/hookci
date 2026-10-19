// Package ids generates sortable, URL-safe run identifiers.
package ids

import (
	"crypto/rand"
	"io"
	"time"
)

// crockford is the Crockford base32 alphabet: digits and lowercase letters,
// excluding i, l, o, and u to avoid visual ambiguity.
const crockford = "0123456789abcdefghjkmnpqrstvwxyz"

// NewRunID returns a new 26-character run ID encoding the current time and
// cryptographically random entropy, lexically sortable by creation time.
func NewRunID() string {
	return NewRunIDAt(time.Now(), rand.Reader)
}

// NewRunIDAt returns a run ID for time t using r as the source of random
// entropy. It is deterministic for a fixed t and r, which makes it useful
// in tests.
//
// The ID is 26 Crockford base32 characters: the first 10 encode t's Unix
// millisecond timestamp as 48 bits big-endian, and the remaining 16 encode
// 10 random bytes (80 bits). If r returns an error or fewer than 10 bytes,
// the unread trailing bytes stay zero; NewRunIDAt never returns an error,
// since crypto/rand.Reader does not fail on supported platforms.
func NewRunIDAt(t time.Time, r io.Reader) string {
	var ts [6]byte
	ms := uint64(t.UnixMilli())
	ts[0] = byte(ms >> 40)
	ts[1] = byte(ms >> 32)
	ts[2] = byte(ms >> 24)
	ts[3] = byte(ms >> 16)
	ts[4] = byte(ms >> 8)
	ts[5] = byte(ms)

	var entropy [10]byte
	_, _ = io.ReadFull(r, entropy[:])

	var buf [16]byte
	copy(buf[:6], ts[:])
	copy(buf[6:], entropy[:])

	return encode(buf)
}

// encode returns the 26-character Crockford base32 encoding of the 16-byte
// (128-bit) input, split into a 48-bit timestamp and 80-bit entropy as
// described by NewRunIDAt.
func encode(buf [16]byte) string {
	var out [26]byte

	// First 10 chars: 48-bit timestamp (buf[0:6]), 5 bits at a time.
	ts := uint64(buf[0])<<40 | uint64(buf[1])<<32 | uint64(buf[2])<<24 |
		uint64(buf[3])<<16 | uint64(buf[4])<<8 | uint64(buf[5])
	for i := 9; i >= 0; i-- {
		out[i] = crockford[ts&0x1f]
		ts >>= 5
	}

	// Remaining 16 chars: 80-bit entropy (buf[6:16]), 5 bits at a time.
	hi := uint64(buf[6])<<32 | uint64(buf[7])<<24 | uint64(buf[8])<<16 |
		uint64(buf[9])<<8 | uint64(buf[10])
	lo := uint64(buf[11])<<32 | uint64(buf[12])<<24 | uint64(buf[13])<<16 |
		uint64(buf[14])<<8 | uint64(buf[15])

	// hi holds 40 bits (buf[6:11]) -> 8 chars; lo holds 40 bits (buf[11:16]) -> 8 chars.
	for i := 17; i >= 10; i-- {
		out[i] = crockford[hi&0x1f]
		hi >>= 5
	}
	for i := 25; i >= 18; i-- {
		out[i] = crockford[lo&0x1f]
		lo >>= 5
	}

	return string(out[:])
}

// ValidRunID reports whether s has the shape of a value produced by NewRunID
// or NewRunIDAt: 26 lowercase Crockford base32 characters, with the first
// character in 0-7 to guard against 48-bit timestamp overflow.
func ValidRunID(s string) bool {
	if len(s) != 26 {
		return false
	}
	if s[0] < '0' || s[0] > '7' {
		return false
	}
	for i := range len(s) {
		if !isCrockford(s[i]) {
			return false
		}
	}
	return true
}

func isCrockford(c byte) bool {
	switch {
	case c >= '0' && c <= '9':
		return true
	case c >= 'a' && c <= 'z':
		switch c {
		case 'i', 'l', 'o', 'u':
			return false
		}
		return true
	default:
		return false
	}
}
