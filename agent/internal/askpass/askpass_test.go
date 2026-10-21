package askpass

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

const testToken = "ghs_s3cretInstallationToken"

func serve(t *testing.T, token func(ctx context.Context) (string, error)) (string, func()) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "s")
	stop, err := Serve(context.Background(), sock, token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(stop)
	return sock, stop
}

func run(args ...string) (int, string) {
	var out bytes.Buffer
	code := Main(append([]string{"hookci"}, args...), &out)
	return code, out.String()
}

func TestAskpassServesToken(t *testing.T) {
	var calls atomic.Int32
	sock, _ := serve(t, func(context.Context) (string, error) { calls.Add(1); return testToken, nil })
	t.Setenv(EnvSock, sock)

	if code, out := run("Password for 'https://x-access-token@github.com': "); code != 0 || out != testToken+"\n" {
		t.Fatalf("Password prompt = %d %q", code, out)
	}
	if code, out := run("Username for 'https://github.com': "); code != 0 || out != "x-access-token\n" {
		t.Fatalf("Username prompt = %d %q", code, out)
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("token served %d times, want 1 (Username must not ask)", n)
	}
	if code, out := run("Passphrase for key: "); code != 1 || out != "" {
		t.Fatalf("other prompt = %d %q, want 1 and no stdout", code, out)
	}
	if code, out := run(); code != 1 || out != "" {
		t.Fatalf("no prompt = %d %q, want 1 and no stdout", code, out)
	}
}

func TestAskpassTokenErrorFailsPrompt(t *testing.T) {
	sock, _ := serve(t, func(context.Context) (string, error) { return "", errors.New("hub timeout") })
	t.Setenv(EnvSock, sock)
	if code, out := run("Password for 'https://github.com': "); code != 1 || out != "" {
		t.Fatalf("Password with failing token = %d %q, want 1 and no stdout", code, out)
	}
}

func TestAskpassSocketMode(t *testing.T) {
	sock, stop := serve(t, func(context.Context) (string, error) { return testToken, nil })
	fi, err := os.Stat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Type() != os.ModeSocket || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %v, want 0600 socket", fi.Mode())
	}
	stop()
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("socket after stop: %v, want removed", err)
	}
	t.Setenv(EnvSock, sock)
	if code, _ := run("Password for 'https://github.com': "); code != 1 {
		t.Fatalf("Password after stop = %d, want 1", code)
	}
}
