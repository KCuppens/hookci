package cli

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"text/tabwriter"

	"golang.org/x/term"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/version"
)

const sinkUsage = `usage: hookci [global flags] sink <command> [--state-dir DIR | --installation ID]

Manage the repo's Telegram, webhook and Linear sinks on the hub, with the
credential of the agent in the state directory.

  sink add telegram --repo OWNER/NAME --chat-id ID [--label TEXT]
      The bot token comes from $HOOKCI_TELEGRAM_TOKEN, else one line on stdin.
  sink add webhook --repo OWNER/NAME --url https://... [--label TEXT] [--secret-only]
      Prints the generated signing secret once; --secret-only prints only it.
  sink add linear --repo OWNER/NAME --team KEY [--assignee EMAIL] [--label TEXT]
      The API key comes from $HOOKCI_LINEAR_API_KEY, else one line on stdin.
  sink ls --repo OWNER/NAME [--json]
  sink rm <id>
  sink test <id>
`

// telegramTokenEnv and linearAPIKeyEnv name the variables sink add telegram
// and sink add linear take their secret from before they read stdin.
const (
	telegramTokenEnv = "HOOKCI_TELEGRAM_TOKEN"
	linearAPIKeyEnv  = "HOOKCI_LINEAR_API_KEY"
)

// cmdSink adds, lists, removes and tests the sink configs of a repo on the
// hub. API and network failures exit 1, usage errors 2.
func cmdSink(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, sinkUsage)
		return ExitUsage
	}
	switch args[0] {
	case "add":
		return sinkAdd(ctx, d, args[1:], stdout, stderr)
	case "ls":
		return sinkList(ctx, d, args[1:], stdout, stderr)
	case "rm":
		return sinkRemove(ctx, d, args[1:], stdout, stderr)
	case "test":
		return sinkTest(ctx, d, args[1:], stdout, stderr)
	case "help", "-h", "--help":
		fmt.Fprint(stderr, sinkUsage)
		return ExitOK
	default:
		fmt.Fprintf(stderr, "hookci: sink: unknown command %q\n", args[0])
		fmt.Fprint(stderr, sinkUsage)
		return ExitUsage
	}
}

// sinkFlags is the flag set of one sink command with the flags that pick
// the agent whose credential calls the hub.
type sinkFlags struct {
	*flag.FlagSet
	dirFlags stateDirFlags
	stateDir string // set by parse
}

func newSinkFlags(d Deps, usage string, stderr io.Writer) *sinkFlags {
	fs := flag.NewFlagSet("sink", flag.ContinueOnError)
	fs.SetOutput(stderr)
	f := &sinkFlags{FlagSet: fs, dirFlags: addStateDirFlags(fs, d)}
	fs.Usage = func() {
		fmt.Fprintf(stderr, "usage: hookci [global flags] sink %s [--state-dir DIR | --installation ID]\n", usage)
		fs.PrintDefaults()
	}
	return f
}

// parse parses args, which must hold npos positional arguments. When ok is
// false the command ends with code.
func (f *sinkFlags) parse(args []string, npos int, stderr io.Writer) (pos []string, code int, ok bool) {
	pos, err := parseInterleaved(f.FlagSet, args)
	if errors.Is(err, flag.ErrHelp) {
		return nil, ExitOK, false
	}
	if err != nil {
		return nil, ExitUsage, false
	}
	if len(pos) != npos || slicesHasEmpty(pos) {
		f.Usage()
		return nil, ExitUsage, false
	}
	dir, ok := f.dirFlags.resolve(stderr)
	if !ok {
		return nil, ExitUsage, false
	}
	f.stateDir = dir
	return pos, ExitOK, true
}

func slicesHasEmpty(s []string) bool {
	for _, v := range s {
		if v == "" {
			return true
		}
	}
	return false
}

// client returns a hub client with the credential of the agent in the
// state directory, or false after saying why there is none.
func (f *sinkFlags) client(stderr io.Writer) (*hubclient.Client, bool) {
	ac, err := agentconf.Load(f.stateDir)
	if errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintln(stderr, "hookci: not connected to a hub; run hookci connect")
		return nil, false
	}
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return nil, false
	}
	return hubclient.New(hubclient.Config{HubURL: ac.HubURL, AgentID: ac.AgentID, Credential: ac.Credential, Version: version.Version}, nil, nil, nil), true
}

