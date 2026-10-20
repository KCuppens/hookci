package scheduler

import (
	"slices"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/store"
)

const (
	sha1 = "1111111aaaaaaaa"
	sha2 = "2222222bbbbbbbb"
	sha3 = "3333333cccccccc"
)

func wantSuperseded(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("Submit superseded %v, want %v", got, want)
	}
}

// The runs Submit supersedes sit queued in the store only, as if left over
// from a restart; one scheduler drives one run.

func TestNewerDeployReplacesQueuedOlder(t *testing.T) {
	h := newHarness(t, 1)
	h.runner.setAuto()
	h.create(deployRun("A", sha1, "production"), job("deploy"))
	h.create(deployRun("B", sha2, "production"), job("deploy"))

	wantSuperseded(t, h.submit(h.create(deployRun("C", sha3, "production"), job("deploy"))), "A", "B")
	h.idle()

	reason := "superseded by " + sha3[:7]
	for _, id := range []string{"A", "B"} {
		h.wantRun(id, store.RunSuperseded, reason)
		h.wantJob(id, "deploy", store.JobSkipped, reason)
	}
	h.wantRun("C", store.RunSuccess, "")
	wantStarts(t, h.runner, "C:setup", "C:deploy")
}

func TestPRSupersedeQueued(t *testing.T) {
	h := newHarness(t, 1)
	h.runner.setAuto()
	h.create(prRun("p0", sha1, 7), job("a"))
	h.create(prRun("other", sha2, 8), job("a"))

	wantSuperseded(t, h.submit(h.create(prRun("p1", sha3, 7), job("a"))), "p0")
	h.idle()

	h.wantRun("p0", store.RunSuperseded, "superseded by "+sha3[:7])
	h.wantJob("p0", "a", store.JobSkipped, "superseded by "+sha3[:7])
	h.wantRun("other", store.RunQueued, "")
	h.wantRun("p1", store.RunSuccess, "")
}

func TestPushSupersedeQueuedSameRef(t *testing.T) {
	h := newHarness(t, 1)
	h.runner.setAuto()
	h.create(pushRun("s1", sha1, "main"), job("a"))
	h.create(pushRun("o1", sha2, "other"), job("a"))

	wantSuperseded(t, h.submit(h.create(pushRun("s2", sha3, "main"), job("a"))), "s1")
	h.idle()

	h.wantRun("s1", store.RunSuperseded, "superseded by "+sha3[:7])
	h.wantRun("o1", store.RunQueued, "")
	h.wantRun("s2", store.RunSuccess, "")
}

func TestHeldRunNotSuperseded(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("blocker", sha1, "other"), indep(1)...))
	h.runner.waitStarted(t, "blocker:setup")

	h.submit(h.create(pushRun("s1", sha2, "main"), job("a")))
	wantSuperseded(t, h.submit(h.create(pushRun("s2", sha3, "main"), job("a"))))

	h.runner.releaseN(t, 6)
	h.idle()
	for _, id := range []string{"blocker", "s1", "s2"} {
		h.wantRun(id, store.RunSuccess, "")
	}
}

func TestSameSHANotSuperseded(t *testing.T) {
	h := newHarness(t, 1)
	h.runner.setAuto()
	h.create(pushRun("r1", sha2, "main"), job("a"))
	retry := pushRun("r2", sha2, "main")
	retry.Attempt = 2

	wantSuperseded(t, h.submit(h.create(retry, job("a"))))
	h.idle()
	h.wantRun("r1", store.RunQueued, "")
	h.wantRun("r2", store.RunSuccess, "")
}

func TestDeployOtherEnvNotSuperseded(t *testing.T) {
	h := newHarness(t, 1)
	h.runner.setAuto()
	h.create(deployRun("staging", sha2, "staging"), job("deploy"))

	wantSuperseded(t, h.submit(h.create(deployRun("prod", sha3, "production"), job("deploy"))))
	h.idle()
	h.wantRun("staging", store.RunQueued, "")
	h.wantRun("prod", store.RunSuccess, "")
}
