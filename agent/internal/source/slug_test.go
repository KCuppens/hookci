package source

import "testing"

func TestSlug(t *testing.T) {
	valid := map[string]string{
		"KCuppens/zerocideploy": "kcuppens__zerocideploy",
		"octo-org/my.repo_v2":   "octo-org__my.repo_v2",
		"local/app":             "local__app",
	}
	for in, want := range valid {
		got, err := Slug(in)
		if err != nil || got != want {
			t.Errorf("Slug(%q) = %q, %v; want %q", in, got, err, want)
		}
	}

	invalid := []string{
		"",
		"a/b/c",
		"../x",
		"a/..",
		"a b/c",
		"/x",
		"x/",
		"noslash",
		"./x",
		"a__b/c",
	}
	for _, in := range invalid {
		if got, err := Slug(in); err == nil {
			t.Errorf("Slug(%q) = %q, want error", in, got)
		}
	}
}
