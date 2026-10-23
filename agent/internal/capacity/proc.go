package capacity

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// ProcHost samples the host from a procfs mount, /proc unless Root is set.
type ProcHost struct {
	Root string
}

// Sample implements Host. A kernel without pressure stall information (no
// pressure/ files, or ones that cannot be read) yields a Sample with PSI
// false, not an error.
func (h ProcHost) Sample() (Sample, error) {
	root := h.Root
	if root == "" {
		root = "/proc"
	}
	total, avail, err := meminfo(filepath.Join(root, "meminfo"))
	if err != nil {
		return Sample{}, err
	}
	load, err := load1(filepath.Join(root, "loadavg"))
	if err != nil {
		return Sample{}, err
	}
	s := Sample{MemTotal: total, MemAvailable: avail, Load1: load}
	cpu, cpuErr := pressure(filepath.Join(root, "pressure", "cpu"))
	mem, memErr := pressure(filepath.Join(root, "pressure", "memory"))
	if cpuErr == nil && memErr == nil {
		s.PSI, s.CPUPressure, s.MemPressure = true, cpu, mem
	}
	return s, nil
}

// meminfo is the MemTotal (0 when absent) and MemAvailable lines of meminfo
// at path, in bytes.
func meminfo(path string) (total, available int64, err error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, 0, fmt.Errorf("capacity: %w", err)
	}
	found := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		key, rest, ok := strings.Cut(sc.Text(), ":")
		if !ok || (key != "MemTotal" && key != "MemAvailable") {
			continue
		}
		f := strings.Fields(rest)
		if len(f) != 2 || f[1] != "kB" {
			break
		}
		kb, err := strconv.ParseInt(f[0], 10, 64)
		if err != nil {
			break
		}
		if key == "MemTotal" {
			total = kb << 10
			continue
		}
		available, found = kb<<10, true
	}
	if !found {
		return 0, 0, fmt.Errorf("capacity: no MemAvailable in %s", path)
	}
	return total, available, nil
}

// load1 is the one-minute load average of loadavg at path.
func load1(path string) (float64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("capacity: %w", err)
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0, fmt.Errorf("capacity: empty %s", path)
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, fmt.Errorf("capacity: %s: %w", path, err)
	}
	return v, nil
}

// pressure is avg10 of the "some" line of the PSI file at path, in percent.
// The error wraps fs.ErrNotExist when the kernel has no such file.
func pressure(path string) (float64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("capacity: %w", err)
	}
	for line := range strings.Lines(string(b)) {
		f := strings.Fields(line)
		if len(f) == 0 || f[0] != "some" {
			continue
		}
		for _, kv := range f[1:] {
			v, ok := strings.CutPrefix(kv, "avg10=")
			if !ok {
				continue
			}
			n, err := strconv.ParseFloat(v, 64)
			if err != nil || n < 0 {
				return 0, fmt.Errorf("capacity: %s: bad avg10 %q", path, v)
			}
			return n, nil
		}
	}
	return 0, fmt.Errorf("capacity: no some avg10 in %s", path)
}
