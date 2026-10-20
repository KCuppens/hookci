package compose

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/testutil"
)

func TestRenderOverride_Golden(t *testing.T) {
	cases := []struct {
		name string
		in   OverrideInput
	}{
		{"ports", OverrideInput{
			ComposeFile: "testdata/ports.compose.yml", Service: "web",
			Image: "myapp:abc1234", HostPort: 3101, Color: "blue",
		}},
		{"ports_shared_network", OverrideInput{
			ComposeFile: "testdata/ports.compose.yml", Service: "web",
			Image: "myapp:abc1234", HostPort: 3102, Color: "green", SharedNetwork: "proxy",
		}},
		{"expose", OverrideInput{
			ComposeFile: "testdata/expose.compose.yml", Service: "app",
			Image: "myapp:abc1234", HostPort: 3103, Color: "blue",
		}},
		{"container_name_shared_network", OverrideInput{
			ComposeFile: "testdata/container_name.compose.yml", Service: "web",
			Image: "myapp:def5678", HostPort: 3104, Color: "green", SharedNetwork: "caddy",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.in.Env = "production"
			got, err := RenderOverride(tc.in)
			if err != nil {
				t.Fatalf("RenderOverride: %v", err)
			}
			testutil.GoldenFile(t, filepath.Join("testdata", tc.name+".override.yml"), got)
		})
	}
}

func TestRenderOverride_NoPort(t *testing.T) {
	_, err := RenderOverride(OverrideInput{
		Env: "production", ComposeFile: "testdata/no_port.compose.yml", Service: "worker",
		Image: "myapp:abc1234", HostPort: 3101, Color: "blue",
	})
	want := "deployments.production.compose.service: service worker exposes no port; add ports or expose"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %s", err, want)
	}
}

func TestRenderOverride_ServiceNotFound(t *testing.T) {
	_, err := RenderOverride(OverrideInput{
		Env: "staging", ComposeFile: "testdata/ports.compose.yml", Service: "api",
		Image: "myapp:abc1234", HostPort: 3101, Color: "blue",
	})
	want := "deployments.staging.compose.service: service api not found in testdata/ports.compose.yml; set compose.service to a service in that file"
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %s", err, want)
	}
}

func TestRenderOverride_ContainerPort(t *testing.T) {
	cases := []struct {
		name, service, want string
	}{
		{"bare number", "ports:\n      - 8080", `"127.0.0.1:3101:8080"`},
		{"host and container", `ports: ["3000:8080"]`, `"127.0.0.1:3101:8080"`},
		{"ip host container proto", `ports: ["127.0.0.1:3000:8080/udp"]`, `"127.0.0.1:3101:8080"`},
		{"ipv6 host", `ports: ["[::1]:3000:9000"]`, `"127.0.0.1:3101:9000"`},
		{"long syntax string target", "ports:\n      - target: \"7000\"", `"127.0.0.1:3101:7000"`},
		{"ports win over expose", "expose: [\"5000\"]\n    ports: [\"6000\"]", `"127.0.0.1:3101:6000"`},
		{"expose with proto", `expose: ["4000/tcp"]`, `"127.0.0.1:3101:4000"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RenderOverride(OverrideInput{
				Env: "production", ComposeFile: writeCompose(t, tc.service), Service: "web",
				Image: "myapp:abc1234", HostPort: 3101, Color: "blue",
			})
			if err != nil {
				t.Fatalf("RenderOverride: %v", err)
			}
			if !strings.Contains(string(got), "- "+tc.want+"\n") {
				t.Errorf("override lacks port %s:\n%s", tc.want, got)
			}
		})
	}
}

func TestRenderOverride_UnusablePort(t *testing.T) {
	for _, service := range []string{
		`ports: ["8000-8010:8000-8010"]`,
		`ports: ["3000:${APP_PORT}"]`,
		`expose: ["3000-3005"]`,
	} {
		_, err := RenderOverride(OverrideInput{
			Env: "production", ComposeFile: writeCompose(t, service), Service: "web",
			Image: "myapp:abc1234", HostPort: 3101, Color: "blue",
		})
		want := "deployments.production.compose.service: service web has no single container port in the entry at line 4; use one numeric container port"
		if err == nil || err.Error() != want {
			t.Errorf("%s: error = %v, want %s", service, err, want)
		}
	}
}

func writeCompose(t *testing.T, service string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "compose.yml")
	body := "services:\n  web:\n    image: x\n    " + service + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProjectNameAndImageTag(t *testing.T) {
	name, err := ProjectName("myapp", "green")
	if err != nil || name != "myapp-green" {
		t.Errorf(`ProjectName("myapp","green") = %q, %v; want "myapp-green"`, name, err)
	}
	tag, err := ImageTag("myapp", "abc1234def")
	if err != nil || tag != "myapp:abc1234" {
		t.Errorf(`ImageTag("myapp","abc1234def") = %q, %v; want "myapp:abc1234"`, tag, err)
	}

	for _, project := range []string{"", "MyApp", "-app", "my.app", "my app"} {
		if _, err := ProjectName(project, "blue"); err == nil || !strings.HasPrefix(err.Error(), "compose.project: ") {
			t.Errorf("ProjectName(%q) error = %v, want compose.project error", project, err)
		}
		if _, err := ImageTag(project, "abc1234"); err == nil || !strings.HasPrefix(err.Error(), "compose.project: ") {
			t.Errorf("ImageTag(%q) error = %v, want compose.project error", project, err)
		}
	}
	for _, sha := range []string{"", "abc123", "abc123g", "zzzzzzzz"} {
		if _, err := ImageTag("myapp", sha); err == nil {
			t.Errorf("ImageTag(%q) accepted a bad sha", sha)
		}
	}
	if _, err := ProjectName("myapp", "Blue"); err == nil {
		t.Error(`ProjectName("myapp","Blue") accepted an invalid color`)
	}
}
