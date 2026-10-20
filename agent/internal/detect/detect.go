// Package detect infers a check configuration from the files at a
// repository root. It reads only the root and the directories that workspace
// globs match, never follows symlinks, caps every file read at maxFileSize,
// never parses lockfile contents, never installs toolchains and never
// proposes deployments.
package detect

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"sort"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

// ErrNothingDetected is returned when no ecosystem yields any check.
var ErrNothingDetected = errors.New("no checks detected")

// Result is a detected configuration plus the reasoning behind it.
type Result struct {
	// Config is built through config.FromRoot, the same path as parsing.
	Config *config.Config
	// Notes explain inferred choices; Render emits them as a header comment.
	Notes []string
	// Sources lists the files and directories that drove detection, sorted.
	Sources []string
}

// partial is one ecosystem's contribution to the merged configuration.
type partial struct {
	ecosystem string
	setup     []config.SetupStep
	jobs      map[string]config.Job
	services  *config.ChecksServices
	notes     []string
	sources   []string
}

// ecosystems run in merge order; setup steps concatenate in this order and a
// later job whose name is taken gets its ecosystem prefix.
var ecosystems = []func(fs.FS) (*partial, error){detectNode, detectGo, detectRust, detectPython}

// Detect inspects the root of fsys and returns the inferred configuration,
// or ErrNothingDetected when no ecosystem matches or none yields a job.
func Detect(fsys fs.FS) (*Result, error) {
	var parts []*partial
	for _, detect := range ecosystems {
		p, err := detect(fsys)
		if err != nil {
			return nil, err
		}
		if p != nil {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return nil, ErrNothingDetected
	}
	services, err := detectCompose(fsys)
	if err != nil {
		return nil, err
	}
	if services != nil {
		parts = append(parts, services)
	}

	checks := &config.Checks{}
	jobs := config.ChecksJobs{}
	var notes, sources []string
	for _, p := range parts {
		checks.Setup = append(checks.Setup, p.setup...)
		for _, name := range sortedKeys(p.jobs) {
			key := name
			for {
				if _, taken := jobs[key]; !taken {
					break
				}
				key = p.ecosystem + "-" + key
			}
			jobs[key] = p.jobs[name]
		}
		if p.services != nil {
			checks.Services = p.services
		}
		notes = append(notes, p.notes...)
		sources = append(sources, p.sources...)
	}
	if len(jobs) == 0 {
		return nil, ErrNothingDetected
	}
	checks.Jobs = jobs

	cfg, diags := config.FromRoot(config.ZeroCIConfig{Version: 1, Checks: checks})
	if diags.HasErrors() {
		return nil, fmt.Errorf("detected configuration does not validate:\n%s", diags.Format("detected"))
	}
	return &Result{Config: cfg, Notes: notes, Sources: uniqueSorted(sources)}, nil
}

// DetectDir runs Detect on dir through an os.Root, so no path can resolve
// outside dir.
func DetectDir(dir string) (*Result, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	return Detect(root.FS())
}

// maxFileSize caps every file detection reads.
const maxFileSize = 1 << 20

// exists reports whether name exists in fsys and is not a symlink.
func exists(fsys fs.FS, name string) bool {
	info, err := fs.Lstat(fsys, name)
	return err == nil && info.Mode()&fs.ModeSymlink == 0
}

// isDir reports whether name is a directory in fsys, not a symlink to one.
func isDir(fsys fs.FS, name string) bool {
	info, err := fs.Lstat(fsys, name)
	return err == nil && info.IsDir()
}

// readFile reads name, refusing symlinks, anything other than a regular file
// and files larger than maxFileSize.
func readFile(fsys fs.FS, name string) ([]byte, error) {
	info, err := fs.Lstat(fsys, name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file (%s); symlinks are not followed", info.Mode().Type())
	}
	f, err := fsys.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFileSize {
		return nil, fmt.Errorf("larger than %d bytes", maxFileSize)
	}
	return data, nil
}

// readOptional returns the file contents, or nil and no error when the file
// does not exist.
func readOptional(fsys fs.FS, name string) ([]byte, error) {
	data, err := readFile(fsys, name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", name, err)
	}
	return data, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func uniqueSorted(ss []string) []string {
	sort.Strings(ss)
	out := ss[:0]
	for i, s := range ss {
		if i == 0 || s != ss[i-1] {
			out = append(out, s)
		}
	}
	return out
}
