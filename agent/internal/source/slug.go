package source

import (
	"fmt"
	"strings"
)

// Slug maps "owner/name" to a lowercase file name "owner__name". It rejects
// empty parts, "." and "..", more than one "/", "__" in the owner (which
// would make two repos share a slug), and any byte outside [A-Za-z0-9._-].
func Slug(repo string) (string, error) {
	owner, name, ok := strings.Cut(repo, "/")
	if !ok || strings.Contains(name, "/") {
		return "", fmt.Errorf("source: repo %q must be owner/name", repo)
	}
	for _, part := range []string{owner, name} {
		if err := validSlugPart(part); err != nil {
			return "", fmt.Errorf("source: repo %q: %w", repo, err)
		}
	}
	if strings.Contains(owner, "__") {
		return "", fmt.Errorf("source: repo %q: owner must not contain \"__\"", repo)
	}
	return strings.ToLower(owner + "__" + name), nil
}

func validSlugPart(part string) error {
	if part == "" || part == "." || part == ".." {
		return fmt.Errorf("invalid path part %q", part)
	}
	for i := range len(part) {
		if !slugByte(part[i]) {
			return fmt.Errorf("invalid character %q", part[i])
		}
	}
	return nil
}

func slugByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
}
