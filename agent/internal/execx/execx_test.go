package execx

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestOSRunExitCode(t *testing.T) {
	if _, err := LookPath("sh"); err != nil {
		t.Skip("sh not found in PATH")
	}

	var os OS
	err := os.Run(context.Background(), Cmd{
		Name: "sh",
		Args: []string{"-c", "echo boom 1>&2; exit 3"},
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}

	var exitErr *ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("expected *ExitError, got %T: %v", err, err)
	}
	if exitErr.Code != 3 {
		t.Errorf("Code = %d, want 3", exitErr.Code)
	}
	if !bytes.Contains([]byte(exitErr.Stderr), []byte("boom")) {
		t.Errorf("Stderr = %q, want to contain %q", exitErr.Stderr, "boom")
	}
}

func TestOSRunCleanEnv(t *testing.T) {
	if _, err := LookPath("sh"); err != nil {
		t.Skip("sh not found in PATH")
	}

	var out bytes.Buffer
	var os OS
	err := os.Run(context.Background(), Cmd{
		Name:   "sh",
		Args:   []string{"-c", "echo $A $HOME"},
		Env:    []string{"A=1"},
		Stdout: &out,
	})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}

	want := "1\n"
	if out.String() != want {
		t.Errorf("stdout = %q, want %q", out.String(), want)
	}
}

func TestFakeRecordsAndMatches(t *testing.T) {
	f := &Fake{}
	f.On("git", []string{"status"}, FakeResponse{Stdout: "clean\n"})

	var out bytes.Buffer
	err := f.Run(context.Background(), Cmd{Name: "git", Args: []string{"status", "--short"}, Stdout: &out})
	if err != nil {
		t.Fatalf("Run returned error: %v", err)
	}
	if out.String() != "clean\n" {
		t.Errorf("stdout = %q, want %q", out.String(), "clean\n")
	}
	if !f.Called("git", "status") {
		t.Error("Called(\"git\", \"status\") = false, want true")
	}
	if len(f.Calls) != 1 {
		t.Errorf("len(Calls) = %d, want 1", len(f.Calls))
	}
}

func TestFakeUnexpected(t *testing.T) {
	f := &Fake{}
	err := f.Run(context.Background(), Cmd{Name: "rm", Args: []string{"-rf", "/"}})
	if err == nil {
		t.Fatal("expected error for unmatched command, got nil")
	}
	if want := "execx fake: unexpected command rm -rf /"; err.Error() != want {
		t.Errorf("error = %q, want %q", err.Error(), want)
	}
	if !f.Called("rm", "-rf") {
		t.Error("Called(\"rm\", \"-rf\") = false, want true")
	}
}