// checkRepo reports a --repo value that is not owner/name.
func checkRepo(cmd, repo string, stderr io.Writer) bool {
	if repoRE.MatchString(repo) {
		return true
	}
	fmt.Fprintf(stderr, "hookci: sink %s: --repo %q must be owner/name\n", cmd, repo)
	return false
}

func sinkAdd(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, sinkUsage)
		return ExitUsage
	}
	switch args[0] {
	case "telegram":
		return sinkAddTelegram(ctx, d, args[1:], stdout, stderr)
	case "webhook":
		return sinkAddWebhook(ctx, d, args[1:], stdout, stderr)
	case "linear":
		return sinkAddLinear(ctx, d, args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "hookci: sink add: unknown sink kind %q; want telegram, webhook or linear\n", args[0])
		return ExitUsage
	}
}

func sinkAddTelegram(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "add telegram --repo OWNER/NAME --chat-id ID [--label TEXT]", stderr)
	repo := f.String("repo", "", "repository the sink reports, as owner/name")
	chatID := f.String("chat-id", "", "Telegram chat id the bot posts to")
	label := f.String("label", "", "name shown in sink ls")
	if _, code, ok := f.parse(args, 0, stderr); !ok {
		return code
	}
	if !checkRepo("add telegram", *repo, stderr) {
		return ExitUsage
	}
	if *chatID == "" {
		fmt.Fprintln(stderr, "hookci: sink add telegram: --chat-id is required")
		return ExitUsage
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	token, err := readSecret(telegramTokenEnv, "Telegram bot token", d.Stdin, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if token == "" {
		fmt.Fprintf(stderr, "hookci: sink add telegram: no bot token; set %s or pass it on stdin\n", telegramTokenEnv)
		return ExitUsage
	}
	res, err := c.AddSink(ctx, hubclient.AddSinkRequest{Kind: "telegram", Repo: *repo, BotToken: token, ChatID: *chatID, Label: *label})
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "added telegram sink %s for %s: %s\n", res.Sink.ID, res.Sink.Repo, res.Sink.Target)
	return ExitOK
}

