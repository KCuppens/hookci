package deploy

import (
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type fakeInfo struct {
	mode fs.FileMode
	uid  uint32
}

func (f fakeInfo) Name() string       { return "app.env" }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return false }
func (f fakeInfo) Sys() any           { return &syscall.Stat_t{Uid: f.uid} }

func stubStat(t *testing.T, info fakeInfo) {
	t.Helper()
	orig := statFunc
	statFunc = func(string) (fs.FileInfo, error) { return info, nil }
	t.Cleanup(func() { statFunc = orig })
}

func writeEnvFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.env")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadEnvFile_Parse(t *testing.T) {
	path := writeEnvFile(t, "# database\n\nDB_URL=postgres://u:p@db/app\n  # indented comment\nGREETING=\"hello world\"\nEMPTY=\nQUOTED_EQ=\"a=b\"\n\n")
	got, err := LoadEnvFile(path, false)
	if err != nil {
		t.Fatalf("LoadEnvFile: %v", err)
	}
	want := map[string]string{"DB_URL": "postgres://u:p@db/app", "GREETING": "hello world", "EMPTY": "", "QUOTED_EQ": "a=b"}
	if !maps.Equal(got, want) {
		t.Errorf("env = %v, want %v", got, want)
	}
}

func TestLoadEnvFile_RejectsMalformedLine(t *testing.T) {
	path := writeEnvFile(t, "OK=1\nnot a pair\n")
	if _, err := LoadEnvFile(path, false); err == nil || !strings.Contains(err.Error(), ":2: want KEY=VALUE") {
		t.Errorf("err = %v, want the line number", err)
	}
}

func TestLoadEnvFile_RejectsNonRoot(t *testing.T) {
	path := writeEnvFile(t, "TOKEN=secret\n")
	stubStat(t, fakeInfo{mode: 0o600, uid: 1000})
	_, err := LoadEnvFile(path, true)
	if err == nil || !strings.Contains(err.Error(), "env_file") || !strings.Contains(err.Error(), "owned by root") {
		t.Errorf("err = %v, want env_file must be owned by root", err)
	}
}

func TestLoadEnvFile_Modes(t *testing.T) {
	path := writeEnvFile(t, "TOKEN=secret\n")
	for _, tc := range []struct {
		mode fs.FileMode
		ok   bool
	}{{0o600, true}, {0o640, true}, {0o400, true}, {0o660, false}, {0o644, false}, {0o602, false}} {
		stubStat(t, fakeInfo{mode: tc.mode, uid: 0})
		_, err := LoadEnvFile(path, true)
		if (err == nil) != tc.ok {
			t.Errorf("mode %04o: err = %v, want ok=%v", tc.mode, err, tc.ok)
		}
	}
}
