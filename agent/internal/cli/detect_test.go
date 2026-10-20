package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

func detectFixtureDir(t *testing.T, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "examples", "detect", name)
}

func runCLI(args ...string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer
	code = Main(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestCLIDetectExitCodes(t *testing.T) {
	npm := detectFixtureDir(t, "npm")

	t.Run("npm fixture prints YAML", func(t *testing.T) {
		code, stdout, stderr := runCLI("detect", npm)
		if code != ExitOK {
			t.Fatalf("exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
		}
		want, err := os.ReadFile(filepath.Join(npm, "expected.zeroci.yml"))
		if err != nil {
			t.Fatal(err)
		}
		if stdout != string(want) {
			t.Errorf("stdout differs from expected.zeroci.yml:\n%s", stdout)
		}
		if stderr != "" {
			t.Errorf("stderr = %q, want empty", stderr)
		}
	})
	t.Run("empty fixture exits 3", func(t *testing.T) {
		code, stdout, stderr := runCLI("detect", detectFixtureDir(t, "empty"))
		if code != ExitNoChecks {
			t.Fatalf("exit = %d, want %d", code, ExitNoChecks)
		}
		if stderr != "no checks detected: add .zeroci.yml (run zeroci init)\n" {
			t.Errorf("stderr = %q", stderr)
		}
		if stdout != "" {
			t.Errorf("stdout = %q, want empty", stdout)
		}
	})
	t.Run("json flag after dir", func(t *testing.T) {
		code, stdout, stderr := runCLI("detect", npm, "--json")
		if code != ExitOK {
			t.Fatalf("exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
		}
		var got config.ZeroCIConfig
		if err := json.Unmarshal([]byte(stdout), &got); err != nil {
			t.Fatalf("stdout is not config JSON: %v\n%s", err, stdout)
		}
		if got.Version != 1 || got.Checks == nil || got.Checks.Jobs["lint"].Run != "npm run lint" {
			t.Errorf("unexpected JSON config: %s", stdout)
		}
	})
	t.Run("existing zeroci.yml is noted", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "go.mod"), "module x\n")
		writeFile(t, filepath.Join(dir, ".zeroci.yml"), "version: 1\n")
		code, stdout, stderr := runCLI("detect", dir)
		if code != ExitOK {
			t.Fatalf("exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
		}
		if stderr != "note: .zeroci.yml exists and takes precedence over detection\n" {
			t.Errorf("stderr = %q", stderr)
		}
		if !strings.Contains(stdout, "go test ./...") {
			t.Errorf("detection not printed: %q", stdout)
		}
	})
	t.Run("usage errors", func(t *testing.T) {
		for _, args := range [][]string{
			{"detect", filepath.Join(t.TempDir(), "missing")},
			{"detect", npm, npm},
			{"detect", "--bogus"},
		} {
			if code, _, _ := runCLI(args...); code != ExitUsage {
				t.Errorf("%v: exit = %d, want %d", args, code, ExitUsage)
			}
		}
	})
	t.Run("malformed package.json", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "package.json"), "{")
		code, _, stderr := runCLI("detect", dir)
		if code != ExitUsage || !strings.Contains(stderr, "package.json") {
			t.Errorf("exit = %d stderr = %q, want %d naming package.json", code, stderr, ExitUsage)
		}
	})
	t.Run("help", func(t *testing.T) {
		code, stdout, _ := runCLI("detect", "-h")
		if code != ExitOK || !strings.Contains(stdout, "Usage: zeroci detect") {
			t.Errorf("exit = %d stdout = %q", code, stdout)
		}
	})
}

func TestCLIInit(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "package.json"), `{"scripts": {"lint": "eslint .", "test": "vitest"}}`)
	writeFile(t, filepath.Join(dir, "package-lock.json"), "{}")
	path := filepath.Join(dir, ".zeroci.yml")

	code, stdout, stderr := runCLI("init", dir)
	if code != ExitOK {
		t.Fatalf("first init: exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
	}
	if stdout != "wrote "+path+"\n" {
		t.Errorf("stdout = %q", stdout)
	}
	assertValidConfig(t, path)
	_, detected, _ := runCLI("detect", dir)
	if got := readFile(t, path); got != detected {
		t.Errorf("written file differs from zeroci detect output:\n%s\n--- detect ---\n%s", got, detected)
	}

	code, _, stderr = runCLI("init", dir)
	if code != ExitUsage {
		t.Fatalf("second init: exit = %d, want %d", code, ExitUsage)
	}
	if !strings.Contains(stderr, "--force") {
		t.Errorf("refusal %q does not name --force", stderr)
	}

	writeFile(t, path, "version: 1\n")
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _, stderr := runCLI("init", dir, "--force"); code != ExitOK {
		t.Fatalf("init --force: exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
	}
	if got := readFile(t, path); got != detected {
		t.Errorf("--force did not overwrite:\n%s", got)
	}
	assertValidConfig(t, path)

	for name, files := range map[string]map[string]string{
		"empty dir": nil,
		"node without matching scripts": {
			"package.json":      `{"scripts": {"build": "tsc"}}`,
			"package-lock.json": "{}",
		},
	} {
		t.Run(name+" writes a skeleton", func(t *testing.T) {
			dir := t.TempDir()
			for f, content := range files {
				writeFile(t, filepath.Join(dir, f), content)
			}
			code, _, stderr := runCLI("init", dir)
			if code != ExitOK {
				t.Fatalf("exit = %d, want %d (stderr %q)", code, ExitOK, stderr)
			}
			if !strings.Contains(stderr, "no checks detected") {
				t.Errorf("stderr hint = %q", stderr)
			}
			path := filepath.Join(dir, ".zeroci.yml")
			if got := readFile(t, path); !strings.HasPrefix(got, "#") || !strings.Contains(got, "jobs:") {
				t.Errorf("skeleton is not a commented jobs example:\n%s", got)
			}
			assertValidConfig(t, path)
		})
	}
}

func assertValidConfig(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o644 {
		t.Errorf("%s mode = %o, want 644", path, mode)
	}
	_, diags, err := config.Load(path, config.ParseOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if diags.HasErrors() {
		t.Errorf("written file does not validate:\n%s", diags.Format(path))
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
