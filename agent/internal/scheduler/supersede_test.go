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

func TestNewerQueuedDeployReplacesOlder(t *testing.T) {
	h := newHarness(t, 4)
	h.submit(h.create(deployRun("A", sha1, "production"), job("deploy")))
	h.runner.waitStarted(t, "A:setup")

	wantSuperseded(t, h.submit(h.create(deployRun("B", sha2, "production"), job("deploy"))))
	wantSuperseded(t, h.submit(h.create(deployRun("C", sha3, "production"), job("deploy"))), "B")
	h.wantRun("B", store.RunSuperseded, "superseded by "+sha3[:7])
	h.wantJob("B", "deploy", store.JobSkipped, "superseded by "+sha3[:7])

	h.runner.release(t, "A:setup")
	h.runner.release(t, "A:deploy")
	h.runner.release(t, "C:setup")
	h.runner.release(t, "C:deploy")
	h.idle()

	h.wantRun("A", store.RunSuccess, "")
	h.wantRun("C", store.RunSuccess, "")
	wantStarts(t, h.runner, "A:setup", "A:deploy", "C:setup", "C:deploy")
	if got := h.runner.Finishes("B"); len(got) != 0 {
		t.Errorf("FinishRun called for superseded B: %v", got)
	}
}

func TestPRSupersedeCancelsRunning(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(prRun("p1", sha1, 7), job("a"), job("b", "a")))
	h.runner.release(t, "p1:setup")
	h.runner.waitStarted(t, "p1:a")

	wantSuperseded(t, h.submit(h.create(prRun("p2", sha2, 7), job("a"), job("b", "a"))), "p1")

	reason := "superseded by " + sha2[:7]
	if st := h.wait("p1"); st != store.RunFailed {
		t.Fatalf("p1 = %s, want failed", st)
	}
	h.wantRun("p1", store.RunFailed, reason)
	h.wantJob("p1", "a", store.JobCancelled, reason)
	h.wantJob("p1", "b", store.JobSkipped, reason)

	h.runner.releaseN(t, 3)
	if st := h.wait("p2"); st != store.RunSuccess {
		t.Fatalf("p2 = %s, want success", st)
	}
	wantStarts(t, h.runner, "p1:setup", "p1:a", "p2:setup", "p2:a", "p2:b")
}

func TestPRSupersedeQueued(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("blocker", sha1, "main"), indep(1)...))
	h.runner.waitStarted(t, "blocker:setup")

	// p0 sits queued in the store only, as if left over from a restart.
	h.create(prRun("p0", "0000000ffffffff", 7), job("a"))
	wantSuperseded(t, h.submit(h.create(prRun("p1", sha2, 7), job("a"))), "p0")
	wantSuperseded(t, h.submit(h.create(prRun("p2", sha3, 7), job("a"))), "p1")

	h.wantRun("p0", store.RunSuperseded, "superseded by "+sha2[:7])
	h.wantJob("p0", "a", store.JobSkipped, "superseded by "+sha2[:7])
	h.wantRun("p1", store.RunSuperseded, "superseded by "+sha3[:7])
	h.wantJob("p1", "a", store.JobSkipped, "superseded by "+sha3[:7])
	if st := h.wait("p1"); st != store.RunSuperseded {
		t.Fatalf("Wait(p1) = %s, want superseded", st)
	}

	h.runner.releaseN(t, 4)
	h.idle()
	h.wantRun("p2", store.RunSuccess, "")
	wantStarts(t, h.runner, "blocker:setup", "blocker:j0", "p2:setup", "p2:a")
}

func TestPushSupersedeKeepsRunning(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("s1", sha1, "main"), job("a")))
	h.runner.waitStarted(t, "s1:setup")

	wantSuperseded(t, h.submit(h.create(pushRun("s2", sha2, "main"), job("a"))))
	wantSuperseded(t, h.submit(h.create(pushRun("s3", sha3, "main"), job("a"))), "s2")

	h.runner.releaseN(t, 4)
	h.idle()
	h.wantRun("s1", store.RunSuccess, "")
	h.wantRun("s2", store.RunSuperseded, "superseded by "+sha3[:7])
	h.wantRun("s3", store.RunSuccess, "")
	wantStarts(t, h.runner, "s1:setup", "s1:a", "s3:setup", "s3:a")
}

func TestSameSHANotSuperseded(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("blocker", sha1, "other"), indep(1)...))
	h.runner.waitStarted(t, "blocker:setup")

	h.submit(h.create(pushRun("r1", sha2, "main"), job("a")))
	retry := pushRun("r2", sha2, "main")
	retry.Attempt = 2
	wantSuperseded(t, h.submit(h.create(retry, job("a"))))

	h.runner.releaseN(t, 6)
	h.idle()
	h.wantRun("r1", store.RunSuccess, "")
	h.wantRun("r2", store.RunSuccess, "")
}

func TestDeployOtherEnvNotSuperseded(t *testing.T) {
	h := newHarness(t, 1)
	h.submit(h.create(pushRun("blocker", sha1, "main"), indep(1)...))
	h.runner.waitStarted(t, "blocker:setup")

	h.submit(h.create(deployRun("staging", sha2, "staging"), job("deploy")))
	wantSuperseded(t, h.submit(h.create(deployRun("prod", sha3, "production"), job("deploy"))))

	h.runner.releaseN(t, 6)
	h.idle()
	h.wantRun("staging", store.RunSuccess, "")
	h.wantRun("prod", store.RunSuccess, "")
}
