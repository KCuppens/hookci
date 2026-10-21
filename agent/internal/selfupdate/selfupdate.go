// Package selfupdate replaces the running hookci binary with a signed
// release: it fetches SHA256SUMS and its sigstore bundle, verifies the
// bundle against the pinned release identity, checks the tarball against
// SHA256SUMS and swaps the binary atomically before restarting the agents.
package selfupdate

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/KCuppens/hookci/agent/internal/version"
)

// DefaultBaseURL is where releases are published. Assets live under
// BaseURL/download/<tag>/ and BaseURL/latest redirects to the newest tag.
const DefaultBaseURL = "https://github.com/KCuppens/hookci/releases"

// Release asset names, matching .goreleaser.yaml and hub/static/install.sh.
const (
	SumsName        = "SHA256SUMS"
	BundleName      = SumsName + ".sigstore.json"
	TrustedRootName = "trusted_root.json"
	binaryName      = "hookci"
)

// Size caps for downloads.
const (
	maxSmallFile = 1 << 20
	maxArchive   = 256 << 20
)

var (
	ErrChecksum  = errors.New("selfupdate: checksum mismatch")
	ErrSignature = errors.New("selfupdate: signature verification failed")
	ErrDowngrade = errors.New("selfupdate: refusing downgrade without --allow-downgrade")
)

// Release locates the assets of one tagged release.
type Release struct {
	Version   string // tag, e.g. v1.2.3
	AssetURL  string // linux tarball for the updater's Arch
	SumsURL   string
	BundleURL string // sigstore bundle over SHA256SUMS
}

// Verifier checks that bundle is a valid signature over sums by the pinned
// release identity.
type Verifier interface {
	VerifyBlob(sums []byte, bundle []byte) error
}

// Updater fetches and installs releases.
type Updater struct {
	HTTP     *http.Client
	BaseURL  string
	Verifier Verifier
	BinPath  string // binary to replace
	Arch     string // amd64 or arm64
	// Restart runs after the new binary is in place; nil skips it.
	Restart func(ctx context.Context) error
	// Current is the running version; Apply refuses an older release
	// unless AllowDowngrade is set.
	Current        string
	AllowDowngrade bool
}

// AssetName is the linux tarball of version for arch.
func AssetName(tag, arch string) string {
	return "hookci_" + strings.TrimPrefix(tag, "v") + "_linux_" + arch + ".tar.gz"
}

// Tagged returns the release with tag, e.g. v1.2.3.
func (u *Updater) Tagged(tag string) Release {
	return Release{
		Version:   tag,
		AssetURL:  u.downloadURL(tag, AssetName(tag, u.Arch)),
		SumsURL:   u.downloadURL(tag, SumsName),
		BundleURL: u.downloadURL(tag, BundleName),
	}
}

func (u *Updater) downloadURL(tag, name string) string {
	return strings.TrimSuffix(u.BaseURL, "/") + "/download/" + tag + "/" + name
}

// Latest resolves BaseURL/latest, which redirects to .../tag/<tag>.
func (u *Updater) Latest(ctx context.Context) (Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, strings.TrimSuffix(u.BaseURL, "/")+"/latest", nil)
	if err != nil {
		return Release{}, fmt.Errorf("selfupdate: latest: %w", err)
	}
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return Release{}, fmt.Errorf("selfupdate: latest: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("selfupdate: latest: %s", resp.Status)
	}
	tag := path.Base(resp.Request.URL.Path)
	if !strings.HasPrefix(tag, "v") || version.Compare(tag, "dev") == 0 {
		return Release{}, fmt.Errorf("selfupdate: latest: %s is not a release tag", resp.Request.URL)
	}
	return u.Tagged(tag), nil
}

