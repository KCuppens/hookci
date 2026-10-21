package agentconf

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := &AgentConfig{HubURL: "https://ci.hookci.com", AgentID: "agt_1", Credential: "hci_agent_abc", Name: "build-1", InstallationID: 42}
	if err := Save(dir, want); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("agent.json mode = %04o, want 0600", perm)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if *got != *want {
		t.Fatalf("Load = %+v, want %+v", got, want)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("state dir holds %d entries, want only %s", len(entries), FileName)
	}
}

func TestLoadRefusesLooseMode(t *testing.T) {
	for _, mode := range []os.FileMode{0o640, 0o644, 0o604} {
		dir := t.TempDir()
		if err := Save(dir, &AgentConfig{AgentID: "agt_1", Credential: "hci_agent_abc"}); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, FileName), mode); err != nil {
			t.Fatal(err)
		}
		_, err := Load(dir)
		if err == nil || !strings.Contains(err.Error(), "chmod 600") {
			t.Errorf("Load with mode %04o = %v, want a refusal suggesting chmod 600", mode, err)
		}
	}
}

func TestLoadMissing(t *testing.T) {
	_, err := Load(t.TempDir())
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("Load of empty dir = %v, want fs.ErrNotExist", err)
	}
}
