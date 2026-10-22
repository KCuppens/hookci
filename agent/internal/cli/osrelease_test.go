package cli

import "testing"

type fakeOS struct{ goos string }

func (f fakeOS) GOOS() string { return f.goos }
func (fakeOS) ReadFile(string) ([]byte, error) {
	return []byte("PRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\n"), nil
}
func (fakeOS) Output(string, ...string) ([]byte, error) { return nil, nil }

func TestDepsOSRelease(t *testing.T) {
	if got := (Deps{}).osRelease(); got != "" {
		t.Errorf("osRelease without a source = %q, want empty", got)
	}
	if got := (Deps{OSRelease: fakeOS{goos: "linux"}}).osRelease(); got != "Ubuntu 22.04" {
		t.Errorf("osRelease = %q, want Ubuntu 22.04", got)
	}
}
