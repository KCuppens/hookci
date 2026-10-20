package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

const errorsFixture = "testdata/validate_errors.yml"

func writeConfig(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".zeroci.yml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func validate(args ...string) (code int, stdout, stderr string) {
	var out, errOut bytes.Buffer
	code = Main(append([]string{"validate"}, args...), &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestValidateOK(t *testing.T) {
	path := writeConfig(t, "version: 1\nchecks:\n  jobs:\n    lint:\n      run: npm run lint\n    test:\n      run: npm test\n      needs: [lint]\n")
	code, stdout, stderr := validate(path)
	if code != ExitOK || stdout != "ok: "+path+" (2 jobs)\n" || stderr != "" {
		t.Errorf("validate = %d, stdout %q, stderr %q", code, stdout, stderr)
	}

	envFile := filepath.Join(t.TempDir(), "app.env")
	if err := os.WriteFile(envFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(envFile, 0o666); err != nil {
		t.Fatal(err)
	}
	path = writeConfig(t, "version: 1\nchecks:\n  jobs:\n    test:\n      run: npm test\ndeployments:\n  production:\n    on:\n      push: main\n    strategy: script\n    run: ./deploy.sh\n    env_file: "+envFile+"\n")
	code, stdout, stderr = validate(path)
	if code != ExitOK || !strings.HasPrefix(stdout, "ok: ") {
		t.Errorf("validate with warnings = %d, stdout %q", code, stdout)
	}
	if !strings.Contains(stderr, "warning: deployments.production.env_file: env_file "+`"`+envFile+`" gives group or others access (mode 0666)`) {
		t.Errorf("stderr %q does not carry the env_file warning", stderr)
	}
}

func TestValidateErrorsGolden(t *testing.T) {
	code, stdout, stderr := validate(errorsFixture)
	if code != ExitUsage || stdout != "" {
		t.Errorf("validate = %d, stdout %q; want %d and no stdout", code, stdout, ExitUsage)
	}
	testutil.Golden(t, "validate_errors", []byte(stderr))
}

func TestValidateJSON(t *testing.T) {
	code, stdout, stderr := validate("--json", errorsFixture)
	if code != ExitUsage || stderr != "" {
		t.Fatalf("validate --json = %d, stderr %q", code, stderr)
	}
	var diags []map[string]any
	if err := json.Unmarshal([]byte(stdout), &diags); err != nil {
		t.Fatalf("stdout is not a JSON array: %v\n%s", err, stdout)
	}
	if len(diags) == 0 {
		t.Fatal("no diagnostics")
	}
	first := diags[0]
	if first["path"] != "checks.trust" || first["line"] != float64(3) || first["severity"] != "error" ||
		!strings.HasPrefix(first["message"].(string), "trust: all is refused") || first["fix"] == nil {
		t.Errorf("first diagnostic = %v", first)
	}

	code, stdout, _ = validate("--json", writeConfig(t, "version: 1\nchecks:\n  jobs:\n    test:\n      run: npm test\n"))
	if code != ExitOK || stdout != "[]\n" {
		t.Errorf("valid file: validate --json = %d, stdout %q", code, stdout)
	}
}

func TestValidateSelfHosted(t *testing.T) {
	path := writeConfig(t, "version: 1\nchecks:\n  trust: all\n  jobs:\n    test:\n      run: npm test\n")
	if code, _, stderr := validate(path); code != ExitUsage || !strings.Contains(stderr, "trust: all is refused") {
		t.Errorf("shared hub: validate = %d, stderr %q", code, stderr)
	}
	if code, stdout, stderr := validate("--self-hosted", path); code != ExitOK || !strings.HasPrefix(stdout, "ok: ") {
		t.Errorf("self-hosted: validate = %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}

func TestValidateReadError(t *testing.T) {
	code, _, stderr := validate(filepath.Join(t.TempDir(), "absent.yml"))
	if code != ExitInternal || !strings.Contains(stderr, "no such file or directory") {
		t.Errorf("validate = %d, stderr %q; want %d", code, stderr, ExitInternal)
	}
}

func TestValidateDefaultPath(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".zeroci.yml"), []byte("version: 1\nchecks:\n  jobs:\n    test:\n      run: npm test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if code, stdout, stderr := validate(); code != ExitOK || stdout != "ok: .zeroci.yml (1 jobs)\n" {
		t.Errorf("validate = %d, stdout %q, stderr %q", code, stdout, stderr)
	}
}
