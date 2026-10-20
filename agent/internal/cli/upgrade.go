package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/KCuppens/zerocideploy/agent/internal/selfupdate"
	"github.com/KCuppens/zerocideploy/agent/internal/systemd"
	"github.com/KCuppens/zerocideploy/agent/internal/version"
)

// Releases is where `zeroci upgrade` fetches signed releases from.
type Releases struct {
	HTTP    *http.Client
	BaseURL string
	// BinPath returns the binary to replace.
	BinPath func() (string, error)
	// TrustedRoot is the refreshed trusted root; the embedded one is used
	// while it does not exist.
	TrustedRoot string
	// NewVerifier checks SHA256SUMS bundles against trustedRoot.
	NewVerifier func(trustedRoot []byte) (selfupdate.Verifier, error)
}

// defaultReleases are the published releases, verified against the pinned
// release identity.
func defaultReleases() Releases {
	return Releases{
		HTTP:    &http.Client{Timeout: 10 * time.Minute},
		BaseURL: selfupdate.DefaultBaseURL,
		BinPath: func() (string, error) {
			p, err := os.Executable()
			if err != nil {
				return "", err
			}
			return filepath.EvalSymlinks(p)
		},
		TrustedRoot: filepath.Join(defaultStateRoot, selfupdate.TrustedRootName),
		NewVerifier: func(trustedRoot []byte) (selfupdate.Verifier, error) {
			return selfupdate.NewSigstoreVerifier(selfupdate.Identity, selfupdate.Issuer, trustedRoot)
		},
	}
}

// cmdUpgrade replaces this binary with a signed release and restarts the
// running zeroci-agent@ units.
func cmdUpgrade(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	fs.SetOutput(stderr)
	check := fs.Bool("check", false, "print the current and latest version; exit 10 when an upgrade is available")
	tag := fs.String("version", "", "install this release tag (vX.Y.Z) instead of the latest")
	allowDowngrade := fs.Bool("allow-downgrade", false, "allow installing a release older than this binary")
	refresh := fs.Bool("refresh-trust-root", false, "replace the sigstore trusted root with the one published in the release")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: zeroci upgrade [--version vX.Y.Z] [--check] [--allow-downgrade] [--refresh-trust-root]")
		fmt.Fprintln(stderr)
		fmt.Fprintln(stderr, "Install a signed zeroci release and restart the running agents.")
	}
	pos, err := parseInterleaved(fs, args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(pos) != 0 {
		fs.Usage()
		return ExitUsage
	}
	fail := func(err error) int {
		fmt.Fprintf(stderr, "zeroci: upgrade: %v\n", err)
		return ExitInternal
	}

	rel := d.Releases
	u := &selfupdate.Updater{
		HTTP:           rel.HTTP,
		BaseURL:        rel.BaseURL,
		Arch:           runtime.GOARCH,
		Current:        version.Version,
		AllowDowngrade: *allowDowngrade,
	}
	var r selfupdate.Release
	if *tag != "" {
		r = u.Tagged(*tag)
	} else if r, err = u.Latest(ctx); err != nil {
		return fail(err)
	}

	if *check {
		fmt.Fprintf(stdout, "current: %s\nlatest:  %s\n", version.Version, r.Version)
		if version.Compare(r.Version, version.Version) > 0 {
			return ExitUpgradeAvailable
		}
		return ExitOK
	}
	if runtime.GOOS != "linux" {
		return fail(fmt.Errorf("releases are published for linux only, not %s", runtime.GOOS))
	}

	trustedRoot, err := selfupdate.LoadTrustedRoot(rel.TrustedRoot)
	if err != nil {
		return fail(err)
	}
	if u.Verifier, err = rel.NewVerifier(trustedRoot); err != nil {
		return fail(err)
	}
	if *refresh {
		b, err := u.FetchTrustedRoot(ctx, r)
		if err != nil {
			return fail(err)
		}
		if _, err := rel.NewVerifier(b); err != nil {
			return fail(err)
		}
		if err := selfupdate.WriteFileAtomic(rel.TrustedRoot, b, 0o644); err != nil {
			return fail(err)
		}
		fmt.Fprintf(stdout, "trusted root updated from %s\n", r.Version)
		return ExitOK
	}

	if u.BinPath, err = rel.BinPath(); err != nil {
		return fail(err)
	}
	u.Restart = func(ctx context.Context) error {
		return d.Services.TryRestart(ctx, systemd.AllAgentUnits)
	}
	if err := u.Apply(ctx, r); err != nil {
		return fail(err)
	}
	fmt.Fprintf(stdout, "upgraded %s -> %s\n", version.Version, r.Version)
	return ExitOK
}
