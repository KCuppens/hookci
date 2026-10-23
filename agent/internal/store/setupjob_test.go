package store

import (
	"context"
	"reflect"
	"testing"
)

func TestWithSetup(t *testing.T) {
	in := []Job{{Name: "lint"}, {Name: "build"}, {Name: "test", Needs: []string{"build"}}}
	got := WithSetup(in)

	var names []string
	needs := map[string][]string{}
	for _, j := range got {
		names = append(names, j.Name)
		needs[j.Name] = j.Needs
	}
	if want := []string{SetupJob, "lint", "build", "test"}; !reflect.DeepEqual(names, want) {
		t.Fatalf("names = %q, want %q (setup first)", names, want)
	}
	for name, want := range map[string][]string{
		SetupJob: nil,
		"lint":   {SetupJob},
		"build":  {SetupJob},
		"test":   {"build"}, // reaches setup through build
	} {
		if !reflect.DeepEqual(needs[name], want) {
			t.Errorf("needs of %s = %q, want %q", name, needs[name], want)
		}
	}
	if len(in[0].Needs) != 0 || len(in) != 3 {
		t.Errorf("WithSetup modified its input: %+v", in)
	}
}

func TestSetupJobStoredFirstWithNeeds(t *testing.T) {
	s := openTestStore(t)
	mustCreateRun(t, s, testRun("r1"), WithSetup([]Job{{Name: "lint"}})...)

	jobs, err := s.Jobs(context.Background(), "r1")
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 2 || jobs[0].Name != SetupJob || jobs[0].State != JobQueued {
		t.Fatalf("jobs = %+v, want queued setup first", jobs)
	}
	if !reflect.DeepEqual(jobs[1].Needs, []string{SetupJob}) {
		t.Errorf("lint needs = %q, want [setup]", jobs[1].Needs)
	}
}
