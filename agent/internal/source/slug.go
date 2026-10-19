package source

import (
	"regexp"
	"strings"
)

var slugSanitizer = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// Slug converts a repository URL, SCP-style path, or slug into a safe directory name.
// Examples:
//
//	"https://github.com/KCuppens/zerocideploy.git" -> "github.com_KCuppens_zerocideploy"
//	"git@github.com:KCuppens/zerocideploy.git"     -> "github.com_KCuppens_zerocideploy"
//	"KCuppens/zerocideploy"                         -> "KCuppens_zerocideploy"
func Slug(repo string) string {
	s := strings.TrimSpace(repo)
	s = strings.TrimSuffix(s, ".git")

	// Strip protocol schemes
	if idx := strings.Index(s, "://"); idx != -1 {
		s = s[idx+3:]
	}

	// Strip user@ prefixes
	if atIdx := strings.Index(s, "@"); atIdx != -1 {
		s = s[atIdx+1:]
	}

	// Replace SCP colon separator with slash
	s = strings.ReplaceAll(s, ":", "/")

	// Clean leading/trailing slashes
	s = strings.Trim(s, "/")

	// Sanitize any remaining special characters
	s = slugSanitizer.ReplaceAllString(s, "_")

	if s == "" {
		return "repo"
	}
	return s
}
