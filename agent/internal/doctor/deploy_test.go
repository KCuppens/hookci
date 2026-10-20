package doctor

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"testing/fstest"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
	"github.com/KCuppens/zerocideploy/agent/internal/execx"
)

const (
	deployPasswd = "root:x:0:0::/root:/bin/sh\nzeroci-deploy:x:997:997::/nonexistent:/usr/sbin/nologin\n"
	deployGroup  = "root:x:0:\nzeroci-deploy:x:997:\ndocker:x:999:alice,zeroci-deploy\n"
	envFile      = "/etc/zeroci/app.env"
	routeFile    = "/etc/caddy/routes/app.caddy"
)

// deployExec answers the docker and caddy commands of a healthy deploy host,
// each response overridable by name args.
func deployExec(over map[string]execx.FakeResponse) *execx.Fake {
	ex := &execx.Fake{}
	for _, c := range []struct {
		key  string
		args []string
		resp execx.FakeResponse
	}{
		{"version", []string{"version", "--format", "{{.Server.Version}}"}, execx.FakeResponse{Stdout: "27.1.1\n"}},
		{"compose", []string{"compose", "version", "--short"}, execx.FakeResponse{Stdout: "2.29.1\n"}},
		{"buildx", []string{"buildx", "version"}, execx.FakeResponse{Stdout: "github.com/docker/buildx v0.16.1\n"}},
		{"info", []string{"info", "--format", "{{.DockerRootDir}}"}, execx.FakeResponse{Stdout: "/var/lib/docker\n"}},
	} {
		resp := c.resp
		if o, ok := over[c.key]; ok {
			resp = o
		}
		ex.On("docker", c.args, resp)
	}
	ex.On("caddy", []string{"version"}, execx.FakeResponse{Stdout: "v2.8.4\n"})
	return ex
}

// deployFS is healthyFS plus the deploy user, the docker group, a root 0600
// env file and the route directory.
func deployFS() fstest.MapFS {
	m := healthyFS()
	m["etc/passwd"] = &fstest.MapFile{Data: []byte(deployPasswd)}
	m["etc/group"] = &fstest.MapFile{Data: []byte(deployGroup)}
	m["etc/zeroci/app.env"] = &fstest.MapFile{Data: []byte("TOKEN=x\n"), Mode: 0o600, Sys: &syscall.Stat_t{Uid: 0}}
	m["etc/caddy/routes"] = &fstest.MapFile{Mode: fs.ModeDir | 0o755}
	return m
}

// closedAddr is a caddy admin URL nothing listens on.
func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	l.Close()
	return "http://" + addr + "/config/"
}

func deployEnv(t *testing.T) Env {
	t.Helper()
	return Env{
		StateRoot: "/var/lib/zeroci",
		HTTP:      &http.Client{},
		Exec:      deployExec(nil),
		FS:        deployFS(),
		DiskFree:  func(string) (uint64, error) { return 50 << 30, nil },
		Writable:  func(string) error { return nil },
	}
}

// caddyRepos has one production deployment with a caddy route and an env file.
func caddyRepos(context.Context) ([]config.ZeroCIConfig, error) {
	file := envFile
	return []config.ZeroCIConfig{{Deployments: config.ZeroCIConfigDeployments{
		"production": {EnvFile: &file, Route: &config.DeploymentRoute{Kind: config.DeploymentRouteKindCaddy, File: routeFile}},
	}}}, nil
}

func checkByID(t *testing.T, deps DeployCheckDeps, id string) Check {
	t.Helper()
	for _, c := range DeployChecks(deps) {
		if c.ID() == id {
			return c
		}
	}
	t.Fatalf("no check %s", id)
	return nil
}

func TestDeployChecks_AllPassOnHealthyHost(t *testing.T) {
	deps := DeployCheckDeps{Repos: caddyRepos, CaddyAdmin: closedAddr(t)}
	rs := Run(context.Background(), deployEnv(t), DeployChecks(deps))
	want := []string{"deploy.docker", "deploy.buildx", "deploy.caddy", "deploy.route_file", "deploy.env_file", "deploy.user", "deploy.caddy_admin", "deploy.disk"}
	if len(rs) != len(want) {
		t.Fatalf("got %d results, want %d", len(rs), len(want))
	}
	for i, r := range rs {
		if r.ID != want[i] {
			t.Errorf("result %d id = %q, want %q", i, r.ID, want[i])
		}
		if r.Status != Pass {
			t.Errorf("%s = %s (%s), want pass", r.ID, r.Status, r.Detail)
		}
	}
}

