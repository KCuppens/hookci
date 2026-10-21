package selfupdate

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	protobundle "github.com/sigstore/protobuf-specs/gen/pb-go/bundle/v1"
	protocommon "github.com/sigstore/protobuf-specs/gen/pb-go/common/v1"
	protorekor "github.com/sigstore/protobuf-specs/gen/pb-go/rekor/v1"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/testing/ca"
	"github.com/sigstore/sigstore-go/pkg/tlog"

	"github.com/KCuppens/hookci/agent/internal/testutil"
)

const (
	goldenIdentity = "release@example.test"
	goldenIssuer   = "https://issuer.example.test"
	goldenSums     = "0000000000000000000000000000000000000000000000000000000000000000  hookci_1.2.3_linux_amd64.tar.gz\n"
)

var goldenDir = filepath.Join("testdata", "golden")

// TestSigstoreVerifierGolden verifies a committed keyless bundle over a
// committed SHA256SUMS against a committed trusted root. A real Fulcio
// signature needs an OIDC login, so `go test -run Golden -update` signs
// with sigstore-go's throwaway virtual CA (Fulcio, Rekor, TSA) and rewrites
// testdata/golden; the private keys are discarded.
func TestSigstoreVerifierGolden(t *testing.T) {
	if testutil.Update() {
		writeGolden(t)
	}
	sums := readGolden(t, SumsName)
	bundleJSON := readGolden(t, BundleName)
	trustedRoot := readGolden(t, TrustedRootName)

	v, err := newSigstoreVerifier(goldenIdentity, goldenIssuer, trustedRoot, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.VerifyBlob(sums, bundleJSON); err != nil {
		t.Fatalf("VerifyBlob: %v", err)
	}

	tampered := append([]byte{}, sums...)
	tampered[0] = '1'
	if err := v.VerifyBlob(tampered, bundleJSON); !errors.Is(err, ErrSignature) {
		t.Fatalf("tampered sums: err = %v, want ErrSignature", err)
	}

	other, err := newSigstoreVerifier("someone-else@example.test", goldenIssuer, trustedRoot, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := other.VerifyBlob(sums, bundleJSON); !errors.Is(err, ErrSignature) {
		t.Fatalf("wrong identity: err = %v, want ErrSignature", err)
	}

	// The production verifier pins the public-good root, which did not
	// issue the virtual CA.
	prod, err := NewSigstoreVerifier(goldenIdentity, goldenIssuer, EmbeddedTrustedRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := prod.VerifyBlob(sums, bundleJSON); !errors.Is(err, ErrSignature) {
		t.Fatalf("public-good root: err = %v, want ErrSignature", err)
	}
}

func TestLoadTrustedRootPrefersFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), TrustedRootName)
	got, err := LoadTrustedRoot(path)
	if err != nil || string(got) != string(EmbeddedTrustedRoot) {
		t.Fatalf("missing file: got %d bytes, err %v; want embedded root", len(got), err)
	}
	if err := os.WriteFile(path, []byte(`{"refreshed":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = LoadTrustedRoot(path)
	if err != nil || string(got) != `{"refreshed":true}` {
		t.Fatalf("file: got %q, err %v", got, err)
	}
}

func readGolden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(goldenDir, name))
	if err != nil {
		t.Fatalf("%v (run go test -run Golden -update)", err)
	}
	return b
}

func writeGolden(t *testing.T) {
	t.Helper()
	vs, err := ca.NewVirtualSigstore()
	if err != nil {
		t.Fatal(err)
	}
	sums := []byte(goldenSums)
	entity, err := vs.Sign(goldenIdentity, goldenIssuer, sums)
	if err != nil {
		t.Fatal(err)
	}
	vc, err := entity.VerificationContent()
	if err != nil {
		t.Fatal(err)
	}
	sc, err := entity.SignatureContent()
	if err != nil {
		t.Fatal(err)
	}
	msg := sc.MessageSignatureContent()
	entries, err := entity.TlogEntries()
	if err != nil {
		t.Fatal(err)
	}
	var tles []*protorekor.TransparencyLogEntry
	for _, e := range entries {
		tle := e.TransparencyLogEntry()
		set, err := vs.RekorSignPayload(tlog.RekorPayload{
			Body:           base64.StdEncoding.EncodeToString(tle.CanonicalizedBody),
			IntegratedTime: tle.IntegratedTime,
			LogIndex:       tle.LogIndex,
			LogID:          hex.EncodeToString(tle.LogId.KeyId),
		})
		if err != nil {
			t.Fatal(err)
		}
		tle.KindVersion = &protorekor.KindVersion{Kind: "hashedrekord", Version: "0.0.1"}
		tle.InclusionPromise = &protorekor.InclusionPromise{SignedEntryTimestamp: set}
		tles = append(tles, tle)
	}
	timestamps, err := entity.Timestamps()
	if err != nil {
		t.Fatal(err)
	}
	var tsr []*protocommon.RFC3161SignedTimestamp
	for _, ts := range timestamps {
		tsr = append(tsr, &protocommon.RFC3161SignedTimestamp{SignedTimestamp: ts})
	}
	pb := &protobundle.Bundle{
		MediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
		VerificationMaterial: &protobundle.VerificationMaterial{
			Content: &protobundle.VerificationMaterial_X509CertificateChain{
				X509CertificateChain: &protocommon.X509CertificateChain{
					Certificates: []*protocommon.X509Certificate{{RawBytes: vc.Certificate().Raw}},
				},
			},
			TlogEntries:               tles,
			TimestampVerificationData: &protobundle.TimestampVerificationData{Rfc3161Timestamps: tsr},
		},
		Content: &protobundle.Bundle_MessageSignature{
			MessageSignature: &protocommon.MessageSignature{
				MessageDigest: &protocommon.HashOutput{Algorithm: protocommon.HashAlgorithm_SHA2_256, Digest: msg.Digest()},
				Signature:     msg.Signature(),
			},
		},
	}
	bundleJSON, err := (&bundle.Bundle{Bundle: pb}).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	tr, err := root.NewTrustedRoot(root.TrustedRootMediaType01, vs.FulcioCertificateAuthorities(), rawLogIDs(t, vs.CTLogs()), vs.TimestampingAuthorities(), rawLogIDs(t, vs.RekorLogs()))
	if err != nil {
		t.Fatal(err)
	}
	trJSON, err := tr.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(goldenDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string][]byte{SumsName: sums, BundleName: bundleJSON, TrustedRootName: trJSON} {
		if err := os.WriteFile(filepath.Join(goldenDir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// rawLogIDs decodes the log IDs the virtual CA stores as hex text, so the
// marshalled trusted root carries the raw key IDs that bundles reference.
func rawLogIDs(t *testing.T, logs map[string]*root.TransparencyLog) map[string]*root.TransparencyLog {
	t.Helper()
	for _, l := range logs {
		id, err := hex.DecodeString(string(l.ID))
		if err != nil {
			t.Fatal(err)
		}
		l.ID = id
	}
	return logs
}
