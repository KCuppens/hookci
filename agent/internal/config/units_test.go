package config

import (
	"testing"
	"time"
)

func TestParseMemory(t *testing.T) {
	valid := map[string]int64{
		"4G":   4 << 30,
		"512M": 512 << 20,
		"1.5G": 3 << 29,
		"100K": 100 << 10,
	}
	for in, want := range valid {
		got, err := ParseMemory(in)
		if err != nil || got != want {
			t.Errorf("ParseMemory(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"4GB", "-1G", "G", "", "4", "4g", "0G", "1.G", "99999999999G"} {
		if got, err := ParseMemory(in); err == nil {
			t.Errorf("ParseMemory(%q) = %d, want an error", in, got)
		}
	}
}

func TestParseDuration(t *testing.T) {
	valid := map[string]time.Duration{
		"90s": 90 * time.Second,
		"10m": 10 * time.Minute,
		"1h":  time.Hour,
	}
	for in, want := range valid {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"10", "1d", "-5m", "1.5h", "0s", "", "1h30m", "99999999999999h"} {
		if got, err := ParseDuration(in); err == nil {
			t.Errorf("ParseDuration(%q) = %v, want an error", in, got)
		}
	}
}