func TestDoctor_ComposeVersion(t *testing.T) {
	tests := []struct {
		name string
		over map[string]execx.FakeResponse
		want Status
	}{
		{"2.23.3 too old", map[string]execx.FakeResponse{"compose": {Stdout: "2.23.3\n"}}, Fail},
		{"2.24.0", map[string]execx.FakeResponse{"compose": {Stdout: "2.24.0\n"}}, Pass},
		{"v prefix", map[string]execx.FakeResponse{"compose": {Stdout: "v2.29.1\n"}}, Pass},
		{"3.0", map[string]execx.FakeResponse{"compose": {Stdout: "3.0.0\n"}}, Pass},
		{"unparsable", map[string]execx.FakeResponse{"compose": {Stdout: "dev\n"}}, Fail},
		{"no compose plugin", map[string]execx.FakeResponse{"compose": {Err: errors.New("exit 1")}}, Fail},
		{"daemon down", map[string]execx.FakeResponse{"version": {Err: errors.New("cannot connect")}}, Fail},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := deployEnv(t)
			env.Exec = deployExec(tt.over)
			r := runOne(t, checkByID(t, DeployCheckDeps{}, "deploy.docker"), env)
			if r.Status != tt.want {
				t.Fatalf("status = %s (%s), want %s", r.Status, r.Detail, tt.want)
			}
			if r.Status == Fail && r.Fix != dockerFix {
				t.Errorf("fix = %q", r.Fix)
			}
		})
	}
}

func TestDoctor_Buildx(t *testing.T) {
	env := deployEnv(t)
	env.Exec = deployExec(map[string]execx.FakeResponse{"buildx": {Err: errors.New("not a docker command")}})
	r := runOne(t, checkByID(t, DeployCheckDeps{}, "deploy.buildx"), env)
	if r.Status != Fail || r.Fix != "install docker-buildx-plugin" {
		t.Errorf("result = %+v", r)
	}
}

func TestDoctor_EnvFilePerms(t *testing.T) {
	tests := []struct {
		name string
		file *fstest.MapFile
		want Status
		in   string
	}{
		{"root 0600", &fstest.MapFile{Mode: 0o600, Sys: &syscall.Stat_t{Uid: 0}}, Pass, "root-owned"},
		{"root 0400", &fstest.MapFile{Mode: 0o400, Sys: &syscall.Stat_t{Uid: 0}}, Pass, "root-owned"},
		// A trusted deploy refuses a group-readable env_file, so doctor must too.
		{"group readable", &fstest.MapFile{Mode: 0o640, Sys: &syscall.Stat_t{Uid: 0}}, Fail, "mode 0640, want 0600"},
		{"world readable", &fstest.MapFile{Mode: 0o644, Sys: &syscall.Stat_t{Uid: 0}}, Fail, "mode 0644"},
		{"group writable", &fstest.MapFile{Mode: 0o660, Sys: &syscall.Stat_t{Uid: 0}}, Fail, "mode 0660"},
		{"not root", &fstest.MapFile{Mode: 0o600, Sys: &syscall.Stat_t{Uid: 1000}}, Fail, "uid 1000"},
		{"missing", nil, Fail, "deployments.production.env_file"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := deployEnv(t)
			m := env.FS.(fstest.MapFS)
			if tt.file == nil {
				delete(m, "etc/zeroci/app.env")
			} else {
				m["etc/zeroci/app.env"] = tt.file
			}
			r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.env_file"), env)
			if r.Status != tt.want || !strings.Contains(r.Detail, tt.in) {
				t.Fatalf("result = %s %q, want %s containing %q", r.Status, r.Detail, tt.want, tt.in)
			}
			if fix := "sudo chown root:root " + envFile + " && sudo chmod 600 " + envFile; r.Status == Fail && !strings.HasSuffix(r.Fix, fix) {
				t.Errorf("fix = %q, want suffix %q", r.Fix, fix)
			}
		})
	}
}

func TestDoctor_DeployUser(t *testing.T) {
	tests := []struct {
		name   string
		passwd string
		group  string
		want   Status
		fix    string
	}{
		{"member", deployPasswd, deployGroup, Pass, ""},
		{"primary group", "zeroci-deploy:x:997:999::/nonexistent:/usr/sbin/nologin\n", "docker:x:999:\n", Pass, ""},
		{"not a member", deployPasswd, "docker:x:999:alice\n", Fail, "sudo usermod -aG docker zeroci-deploy"},
		{"no docker group", deployPasswd, "root:x:0:\n", Fail, dockerFix + ", then sudo usermod -aG docker zeroci-deploy"},
		{"no deploy user", "root:x:0:0::/root:/bin/sh\n", deployGroup, Fail, reinstallFix},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := deployEnv(t)
			m := env.FS.(fstest.MapFS)
			m["etc/passwd"] = &fstest.MapFile{Data: []byte(tt.passwd)}
			m["etc/group"] = &fstest.MapFile{Data: []byte(tt.group)}
			r := runOne(t, checkByID(t, DeployCheckDeps{}, "deploy.user"), env)
			if r.Status != tt.want || r.Fix != tt.fix {
				t.Errorf("result = %s %q fix %q, want %s fix %q", r.Status, r.Detail, r.Fix, tt.want, tt.fix)
			}
		})
	}
}

