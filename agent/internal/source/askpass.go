package source

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
)

// askpassMaxToken bounds how much of the token file RunAskpass reads.
const askpassMaxToken = 64 << 10

// WriteAskpassFile writes token to a new 0600 file in dir, which must be a
// private directory (the run's tmp, mode 0700, owned by the current user),
// never shared /tmp. cleanup removes the file and is safe to call twice.
func WriteAskpassFile(dir, token string) (string, func(), error) {
	if token == "" || strings.ContainsAny(token, "\r\n") {
		return "", nil, errors.New("source: askpass token must be one non-empty line")
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return "", nil, fmt.Errorf("source: askpass dir: %w", err)
	}
	if !fi.IsDir() || fi.Mode().Perm()&0o077 != 0 || !ownedByMe(fi) {
		return "", nil, fmt.Errorf("source: askpass dir %s must be a 0700 directory owned by uid %d", dir, os.Getuid())
	}
	f, err := os.CreateTemp(dir, "askpass-*")
	if err != nil {
		return "", nil, fmt.Errorf("source: askpass file: %w", err)
	}
	path := f.Name()
	cleanup := func() { _ = os.Remove(path) }
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		cleanup()
		return "", nil, fmt.Errorf("source: askpass file: %w", err)
	}
	if _, err := f.WriteString(token); err != nil {
		_ = f.Close()
		cleanup()
		return "", nil, fmt.Errorf("source: askpass file: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("source: askpass file: %w", err)
	}
	return path, cleanup, nil
}

// AskpassEnv points git at binary (the zeroci executable) in askpass mode
// reading file. The token itself is never part of the environment.
func AskpassEnv(binary, file string) []string {
	return []string{
		"GIT_ASKPASS=" + binary,
		"ZEROCI_ASKPASS=1",
		"ZEROCI_ASKPASS_FILE=" + file,
	}
}

// RunAskpass answers one git credential prompt in args[0]: "Username..."
// prints x-access-token, "Password..." prints the token from
// $ZEROCI_ASKPASS_FILE. Anything else, or a token file that is not a
// regular 0600 file owned by the current uid, exits 1 with no stdout.
func RunAskpass(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "zeroci askpass: missing prompt")
		return 1
	}
	prompt := args[0]
	if !strings.HasPrefix(prompt, "Username") && !strings.HasPrefix(prompt, "Password") {
		fmt.Fprintf(stderr, "zeroci askpass: unexpected prompt %q\n", prompt)
		return 1
	}
	token, err := readAskpassFile(os.Getenv("ZEROCI_ASKPASS_FILE"))
	if err != nil {
		fmt.Fprintf(stderr, "zeroci askpass: %v\n", err)
		return 1
	}
	if strings.HasPrefix(prompt, "Username") {
		fmt.Fprintln(stdout, "x-access-token")
		return 0
	}
	fmt.Fprintln(stdout, token)
	return 0
}

func readAskpassFile(path string) (string, error) {
	if path == "" {
		return "", errors.New("ZEROCI_ASKPASS_FILE is not set")
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o600 || !ownedByMe(fi) {
		return "", fmt.Errorf("%s must be a regular 0600 file owned by uid %d", path, os.Getuid())
	}
	b, err := io.ReadAll(io.LimitReader(f, askpassMaxToken))
	if err != nil {
		return "", err
	}
	token := strings.TrimRight(string(b), "\r\n")
	if token == "" {
		return "", errors.New("token file is empty")
	}
	return token, nil
}

func ownedByMe(fi os.FileInfo) bool {
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Getuid()
}
