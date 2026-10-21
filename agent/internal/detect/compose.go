package detect

import (
	"fmt"
	"io/fs"
	"path"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/KCuppens/hookci/agent/internal/config"
)

// composePatterns are the root file names read for service images.
var composePatterns = []string{"docker-compose*.yml", "docker-compose*.yaml", "compose.yml", "compose.yaml"}

// detectCompose adds a postgres service when a compose file at the root runs
// a postgres image. The first matching file in sorted order wins. Compose is
// an add-on: it never counts as a detected ecosystem on its own.
func detectCompose(fsys fs.FS) (*partial, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("reading repository root: %w", err)
	}
	for _, e := range entries {
		if e.IsDir() || !isComposeFile(e.Name()) {
			continue
		}
		data, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return nil, fmt.Errorf("reading %s: %w", e.Name(), err)
		}
		var doc struct {
			Services map[string]struct {
				Image string `yaml:"image"`
			} `yaml:"services"`
		}
		if err := yaml.Unmarshal(data, &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		for _, name := range sortedKeys(doc.Services) {
			image := strings.TrimSpace(doc.Services[name].Image)
			if !strings.HasPrefix(image, "postgres") {
				continue
			}
			normalized := postgresImage(image)
			return &partial{
				ecosystem: "compose",
				services:  &config.ChecksServices{Postgres: &config.ChecksServicesPostgres{Image: normalized, Tmpfs: true}},
				notes:     []string{fmt.Sprintf("postgres service %s on tmpfs (from %s service %s, image %s)", normalized, e.Name(), name, image)},
				sources:   []string{e.Name()},
			}, nil
		}
	}
	return nil, nil
}

func isComposeFile(name string) bool {
	for _, pattern := range composePatterns {
		if ok, _ := path.Match(pattern, name); ok {
			return true
		}
	}
	return false
}

// postgresImage maps a bare major tag to its alpine variant (postgres:16 ->
// postgres:16-alpine) and keeps every other image verbatim.
func postgresImage(image string) string {
	repo, tag, ok := strings.Cut(image, ":")
	if !ok || tag == "" || strings.Trim(tag, "0123456789") != "" {
		return image
	}
	return repo + ":" + tag + "-alpine"
}