func TestDoctor_CaddyAdmin(t *testing.T) {
	admin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("{}"))
	}))
	defer admin.Close()

	t.Run("answering admin fails", func(t *testing.T) {
		r := runOne(t, checkByID(t, DeployCheckDeps{CaddyAdmin: admin.URL + "/config/"}, "deploy.caddy_admin"), deployEnv(t))
		if r.Status != Fail || r.Fix != caddyAdminFix || !strings.Contains(r.Detail, "200 OK") {
			t.Errorf("result = %+v", r)
		}
	})
	t.Run("closed port passes", func(t *testing.T) {
		r := runOne(t, checkByID(t, DeployCheckDeps{CaddyAdmin: closedAddr(t)}, "deploy.caddy_admin"), deployEnv(t))
		if r.Status != Pass {
			t.Errorf("result = %+v", r)
		}
	})
	t.Run("other transport error does not pass", func(t *testing.T) {
		env := deployEnv(t)
		env.HTTP = &http.Client{Transport: failTransport{context.DeadlineExceeded}}
		r := runOne(t, checkByID(t, DeployCheckDeps{CaddyAdmin: "http://127.0.0.1:2019/config/"}, "deploy.caddy_admin"), env)
		if r.Status != Warn || r.Fix != caddyAdminFix || !strings.Contains(r.Detail, "deadline exceeded") {
			t.Errorf("result = %+v", r)
		}
	})
	t.Run("allow_caddy_tcp_admin warns", func(t *testing.T) {
		env := deployEnv(t)
		env.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"].Data = []byte(`{"agent_id":"agt_1","credential":"c","installation_id":42,"doctor":{"allow_caddy_tcp_admin":true}}`)
		r := runOne(t, checkByID(t, DeployCheckDeps{CaddyAdmin: admin.URL + "/config/"}, "deploy.caddy_admin"), env)
		if r.Status != Warn || r.Fix != caddyAdminFix {
			t.Errorf("result = %+v", r)
		}
	})
}

// failTransport fails every request with err.
type failTransport struct{ err error }

func (f failTransport) RoundTrip(*http.Request) (*http.Response, error) { return nil, f.err }

func TestDoctor_CaddySkippedWithoutCaddyRoutes(t *testing.T) {
	noRepos := func(context.Context) ([]config.ZeroCIConfig, error) { return nil, nil }
	noRoute := func(context.Context) ([]config.ZeroCIConfig, error) {
		return []config.ZeroCIConfig{{Deployments: config.ZeroCIConfigDeployments{"staging": {}}}}, nil
	}
	for name, repos := range map[string]func(context.Context) ([]config.ZeroCIConfig, error){"no repos": noRepos, "no route": noRoute, "nil": nil} {
		t.Run(name, func(t *testing.T) {
			env := deployEnv(t)
			ex := deployExec(nil)
			env.Exec = ex
			for _, id := range []string{"deploy.caddy", "deploy.route_file", "deploy.env_file"} {
				if r := runOne(t, checkByID(t, DeployCheckDeps{Repos: repos}, id), env); r.Status != Skip {
					t.Errorf("%s = %s (%s), want skip", id, r.Status, r.Detail)
				}
			}
			if ex.Called("caddy") {
				t.Error("ran caddy without a caddy route")
			}
		})
	}

	t.Run("repo config error fails", func(t *testing.T) {
		bad := func(context.Context) ([]config.ZeroCIConfig, error) {
			return nil, errors.New(".zeroci.yml: version: required")
		}
		for _, id := range []string{"deploy.caddy", "deploy.route_file", "deploy.env_file"} {
			r := runOne(t, checkByID(t, DeployCheckDeps{Repos: bad}, id), deployEnv(t))
			if r.Status != Fail || !strings.Contains(r.Detail, "version: required") {
				t.Errorf("%s = %+v, want fail", id, r)
			}
		}
	})

	t.Run("caddy missing fails", func(t *testing.T) {
		env := deployEnv(t)
		ex := &execx.Fake{}
		ex.On("caddy", nil, execx.FakeResponse{Err: errors.New("executable file not found")})
		env.Exec = ex
		if r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.caddy"), env); r.Status != Fail {
			t.Errorf("result = %+v", r)
		}
	})
}

