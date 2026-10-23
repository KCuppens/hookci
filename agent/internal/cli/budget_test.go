package cli

import (
	"runtime"
	"testing"
)

func TestParseBudget(t *testing.T) {
	all := float64(runtime.NumCPU())
	tests := []struct {
		cpus, mem string
		wantCPUs  float64
		wantMem   int64
		wantErr   bool
	}{
		{"", "", all, 0, false},
		{"0", "", all, 0, false},
		{"6", "24G", 6, 24 << 30, false},
		{"1.5", "", 1.5, 0, false},
		{"-1", "", 0, 0, true},
		{"NaN", "", 0, 0, true},
		{"many", "", 0, 0, true},
		{"", "lots", 0, 0, true},
	}
	for _, tc := range tests {
		b, err := parseBudget(tc.cpus, tc.mem)
		if (err != nil) != tc.wantErr {
			t.Errorf("parseBudget(%q, %q) err = %v, want error %v", tc.cpus, tc.mem, err, tc.wantErr)
			continue
		}
		if err == nil && (b.CPUs != tc.wantCPUs || b.MemoryBytes != tc.wantMem) {
			t.Errorf("parseBudget(%q, %q) = %+v, want %g CPUs, %d bytes", tc.cpus, tc.mem, b, tc.wantCPUs, tc.wantMem)
		}
	}
}
