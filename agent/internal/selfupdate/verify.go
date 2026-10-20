package selfupdate

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"os"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// The keyless identity that signs releases (see scripts/release.sh). The
// installer pins the same pair in hub/static/install.sh.
const (
	Identity = "kobecuppens@hotmail.com"
	Issuer   = "https://github.com/login/oauth"
)

// EmbeddedTrustedRoot is the Sigstore public-good trusted root shipped with
// the binary. `zeroci upgrade --refresh-trust-root` stores a newer one on
// disk, which LoadTrustedRoot prefers.
//
//go:embed trusted_root.json
var EmbeddedTrustedRoot []byte

// LoadTrustedRoot returns the trusted root at path, or the embedded one
// when path does not exist.
func LoadTrustedRoot(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return EmbeddedTrustedRoot, nil
	}
	if err != nil {
		return nil, fmt.Errorf("selfupdate: trusted root: %w", err)
	}
	return b, nil
}

type sigstoreVerifier struct {
	verifier *verify.Verifier
	identity verify.CertificateIdentity
}

// NewSigstoreVerifier verifies Fulcio keyless bundles for identity/issuer
// against trustedRoot (trusted_root.json). It requires an embedded SCT, a
// transparency log entry and an observer timestamp, as cosign produces.
func NewSigstoreVerifier(identity, issuer string, trustedRoot []byte) (Verifier, error) {
	return newSigstoreVerifier(identity, issuer, trustedRoot, true)
}

// newSigstoreVerifier lets the golden test drop the SCT requirement: the
// sigstore-go virtual CA used to produce testdata does not issue SCTs.
func newSigstoreVerifier(identity, issuer string, trustedRoot []byte, requireSCT bool) (Verifier, error) {
	tr, err := root.NewTrustedRootFromJSON(trustedRoot)
	if err != nil {
		return nil, fmt.Errorf("selfupdate: trusted root: %w", err)
	}
	opts := []verify.VerifierOption{verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1)}
	if requireSCT {
		opts = append(opts, verify.WithSignedCertificateTimestamps(1))
	}
	v, err := verify.NewVerifier(tr, opts...)
	if err != nil {
		return nil, fmt.Errorf("selfupdate: verifier: %w", err)
	}
	id, err := verify.NewShortCertificateIdentity(issuer, "", identity, "")
	if err != nil {
		return nil, fmt.Errorf("selfupdate: identity: %w", err)
	}
	return &sigstoreVerifier{verifier: v, identity: id}, nil
}

func (s *sigstoreVerifier) VerifyBlob(sums, bundleJSON []byte) error {
	var b bundle.Bundle
	if err := b.UnmarshalJSON(bundleJSON); err != nil {
		return fmt.Errorf("%w: bundle: %v", ErrSignature, err)
	}
	policy := verify.NewPolicy(verify.WithArtifact(bytes.NewReader(sums)), verify.WithCertificateIdentity(s.identity))
	if _, err := s.verifier.Verify(&b, policy); err != nil {
		return fmt.Errorf("%w: %v", ErrSignature, err)
	}
	return nil
}
