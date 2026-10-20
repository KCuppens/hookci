package doctor

import (
	"bufio"
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/KCuppens/hookci/agent/internal/agentconf"
	"github.com/KCuppens/hookci/agent/internal/config"
	"github.com/KCuppens/hookci/agent/internal/deploy"
	"github.com/KCuppens/hookci/agent/internal/proxy/caddy"
)

// DefaultCaddyAdmin is the TCP address Caddy serves its admin API on unless
// the Caddyfile moves it.
const DefaultCaddyAdmin = "http://localhost:2019/config/"

const (
	caddyAdminTimeout = 2 * time.Second
	dockerFix         = "install Docker Engine and the compose plugin 2.24+"
	caddyAdminFix     = "set admin unix//run/caddy/admin.sock in the Caddyfile and add --address unix//run/caddy/admin.sock to route.reload"
)

// minCompose is the oldest docker compose the deploy strategies support.
var minCompose = [2]int{2, 24}

// DeployCheckDeps is what the deploy checks need beyond Env.
type DeployCheckDeps struct {
	// Repos returns the hookci configs whose deployments run on this host.
	Repos func(ctx context.Context) ([]config.HookCIConfig, error)
	// CaddyAdmin is the URL of the Caddy admin API on TCP, default
	// DefaultCaddyAdmin.
	CaddyAdmin string
}

// DeployChecks is every deploy check hookci doctor runs after Default, in
// display order. deploy.caddy, deploy.route_file and deploy.env_file skip
// when no deployment of deps.Repos needs them.
func DeployChecks(deps DeployCheckDeps) []Check {
	admin := cmp.Or(deps.CaddyAdmin, DefaultCaddyAdmin)
	return []Check{
		deployCheck{"deploy.docker", dockerCheck},
		deployCheck{"deploy.buildx", buildxCheck},
		deployCheck{"deploy.caddy", func(ctx context.Context, env Env) Result { return caddyCheck(ctx, env, deps.Repos) }},
		deployCheck{"deploy.route_file", func(ctx context.Context, env Env) Result { return routeFileCheck(ctx, env, deps.Repos) }},
		deployCheck{"deploy.env_file", func(ctx context.Context, env Env) Result { return envFileCheck(ctx, env, deps.Repos) }},
		deployCheck{"deploy.user", deployUserCheck},
		deployCheck{"deploy.caddy_admin", func(ctx context.Context, env Env) Result { return caddyAdminCheck(ctx, env, admin) }},
		deployCheck{"deploy.disk", diskCheck},
	}
}

// deployCheck is a Check backed by a func.
type deployCheck struct {
	id  string
	run func(ctx context.Context, env Env) Result
}

func (c deployCheck) ID() string { return c.id }

func (c deployCheck) Run(ctx context.Context, env Env) Result { return c.run(ctx, env) }

func skip(title, detail string) Result { return Result{Title: title, Status: Skip, Detail: detail} }

// dockerCheck wants a reachable docker daemon and docker compose >= 2.24.
func dockerCheck(ctx context.Context, env Env) Result {
	const title = "docker for deploys"
	server, err := output(ctx, env.Exec, "docker", "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return fail(title, fmt.Sprintf("docker version: %v", err), dockerFix)
	}
	compose, err := output(ctx, env.Exec, "docker", "compose", "version", "--short")
	if err != nil {
		return fail(title, fmt.Sprintf("docker compose version: %v", err), dockerFix)
	}
	v, ok := parseMajorMinor(compose)
	if !ok {
		return fail(title, fmt.Sprintf("cannot parse docker compose version %q", compose), dockerFix)
	}
	if v[0] < minCompose[0] || (v[0] == minCompose[0] && v[1] < minCompose[1]) {
		return fail(title, fmt.Sprintf("docker compose %s is older than %d.%d", compose, minCompose[0], minCompose[1]), dockerFix)
	}
	return pass(title, fmt.Sprintf("docker %s, compose %s", server, compose))
}

// parseMajorMinor reads major.minor from "2.29.1" or "v2.29.1".
func parseMajorMinor(s string) ([2]int, bool) {
	parts := strings.SplitN(strings.TrimPrefix(strings.TrimSpace(s), "v"), ".", 3)
	if len(parts) < 2 {
		return [2]int{}, false
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return [2]int{}, false
	}
	return [2]int{major, minor}, true
}

// buildxCheck wants the buildx plugin compose builds with.
func buildxCheck(ctx context.Context, env Env) Result {
	const title = "docker buildx"
	out, err := output(ctx, env.Exec, "docker", "buildx", "version")
	if err != nil {
		return fail(title, fmt.Sprintf("docker buildx version: %v", err), "install docker-buildx-plugin")
	}
	return pass(title, out)
}

// envDeployment is deployments.<env> of one repo config.
type envDeployment struct {
	env string
	dep config.Deployment
}