func TestDoctor_RouteFile(t *testing.T) {
	t.Run("missing dir", func(t *testing.T) {
		env := deployEnv(t)
		delete(env.FS.(fstest.MapFS), "etc/caddy/routes")
		r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.route_file"), env)
		if r.Status != Fail || r.Fix != "sudo mkdir -p /etc/caddy/routes" {
			t.Errorf("result = %+v", r)
		}
	})
	t.Run("not writable", func(t *testing.T) {
		env := deployEnv(t)
		var asked string
		env.Writable = func(dir string) error { asked = dir; return syscall.EACCES }
		r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.route_file"), env)
		if r.Status != Fail || asked != "/etc/caddy/routes" || !strings.Contains(r.Detail, "not writable") {
			t.Errorf("result = %+v, asked %q", r, asked)
		}
	})
	t.Run("outside route_dirs", func(t *testing.T) {
		env := deployEnv(t)
		m := env.FS.(fstest.MapFS)
		m["var/lib/zeroci/42/agent.json"].Data = []byte(`{"agent_id":"agt_1","credential":"c","installation_id":42,"deploy":{"route_dirs":["/opt/routes"]}}`)
		r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.route_file"), env)
		if r.Status != Fail || !strings.Contains(r.Detail, "deployments.production.route.file") ||
			!strings.Contains(r.Fix, "/var/lib/zeroci/42/agent.json") {
			t.Errorf("result = %+v", r)
		}
		m["var/lib/zeroci/42/agent.json"].Data = []byte(`{"agent_id":"agt_1","credential":"c","installation_id":42,"deploy":{"route_dirs":["/opt/routes","/etc/caddy/routes"]}}`)
		if r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.route_file"), env); r.Status != Pass {
			t.Errorf("result = %+v, want pass inside a listed dir", r)
		}
	})
	t.Run("outside default route_dirs when unpaired", func(t *testing.T) {
		env := deployEnv(t)
		delete(env.FS.(fstest.MapFS), "var/lib/zeroci/42/agent.json")
		repos := func(context.Context) ([]config.ZeroCIConfig, error) {
			return []config.ZeroCIConfig{{Deployments: config.ZeroCIConfigDeployments{
				"production": {Route: &config.DeploymentRoute{Kind: config.DeploymentRouteKindCaddy, File: "/srv/routes/app.caddy"}},
			}}}, nil
		}
		if r := runOne(t, checkByID(t, DeployCheckDeps{Repos: repos}, "deploy.route_file"), env); r.Status != Fail || !strings.Contains(r.Fix, "/etc/caddy") {
			t.Errorf("result = %+v", r)
		}
	})
	t.Run("broken agent.json fails", func(t *testing.T) {
		env := deployEnv(t)
		env.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"].Data = []byte(`{`)
		r := runOne(t, checkByID(t, DeployCheckDeps{Repos: caddyRepos}, "deploy.route_file"), env)
		if r.Status != Fail || !strings.Contains(r.Detail, "/var/lib/zeroci/42/agent.json") {
			t.Errorf("result = %+v", r)
		}
	})
}

func TestDoctor_DiskCheck(t *testing.T) {
	free := map[string]uint64{"/var/lib/docker": 1 << 30, "/var/lib/zeroci/42": 50 << 30}
	env := deployEnv(t)
	env.DiskFree = func(p string) (uint64, error) {
		v, ok := free[p]
		if !ok {
			return 0, errors.New("unexpected path " + p)
		}
		return v, nil
	}
	c := checkByID(t, DeployCheckDeps{}, "deploy.disk")

	r := runOne(t, c, env)
	want := "gc.min_free_bytes: free disk 1073741824 on /var/lib/docker below 5368709120; run zeroci gc or raise the limit"
	if r.Status != Fail || r.Detail != want {
		t.Errorf("result = %s %q, want fail %q", r.Status, r.Detail, want)
	}

	// The installation's gc.min_free_bytes applies.
	env.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"].Data = []byte(`{"agent_id":"agt_1","credential":"c","installation_id":42,"gc":{"min_free_bytes":536870912}}`)
	if r := runOne(t, c, env); r.Status != Pass {
		t.Errorf("result = %s %q, want pass under a 512 MiB limit", r.Status, r.Detail)
	}

	env.Exec = deployExec(map[string]execx.FakeResponse{"info": {Err: errors.New("cannot connect")}})
	if r := runOne(t, c, env); r.Status != Fail || !strings.Contains(r.Detail, "docker info") {
		t.Errorf("result = %+v, want docker info failure", r)
	}

	// A broken agent.json fails instead of falling back to the default limit.
	env.Exec = deployExec(nil)
	env.FS.(fstest.MapFS)["var/lib/zeroci/42/agent.json"].Data = []byte(`{"gc":`)
	if r := runOne(t, c, env); r.Status != Fail || !strings.Contains(r.Detail, "/var/lib/zeroci/42/agent.json") {
		t.Errorf("result = %+v, want agent.json failure", r)
	}
}
