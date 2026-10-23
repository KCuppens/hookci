package cache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/source"
)

// Key identifies one snapshot.
type Key struct {
	TrustDomain string   `json:"trust_domain"` // "trusted:<repo>" or "untrusted:<repo>"; local runs use source.LocalStorageRepo for <repo>
	Scope       string   `json:"scope"`        // branch the entry belongs to; a run saves only under its own branch
	Platform    string   `json:"platform"`     // runtime.GOOS + "-" + runtime.GOARCH
	FileHashes  []string `json:"file_hashes"`  // "<relpath>:<sha256 hex>" for every key file, sorted
	Paths       []string `json:"paths"`        // cleaned relative cache paths, sorted
	Hash        string   `json:"hash"`         // hex sha256 over all of the above, each field length-prefixed
}

// ComputeKey hashes key files relative to workdir. Missing key files hash as "<relpath>:missing".
func ComputeKey(trustDomain, scope, platform, workdir string, keyFiles, paths []string) (Key, error) {
	if _, err := domainDir(trustDomain); err != nil {
		return Key{}, err
	}
	if platform == "" {
		return Key{}, errors.New("cache: platform is empty")
	}
	cleanPaths, err := cleanRels(paths)
	if err != nil {
		return Key{}, err
	}
	files, err := cleanRels(keyFiles)
	if err != nil {
		return Key{}, err
	}
	// os.Root refuses symlinks that leave workdir, so a key file cannot pull
	// a host file into the hash.
	root, err := os.OpenRoot(workdir)
	if err != nil {
		return Key{}, fmt.Errorf("cache: open workdir: %w", err)
	}
	defer root.Close()
	hashes := make([]string, 0, len(files))
	for _, f := range files {
		data, err := root.ReadFile(f)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			hashes = append(hashes, f+":missing")
		case err != nil:
			return Key{}, fmt.Errorf("cache: read key file %s: %w", f, err)
		default:
			sum := sha256.Sum256(data)
			hashes = append(hashes, f+":"+hex.EncodeToString(sum[:]))
		}
	}
	k := Key{TrustDomain: trustDomain, Scope: scope, Platform: platform, FileHashes: hashes, Paths: cleanPaths}
	k.Hash = k.sum()
	return k, nil
}

// InScope returns k under scope with its hash recomputed, so one run can
// look up the same lockfile in several branches without rehashing files.
func (k Key) InScope(scope string) Key {
	k.Scope = scope
	k.Hash = k.sum()
	return k
}

// sum is the hex sha256 of the key fields. Every field is prefixed with its
// length and each list with its count, so no two distinct keys share input.
func (k Key) sum() string {
	h := sha256.New()
	var n [8]byte
	put := func(v int) {
		binary.BigEndian.PutUint64(n[:], uint64(v))
		h.Write(n[:])
	}
	field := func(s string) {
		put(len(s))
		h.Write([]byte(s))
	}
	field(k.TrustDomain)
	field(k.Scope)
	field(k.Platform)
	for _, list := range [][]string{k.FileHashes, k.Paths} {
		put(len(list))
		for _, s := range list {
			field(s)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// entryRel validates k and returns its entry directory relative to the
// cache root: <sanitized trust domain>/<Hash>.
func (k Key) entryRel() (string, error) {
	dom, err := domainDir(k.TrustDomain)
	if err != nil {
		return "", err
	}
	for _, p := range k.Paths {
		if _, err := cleanRel(p); err != nil {
			return "", err
		}
	}
	if k.Hash == "" || k.Hash != k.sum() {
		return "", errors.New("cache: key hash does not match its fields")
	}
	return filepath.Join(dom, k.Hash), nil
}

// domainDir maps "trusted:owner/name" to "trusted__owner__name" with
// source.Slug rules. Only the trusted and untrusted prefixes exist, so the
// two domains of one repo always land in different directories.
func domainDir(trustDomain string) (string, error) {
	prefix, repo, ok := strings.Cut(trustDomain, ":")
	if !ok || (prefix != "trusted" && prefix != "untrusted") {
		return "", fmt.Errorf("cache: trust domain %q must be trusted:<repo> or untrusted:<repo>", trustDomain)
	}
	slug, err := source.Slug(repo)
	if err != nil {
		return "", fmt.Errorf("cache: trust domain %q: %w", trustDomain, err)
	}
	return prefix + "__" + slug, nil
}

// cleanRels cleans every path, then sorts and dedupes the result.
func cleanRels(paths []string) ([]string, error) {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		c, err := cleanRel(p)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	slices.Sort(out)
	return slices.Compact(out), nil
}

// cleanRel cleans p and rejects absolute paths, paths that leave the
// workdir and the workdir itself.
func cleanRel(p string) (string, error) {
	c := filepath.Clean(p)
	if !filepath.IsLocal(c) || c == "." {
		return "", fmt.Errorf("%w: %q", ErrBadPath, p)
	}
	return filepath.ToSlash(c), nil
}