// deployments lists every deployment of repos, ordered by env name within
// each repo.
func deployments(ctx context.Context, repos func(context.Context) ([]config.HookCIConfig, error)) ([]envDeployment, error) {
	if repos == nil {
		return nil, nil
	}
	cfgs, err := repos(ctx)
	if err != nil {
		return nil, err
	}
	var out []envDeployment
	for _, c := range cfgs {
		for _, env := range slices.Sorted(maps.Keys(c.Deployments)) {
			out = append(out, envDeployment{env: env, dep: c.Deployments[env]})
		}
	}
	return out, nil
}

// caddyCheck wants caddy on PATH when a deployment routes through caddy.
func caddyCheck(ctx context.Context, env Env, repos func(context.Context) ([]config.HookCIConfig, error)) Result {
	const title = "caddy"
	deps, err := deployments(ctx, repos)
	if err != nil {
		return fail(title, err.Error(), "fix .hookci.yml: hookci validate")
	}
	if !slices.ContainsFunc(deps, func(d envDeployment) bool {
		return d.dep.Route != nil && d.dep.Route.Kind == config.DeploymentRouteKindCaddy
	}) {
		return skip(title, "no deployment routes through caddy")
	}
	out, err := output(ctx, env.Exec, "caddy", "version")
	if err != nil {
		return fail(title, fmt.Sprintf("caddy version: %v", err), "install Caddy 2 from caddyserver.com/docs/install")
	}
	return pass(title, out)
}

// routeFileCheck wants every route file inside deploy.route_dirs of every
// paired installation, or the default dirs when none is paired, and its
// directory to exist and accept new files, since the route is written to a
// temp file there and renamed into place.
func routeFileCheck(ctx context.Context, env Env, repos func(context.Context) ([]config.HookCIConfig, error)) Result {
	const title = "route files"
	deps, err := deployments(ctx, repos)
	if err != nil {
		return fail(title, err.Error(), "fix .hookci.yml: hookci validate")
	}
	insts, err := pairedOrDefault(env)
	if err != nil {
		return fail(title, err.Error(), connectFix)
	}
	var dirs []string
	for _, d := range deps {
		if d.dep.Route == nil {
			continue
		}
		for _, in := range insts {
			routeDirs := deploy.RouteDirs(in.conf.AgentConfig)
			if _, err := caddy.RouteDir(routeDirs, d.dep.Route.File); err != nil {
				return fail(title, fmt.Sprintf("deployments.%s.%v", d.env, err),
					fmt.Sprintf("move route.file into %s, or add its directory to deploy.route_dirs in %s", strings.Join(routeDirs, " or "), path.Join(in.dir, agentconf.FileName)))
			}
		}
		dir := filepath.Dir(d.dep.Route.File)
		fi, err := fs.Stat(env.FS, fsPath(dir))
		if err != nil {
			return fail(title, fmt.Sprintf("deployments.%s.route.file: %v", d.env, err), "sudo mkdir -p "+dir)
		}
		if !fi.IsDir() {
			return fail(title, fmt.Sprintf("deployments.%s.route.file: %s is not a directory", d.env, dir), "point route.file at a file in a directory")
		}
		if err := env.Writable(dir); err != nil {
			return fail(title, fmt.Sprintf("deployments.%s.route.file: %s is not writable: %v", d.env, dir, err), "run hookci doctor as root, the user the agent runs as")
		}
		dirs = append(dirs, dir)
	}
	if len(dirs) == 0 {
		return skip(title, "no deployment has a route")
	}
	return pass(title, strings.Join(slices.Compact(slices.Sorted(slices.Values(dirs))), ", ")+" writable")
}

// envFileCheck wants every env file owned by root with no permission for
// group or others, the rule a trusted deploy enforces when it loads the file.
func envFileCheck(ctx context.Context, env Env, repos func(context.Context) ([]config.HookCIConfig, error)) Result {
	const title = "env files"
	deps, err := deployments(ctx, repos)
	if err != nil {
		return fail(title, err.Error(), "fix .hookci.yml: hookci validate")
	}
	var files []string
	for _, d := range deps {
		if d.dep.EnvFile == nil {
			continue
		}
		file := *d.dep.EnvFile
		fix := fmt.Sprintf("sudo chown root:root %s && sudo chmod 600 %s", file, file)
		fi, err := fs.Stat(env.FS, fsPath(file))
		if err != nil {
			return fail(title, fmt.Sprintf("deployments.%s.env_file: %v", d.env, err), "create "+file+", then "+fix)
		}
		uid, ok := ownerUID(fi)
		switch {
		case !ok:
			return fail(title, "cannot read the owner of "+file, fix)
		case uid != 0:
			return fail(title, fmt.Sprintf("%s is owned by uid %d, want root", file, uid), fix)
		case !config.EnvFilePermOK(fi.Mode().Perm()):
			return fail(title, fmt.Sprintf("%s has mode %04o, want 0600", file, fi.Mode().Perm()), fix)
		}
		files = append(files, file)
	}
	if len(files) == 0 {
		return skip(title, "no deployment has an env_file")
	}
	return pass(title, strings.Join(files, ", ")+" root-owned, mode 0600")
}

