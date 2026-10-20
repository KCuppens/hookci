package config

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"
)

var (
	memoryRe   = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)([KMG])$`)
	durationRe = regexp.MustCompile(`^([0-9]+)([smh])$`)
)

// ParseMemory parses a memory size with a K, M or G suffix (powers of 1024),
// for example "4G", "512M" or "1.5G", into bytes.
func ParseMemory(s string) (int64, error) {
	m := memoryRe.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("memory %s: want a number with a K, M or G suffix, for example 4G or 512M", quote(s))
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, fmt.Errorf("memory %s: %w", quote(s), err)
	}
	var unit float64
	switch m[2] {
	case "K":
		unit = 1 << 10
	case "M":
		unit = 1 << 20
	case "G":
		unit = 1 << 30
	}
	bytes := math.Round(n * unit)
	if bytes <= 0 {
		return 0, fmt.Errorf("memory %s: must be greater than zero", quote(s))
	}
	if bytes >= math.MaxInt64 {
		return 0, fmt.Errorf("memory %s: too large", quote(s))
	}
	return int64(bytes), nil
}

// ParseDuration parses a whole number with an s, m or h suffix, for example
// "90s", "10m" or "1h".
func ParseDuration(s string) (time.Duration, error) {
	m := durationRe.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("duration %s: want a whole number with an s, m or h suffix, for example 90s or 10m", quote(s))
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("duration %s: %w", quote(s), errors.Unwrap(err))
	}
	var unit time.Duration
	switch m[2] {
	case "s":
		unit = time.Second
	case "m":
		unit = time.Minute
	case "h":
		unit = time.Hour
	}
	if n == 0 {
		return 0, fmt.Errorf("duration %s: must be greater than zero", quote(s))
	}
	if n > int64(math.MaxInt64/unit) {
		return 0, fmt.Errorf("duration %s: too large", quote(s))
	}
	return time.Duration(n) * unit, nil
}