// Apply installs r: it verifies the signed SHA256SUMS, downloads the
// tarball and checks its digest, writes the binary to BinPath+".new",
// fsyncs it, renames it over BinPath and calls Restart.
func (u *Updater) Apply(ctx context.Context, r Release) error {
	if version.Compare(r.Version, u.Current) < 0 && !u.AllowDowngrade {
		return fmt.Errorf("%w: %s is older than %s", ErrDowngrade, r.Version, u.Current)
	}
	sums, err := u.verifiedSums(ctx, r)
	if err != nil {
		return err
	}
	archive, err := u.get(ctx, r.AssetURL, maxArchive)
	if err != nil {
		return err
	}
	if err := checkSum(sums, path.Base(r.AssetURL), archive); err != nil {
		return err
	}
	bin, err := extractBinary(archive)
	if err != nil {
		return err
	}
	if err := WriteFileAtomic(u.BinPath, bin, 0o755); err != nil {
		return err
	}
	if u.Restart != nil {
		if err := u.Restart(ctx); err != nil {
			return fmt.Errorf("selfupdate: restart: %w", err)
		}
	}
	return nil
}

// FetchTrustedRoot downloads the trusted_root.json published with r and
// returns it once SHA256SUMS verifies and lists its digest.
func (u *Updater) FetchTrustedRoot(ctx context.Context, r Release) ([]byte, error) {
	sums, err := u.verifiedSums(ctx, r)
	if err != nil {
		return nil, err
	}
	b, err := u.get(ctx, u.downloadURL(r.Version, TrustedRootName), maxSmallFile)
	if err != nil {
		return nil, err
	}
	if err := checkSum(sums, TrustedRootName, b); err != nil {
		return nil, err
	}
	return b, nil
}

func (u *Updater) verifiedSums(ctx context.Context, r Release) ([]byte, error) {
	sums, err := u.get(ctx, r.SumsURL, maxSmallFile)
	if err != nil {
		return nil, err
	}
	bundle, err := u.get(ctx, r.BundleURL, maxSmallFile)
	if err != nil {
		return nil, err
	}
	if err := u.Verifier.VerifyBlob(sums, bundle); err != nil {
		if errors.Is(err, ErrSignature) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", ErrSignature, err)
	}
	return sums, nil
}

func (u *Updater) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("selfupdate: %w", err)
	}
	resp, err := u.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("selfupdate: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("selfupdate: GET %s: %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("selfupdate: GET %s: %w", url, err)
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("selfupdate: GET %s: larger than %d bytes", url, limit)
	}
	return b, nil
}

// checkSum compares the digest of b with the SHA256SUMS line for name.
func checkSum(sums []byte, name string, b []byte) error {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		digest, file, ok := strings.Cut(sc.Text(), "  ")
		if !ok || strings.TrimPrefix(file, "*") != name {
			continue
		}
		got := sha256.Sum256(b)
		if hex.EncodeToString(got[:]) != strings.ToLower(digest) {
			return fmt.Errorf("%w for %s", ErrChecksum, name)
		}
		return nil
	}
	return fmt.Errorf("%w: %s is not listed in %s", ErrChecksum, name, SumsName)
}

// extractBinary returns the hookci file of a release tarball.
func extractBinary(archive []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("selfupdate: archive: %w", err)
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("selfupdate: archive has no %s binary", binaryName)
		}
		if err != nil {
			return nil, fmt.Errorf("selfupdate: archive: %w", err)
		}
		if h.Typeflag == tar.TypeReg && path.Clean(h.Name) == binaryName {
			b, err := io.ReadAll(io.LimitReader(tr, maxArchive))
			if err != nil {
				return nil, fmt.Errorf("selfupdate: archive: %w", err)
			}
			return b, nil
		}
	}
}

// WriteFileAtomic writes b to dst+".new", fsyncs it and renames it over dst,
// then fsyncs the directory so the rename survives a crash.
func WriteFileAtomic(dst string, b []byte, mode os.FileMode) (err error) {
	tmp := dst + ".new"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("selfupdate: %w", err)
	}
	defer func() {
		if err != nil {
			os.Remove(tmp)
		}
	}()
	if _, err := f.Write(b); err != nil {
		f.Close()
		return fmt.Errorf("selfupdate: %w", err)
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return fmt.Errorf("selfupdate: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("selfupdate: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("selfupdate: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return fmt.Errorf("selfupdate: %w", err)
	}
	if d, err := os.Open(filepath.Dir(dst)); err == nil {
		d.Sync()
		d.Close()
	}
	return nil
}