// deployUserCheck wants deploy.DeployUser in the docker group, so deploy
// units can run docker compose.
func deployUserCheck(_ context.Context, env Env) Result {
	const title = "deploy user"
	const user = deploy.DeployUser
	fix := "sudo usermod -aG docker " + user
	gid, ok, err := passwdGID(env, user)
	if err != nil {
		return fail(title, fmt.Sprintf("/etc/passwd: %v", err), reinstallFix)
	}
	if !ok {
		return fail(title, "no "+user+" user", reinstallFix)
	}
	dockerGID, members, ok, err := groupEntry(env, "docker")
	if err != nil {
		return fail(title, fmt.Sprintf("/etc/group: %v", err), dockerFix)
	}
	if !ok {
		return fail(title, "no docker group", dockerFix+", then "+fix)
	}
	if gid != dockerGID && !slices.Contains(members, user) {
		return fail(title, user+" is not in group docker", fix)
	}
	return pass(title, user+" is in group docker")
}

// passwdGID is the primary gid of name in /etc/passwd.
func passwdGID(env Env, name string) (gid string, ok bool, err error) {
	fields, ok, err := colonEntry(env, "etc/passwd", name)
	if err != nil || !ok || len(fields) < 4 {
		return "", false, err
	}
	return fields[3], true, nil
}

// groupEntry is the gid and member list of group name in /etc/group.
func groupEntry(env Env, name string) (gid string, members []string, ok bool, err error) {
	fields, ok, err := colonEntry(env, "etc/group", name)
	if err != nil || !ok || len(fields) < 3 {
		return "", nil, false, err
	}
	if len(fields) > 3 && fields[3] != "" {
		members = strings.Split(fields[3], ",")
	}
	return fields[2], members, true, nil
}

// colonEntry returns the colon-separated fields of the line of file whose
// first field is name.
func colonEntry(env Env, file, name string) ([]string, bool, error) {
	f, err := env.FS.Open(file)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Split(sc.Text(), ":")
		if fields[0] == name {
			return fields, true, nil
		}
	}
	return nil, false, sc.Err()
}

// caddyAdminCheck wants the Caddy admin API off TCP: anyone on the host who
// reaches it can rewrite every route. An answer fails the check, or warns
// when every paired installation sets doctor.allow_caddy_tcp_admin.
func caddyAdminCheck(ctx context.Context, env Env, admin string) Result {
	const title = "caddy admin API"
	ctx, cancel := context.WithTimeout(ctx, caddyAdminTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, admin, nil)
	if err != nil {
		return fail(title, err.Error(), caddyAdminFix)
	}
	resp, err := env.HTTP.Do(req)
	if errors.Is(err, syscall.ECONNREFUSED) {
		return pass(title, "nothing listens on "+req.URL.Host)
	}
	if err != nil {
		return warn(title, fmt.Sprintf("cannot tell whether the Caddy admin API is on %s: %v", req.URL.Host, err), caddyAdminFix)
	}
	resp.Body.Close()
	detail := fmt.Sprintf("%s answers with %s", admin, resp.Status)
	if allowCaddyTCPAdmin(env) {
		return warn(title, detail+" (doctor.allow_caddy_tcp_admin)", caddyAdminFix)
	}
	return fail(title, detail, caddyAdminFix)
}

// allowCaddyTCPAdmin reports whether every paired installation sets
// doctor.allow_caddy_tcp_admin in its agent.json.
func allowCaddyTCPAdmin(env Env) bool {
	insts, err := installations(env)
	if err != nil || len(insts) == 0 {
		return false
	}
	for _, in := range insts {
		if d := in.conf.Doctor; d == nil || !d.AllowCaddyTcpAdmin {
			return false
		}
	}
	return true
}

// diskCheck applies the deploy disk headroom gate to the docker root dir and
// every paired state dir, each against its installation's
// gc.min_free_bytes, or the state root against the default when none is
// paired.
func diskCheck(ctx context.Context, env Env) Result {
	const title = "deploy disk headroom"
	const fix = "free space on that file system: hookci gc prunes images and build cache"
	root, err := deploy.DockerRootDir(ctx, env.Exec)
	if err != nil {
		return fail(title, err.Error(), dockerFix)
	}
	insts, err := pairedOrDefault(env)
	if err != nil {
		return fail(title, err.Error(), connectFix)
	}
	for _, in := range insts {
		if err := deploy.CheckDiskHeadroom([]string{root, in.dir}, deploy.MinFreeBytes(in.conf.AgentConfig), env.DiskFree); err != nil {
			return fail(title, err.Error(), fix)
		}
	}
	return pass(title, fmt.Sprintf("%s and %s above gc.min_free_bytes", root, env.StateRoot))
}

// pairedOrDefault is the paired installations, or the state root with the
// default agent.json when none is paired. An agent.json that cannot be read
// or decoded is an error.
func pairedOrDefault(env Env) ([]installation, error) {
	insts, err := installations(env)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if len(insts) == 0 {
		return []installation{{dir: env.StateRoot}}, nil
	}
	return insts, nil
}
