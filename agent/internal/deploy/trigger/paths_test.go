package trigger

import "testing"

func TestMatchPaths(t *testing.T) {
	for _, tc := range []struct {
		name         string
		globs, files []string
		want         bool
	}{
		{name: "empty globs match everything", files: []string{"README.md"}, want: true},
		{name: "empty globs match no files", want: true},
		{name: "double star spans directories", globs: []string{"services/api/**"}, files: []string{"services/api/cmd/main.go"}, want: true},
		{name: "double star in the middle", globs: []string{"**/*.go"}, files: []string{"a/b/c.go"}, want: true},
		{name: "double star matches a root file", globs: []string{"**/*.go"}, files: []string{"main.go"}, want: true},
		{name: "single star stays in one segment", globs: []string{"services/*.go"}, files: []string{"services/api/main.go"}},
		{name: "single star within its segment", globs: []string{"services/*.go"}, files: []string{"services/main.go"}, want: true},
		{name: "any glob any file", globs: []string{"docs/**", "Dockerfile"}, files: []string{"web/app.ts", "Dockerfile"}, want: true},
		{name: "no match", globs: []string{"services/api/**"}, files: []string{"services/web/app.ts", "README.md"}},
		{name: "no files", globs: []string{"**"}},
		{name: "invalid glob matches nothing", globs: []string{"[a-"}, files: []string{"[a-"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchPaths(tc.globs, tc.files); got != tc.want {
				t.Errorf("MatchPaths(%q, %q) = %v, want %v", tc.globs, tc.files, got, tc.want)
			}
		})
	}
}
