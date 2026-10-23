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

// Sample implements Host.
func (h ProcHost) Sample() (Sample, error) {
	root := h.Root
	if root == "" {
		root = "/proc"
	}
	mem, err := memAvailable(filepath.Join(root, "meminfo"))
	if err != nil {
		return Sample{}, err
	}
	load, err := load1(filepath.Join(root, "loadavg"))
	if err != nil {
		return Sample{}, err
	}
	return Sample{MemAvailable: mem, Load1: load}, nil
}

// memAvailable is the MemAvailable line of meminfo at path, in bytes.
func memAvailable(path string) (int64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("capacity: %w", err)
	}
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		rest, ok := strings.CutPrefix(sc.Text(), "MemAvailable:")
		if !ok {
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
		return kb << 10, nil
	}
	return 0, fmt.Errorf("capacity: no MemAvailable in %s", path)
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