// readSecret returns the variable env, else one line of stdin. A terminal
// stdin gets a prompt naming what on stderr and is read without echo.
func readSecret(env, what string, stdin io.Reader, stderr io.Writer) (string, error) {
	if secret := strings.TrimSpace(os.Getenv(env)); secret != "" {
		return secret, nil
	}
	if stdin == nil {
		return "", nil
	}
	if f, ok := stdin.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		fmt.Fprintf(stderr, "%s: ", what)
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(stderr)
		if err != nil {
			return "", fmt.Errorf("cli: read %s: %w", strings.ToLower(what), err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	sc := bufio.NewScanner(stdin)
	if sc.Scan() {
		return strings.TrimSpace(sc.Text()), nil
	}
	if err := sc.Err(); err != nil {
		return "", fmt.Errorf("cli: read %s: %w", strings.ToLower(what), err)
	}
	return "", nil
}

func sinkAddLinear(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "add linear --repo OWNER/NAME --team KEY [--assignee EMAIL] [--label TEXT]", stderr)
	repo := f.String("repo", "", "repository the sink reports, as owner/name")
	team := f.String("team", "", "key of the Linear team the issues go to, like ENG")
	assignee := f.String("assignee", "", "email of the Linear user the issues are assigned to")
	label := f.String("label", "", "name shown in sink ls")
	if _, code, ok := f.parse(args, 0, stderr); !ok {
		return code
	}
	if !checkRepo("add linear", *repo, stderr) {
		return ExitUsage
	}
	if *team == "" {
		fmt.Fprintln(stderr, "hookci: sink add linear: --team is required")
		return ExitUsage
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	key, err := readSecret(linearAPIKeyEnv, "Linear API key", d.Stdin, stderr)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if key == "" {
		fmt.Fprintf(stderr, "hookci: sink add linear: %s not set and no key on stdin\n", linearAPIKeyEnv)
		return ExitUsage
	}
	res, err := c.AddSink(ctx, hubclient.AddSinkRequest{Kind: "linear", Repo: *repo, LinearAPIKey: key, TeamKey: *team, AssigneeEmail: *assignee, Label: *label})
	var apiErr *hubclient.APIError
	switch {
	case errors.As(err, &apiErr) && apiErr.Code == "team_not_found":
		fmt.Fprintf(stderr, "hookci: sink add linear: Linear team %s not found for this API key\n", *team)
		return ExitRunFailed
	case errors.As(err, &apiErr) && apiErr.Code == "assignee_not_found":
		fmt.Fprintf(stderr, "hookci: sink add linear: No Linear user with email %s\n", *assignee)
		return ExitRunFailed
	case err != nil:
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "added linear sink %s for %s: %s\n", res.Sink.ID, res.Sink.Repo, res.Sink.Target)
	return ExitOK
}

func sinkAddWebhook(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "add webhook --repo OWNER/NAME --url https://... [--label TEXT] [--secret-only]", stderr)
	repo := f.String("repo", "", "repository the sink reports, as owner/name")
	hookURL := f.String("url", "", "https URL the hub posts signed run events to")
	label := f.String("label", "", "name shown in sink ls")
	secretOnly := f.Bool("secret-only", false, "print only the signing secret, for piping it into a secret store")
	if _, code, ok := f.parse(args, 0, stderr); !ok {
		return code
	}
	if !checkRepo("add webhook", *repo, stderr) {
		return ExitUsage
	}
	if *hookURL == "" {
		fmt.Fprintln(stderr, "hookci: sink add webhook: --url is required")
		return ExitUsage
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	res, err := c.AddSink(ctx, hubclient.AddSinkRequest{Kind: "webhook", Repo: *repo, URL: *hookURL, Label: *label})
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if res.GeneratedSecret == "" {
		fmt.Fprintf(stderr, "hookci: sink add webhook: hub added sink %s without a signing secret\n", res.Sink.ID)
		return ExitRunFailed
	}
	if *secretOnly {
		fmt.Fprintln(stdout, res.GeneratedSecret)
		return ExitOK
	}
	fmt.Fprintf(stdout, "added webhook sink %s for %s: %s\n", res.Sink.ID, res.Sink.Repo, res.Sink.Target)
	fmt.Fprintf(stdout, "signing secret (shown only this once): %s\n", res.GeneratedSecret)
	return ExitOK
}

func sinkList(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "ls --repo OWNER/NAME [--json]", stderr)
	repo := f.String("repo", "", "repository whose sinks to list, as owner/name")
	asJSON := f.Bool("json", false, "print the sinks as a JSON array")
	if _, code, ok := f.parse(args, 0, stderr); !ok {
		return code
	}
	if !checkRepo("ls", *repo, stderr) {
		return ExitUsage
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	sinks, err := c.ListSinks(ctx, *repo)
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	if *asJSON {
		return writeJSON(stdout, stderr, sinks)
	}
	tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tKIND\tLABEL\tTARGET\tSTATUS")
	for _, s := range sinks {
		label := "-"
		if s.Label != nil && *s.Label != "" {
			label = *s.Label
		}
		status := "enabled"
		if s.DisabledAt != nil {
			status = "disabled"
			if s.LastError != nil && *s.LastError != "" {
				status += ": " + *s.LastError
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", s.ID, s.Kind, label, s.Target, status)
	}
	return flushTable(tw, stderr)
}

func sinkRemove(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "rm <id>", stderr)
	pos, code, ok := f.parse(args, 1, stderr)
	if !ok {
		return code
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	if err := c.RemoveSink(ctx, pos[0]); err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "removed sink %s\n", pos[0])
	return ExitOK
}

// sinkTest sends a test delivery; a result other than ok exits 1.
func sinkTest(ctx context.Context, d Deps, args []string, stdout, stderr io.Writer) int {
	f := newSinkFlags(d, "test <id>", stderr)
	pos, code, ok := f.parse(args, 1, stderr)
	if !ok {
		return code
	}
	c, ok := f.client(stderr)
	if !ok {
		return ExitRunFailed
	}
	res, err := c.TestSink(ctx, pos[0])
	if err != nil {
		fmt.Fprintf(stderr, "hookci: %v\n", err)
		return ExitRunFailed
	}
	fmt.Fprintf(stdout, "test delivery through %s: %s\n", pos[0], res)
	if res != "ok" {
		return ExitRunFailed
	}
	return ExitOK
}
