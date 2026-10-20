package isolation

import (
	"os/user"
	"strconv"
	"strings"
	"testing"
)

func TestJobCredentialNoneIsAgentUser(t *testing.T) {
	cred, err := JobCredential(&None{})
	if err != nil || cred != nil {
		t.Fatalf("JobCredential(none) = %+v, %v; want nil, nil", cred, err)
	}
}

func TestJobCredentialSystemdIsDefaultUser(t *testing.T) {
	cred, err := JobCredential(&Systemd{})
	if err != nil {
		if !strings.Contains(err.Error(), DefaultUser) {
			t.Fatalf("err = %v, want it to name %s", err, DefaultUser)
		}
		return
	}
	u, err := user.Lookup(DefaultUser)
	if err != nil {
		t.Fatal(err)
	}
	if strconv.FormatUint(uint64(cred.Uid), 10) != u.Uid || strconv.FormatUint(uint64(cred.Gid), 10) != u.Gid {
		t.Errorf("cred = %+v, want %s uid %s gid %s", cred, DefaultUser, u.Uid, u.Gid)
	}
}

func TestLookupCredential(t *testing.T) {
	me, err := user.Current()
	if err != nil {
		t.Skip(err)
	}
	cred, err := LookupCredential(me.Username)
	if err != nil {
		t.Fatal(err)
	}
	if strconv.FormatUint(uint64(cred.Uid), 10) != me.Uid || strconv.FormatUint(uint64(cred.Gid), 10) != me.Gid {
		t.Errorf("LookupCredential(%s) = %+v, want uid %s gid %s", me.Username, cred, me.Uid, me.Gid)
	}
	if _, err := LookupCredential("hookci-no-such-user"); err == nil {
		t.Error("LookupCredential of a missing user succeeded")
	}
}
