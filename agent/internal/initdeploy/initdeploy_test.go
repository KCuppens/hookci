package initdeploy

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/testutil"
)

// repoDir returns a temp repo holding the files of the named testdata
// fixtures.
func repoDir(t *testing.T, fixtures ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, fixture := range fixtures {
		entries, err := os.ReadDir(filepath.Join("testdata", fixture))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			data, err := os.ReadFile(filepath.Join("testdata", fixture, e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, e.Name()), data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// decodeConfig decodes a written .hookci.yml into the config type and fails
// the test unless it passes ValidateDeployments.
func decodeConfig(t *testing.T, data []byte) *config.HookCIConfig {
	t.Helper()
	var raw any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	var cfg config.HookCIConfig
	if err := json.Unmarshal(encoded, &cfg); err != nil {
		t.Fatalf("decode %s: %v", data, err)
	}
	if errs := config.ValidateDeployments(&cfg); len(errs) > 0 {
		t.Fatalf("ValidateDeployments: %v\n%s", errs, data)
	}
	return &cfg
}

func TestFindComposeFile_Order(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"docker-compose.yml", "compose.yaml"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("services: {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if got, err := FindComposeFile(dir); err != nil || got != "compose.yaml" {
		t.Errorf("FindComposeFile = %q, %v; want compose.yaml", got, err)
	}

	if err := os.Remove(filepath.Join(dir, "compose.yaml")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "compose.yml"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, err := FindComposeFile(dir); err != nil || got != "docker-compose.yml" {
		t.Errorf("with compose.yml a directory: FindComposeFile = %q, %v; want docker-compose.yml", got, err)
	}

	empty := t.TempDir()
	_, err := FindComposeFile(empty)
	want := "init --deploy: no compose.yaml, compose.yml, docker-compose.yml or docker-compose.yaml in " + empty
	if err == nil || err.Error() != want {
		t.Errorf("no compose file: err = %v, want %q", err, want)
	}
}

func TestCandidateServices(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    []string
	}{
		{"multi", []string{"api", "web"}},
		{"single", []string{"web"}},
		{"none", nil},
	} {
		got, err := CandidateServices(readFile(t, filepath.Join("testdata", tc.fixture, "compose.yaml")))
		if err != nil || !slices.Equal(got, tc.want) {
			t.Errorf("%s: CandidateServices = %q, %v; want %q", tc.fixture, got, err, tc.want)
		}
	}
	if _, err := CandidateServices([]byte("services: [")); err == nil || !strings.HasPrefix(err.Error(), "init --deploy: parse compose file: ") {
		t.Errorf("invalid YAML: err = %v", err)
	}
}

func TestRun_YesSingle(t *testing.T) {
	dir := repoDir(t, "single")
	var out bytes.Buffer
	if err := Run(Options{Dir: dir, Repo: "Shop_App", Yes: true, Out: &out}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".hookci.yml")
	data := readFile(t, path)
	testutil.Golden(t, "yes_single", data)

	cfg := decodeConfig(t, data)
	if d := cfg.Deployments["production"]; d.Compose.Project != "shop-app" || d.Compose.Service != "web" {
		t.Errorf("compose = %+v, want project shop-app and service web", d.Compose)
	}
	if _, diags := config.Parse(data, config.ParseOptions{}); diags.HasErrors() {
		t.Errorf("written file does not parse:\n%s", diags.Format(path))
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, %v; want 0644", info.Mode(), err)
	}
	for _, want := range []string{
		"wrote deployments.production to " + path,
		"chmod 600 /etc/hookci/env/Shop_App/production.env",
		"import /etc/caddy/routes/Shop_App-production.caddy",
		"hookci doctor",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output does not contain %q:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "[") {
		t.Errorf("--yes prompted:\n%s", out.String())
	}
}

func TestRun_PromptChoice(t *testing.T) {
	for _, tc := range []struct {
		input, service, url string
	}{
		{"2\n/health\n", "web", "http://127.0.0.1:{port}/health"},
		{"\nready\n", "api", "http://127.0.0.1:{port}/ready"},
		{"", "api", "http://127.0.0.1:{port}/healthz"},
	} {
		dir := repoDir(t, "multi")
		var out bytes.Buffer
		if err := Run(Options{Dir: dir, Repo: "shop", In: strings.NewReader(tc.input), Out: &out}); err != nil {
			t.Fatalf("input %q: %v", tc.input, err)
		}
		d := decodeConfig(t, readFile(t, filepath.Join(dir, ".hookci.yml"))).Deployments["production"]
		if d.Compose.Service != tc.service || d.Health.Url != tc.url {
			t.Errorf("input %q: service = %q, health.url = %q; want %q, %q", tc.input, d.Compose.Service, d.Health.Url, tc.service, tc.url)
		}
		if !strings.Contains(out.String(), "  1) api\n  2) web\nService to deploy [1]: Health check path [/healthz]: ") {
			t.Errorf("input %q: prompts =\n%s", tc.input, out.String())
		}
	}

	dir := repoDir(t, "multi")
	err := Run(Options{Dir: dir, Repo: "shop", In: strings.NewReader("3\n"), Out: &bytes.Buffer{}})
	if err == nil || err.Error() != `init --deploy: invalid service choice "3"; enter a number from 1 to 2` {
		t.Errorf("choice out of range: err = %v", err)
	}
}

func TestRun_PreservesComments(t *testing.T) {
	dir := repoDir(t, "existing", "single")
	path := filepath.Join(dir, ".hookci.yml")
	original := readFile(t, path)
	if err := Run(Options{Dir: dir, Repo: "shop", Yes: true, Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	data := readFile(t, path)
	if !bytes.HasPrefix(data, original) {
		t.Fatalf("existing content changed:\n%s", data)
	}
	block, err := encode(Draft("shop", "compose.yaml", "web", "/healthz", "shop"))
	if err != nil {
		t.Fatal(err)
	}
	if appended := data[len(original):]; !bytes.Equal(appended, block) {
		t.Errorf("appended block =\n%s\nwant\n%s", appended, block)
	}
	cfg := decodeConfig(t, data)
	if cfg.Checks == nil || len(cfg.Checks.Jobs) != 2 {
		t.Errorf("checks lost: %+v", cfg.Checks)
	}
}

func TestRun_ExistingDeployments(t *testing.T) {
	dir := repoDir(t, "existing", "single")
	if err := Run(Options{Dir: dir, Repo: "shop", Yes: true, Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".hookci.yml")
	before := readFile(t, path)

	err := Run(Options{Dir: dir, Repo: "shop", Yes: true, Out: &bytes.Buffer{}})
	want := "deployments: already present in .hookci.yml; edit it or remove it to re-run init --deploy"
	if err == nil || err.Error() != want {
		t.Fatalf("second run: err = %v, want %q", err, want)
	}
	if after := readFile(t, path); !bytes.Equal(after, before) {
		t.Errorf("file changed:\n%s", after)
	}
	assertOnlyFiles(t, dir, ".hookci.yml", "compose.yaml")
}

func TestRun_NoService(t *testing.T) {
	dir := repoDir(t, "none")
	err := Run(Options{Dir: dir, Repo: "shop", Yes: true, Out: &bytes.Buffer{}})
	want := "init --deploy: no service with both build and ports in compose.yaml; add ports to your web service"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	assertOnlyFiles(t, dir, "compose.yaml")
}

func TestRun_InvalidDraftWritesNothing(t *testing.T) {
	dir := repoDir(t, "single")
	err := Run(Options{Dir: dir, Repo: "shop", In: strings.NewReader("/health%zz\n"), Out: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), `deployments.production.health.url: health.url "http://127.0.0.1:{port}/health%zz" is not a valid URL`) {
		t.Fatalf("err = %v", err)
	}
	assertOnlyFiles(t, dir, "compose.yaml")
}

func TestRun_FlowStyleConfig(t *testing.T) {
	dir := repoDir(t, "single")
	path := filepath.Join(dir, ".hookci.yml")
	if err := os.WriteFile(path, []byte("{version: 1}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Run(Options{Dir: dir, Repo: "shop", Yes: true, Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	if cfg := decodeConfig(t, readFile(t, path)); cfg.Version != 1 || cfg.Deployments["production"].Strategy != config.DeploymentStrategyComposeBluegreen {
		t.Errorf("config = %+v", cfg)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, %v; want the existing 0600 kept", info.Mode(), err)
	}
}

func assertOnlyFiles(t *testing.T, dir string, want ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if !slices.Equal(got, want) {
		t.Errorf("files in repo = %q, want %q", got, want)
	}
}
