package protocol_test

import (
	"reflect"
	"strings"
	"testing"

	"github.com/KCuppens/zerocideploy/agent/internal/protocol"
)

// Every message defined in $defs.protocol must be generated.
var (
	_ = protocol.Envelope{}
	_ = protocol.Hello{}
	_ = protocol.Trigger{}
	_ = protocol.Accepted{}
	_ = protocol.Rejected{}
	_ = protocol.JobPlanned{}
	_ = protocol.Event{}
	_ = protocol.Annotations{}
	_ = protocol.TokenRequest{}
	_ = protocol.Token{}
	_ = protocol.LogSubscribe{}
	_ = protocol.Log{}
	_ = protocol.Ack{}
)

func TestMarshalInjectsEnvelope(t *testing.T) {
	frame, err := protocol.Marshal("hello", protocol.Hello{ProtocolVersion: 1, AgentVersion: "0.1.0"})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, want := range []string{`"v":1`, `"type":"hello"`, `"agent_version":"0.1.0"`} {
		if !strings.Contains(string(frame), want) {
			t.Errorf("frame %s lacks %s", frame, want)
		}
	}
	typ, err := protocol.PeekType(frame)
	if err != nil || typ != "hello" {
		t.Errorf("PeekType = %q, %v; want hello, nil", typ, err)
	}
}

func TestPeekTypeRejectsWrongVersion(t *testing.T) {
	if _, err := protocol.PeekType([]byte(`{"v":2,"type":"hello"}`)); err == nil {
		t.Fatal("PeekType accepted v=2")
	}
	var h protocol.Hello
	if err := protocol.Unmarshal([]byte(`{"v":2,"type":"hello","protocol_version":1,"agent_version":"x"}`), &h); err == nil {
		t.Fatal("Unmarshal accepted v=2")
	}
}

func TestRoundTripTrigger(t *testing.T) {
	base := "1111111111111111111111111111111111111111"
	in := protocol.Trigger{
		V:         protocol.Version,
		Type:      "trigger",
		HubSeq:    7,
		TriggerId: "trg_1",
		Repo:      "acme/web",
		Sha:       "0123456789abcdef0123456789abcdef01234567",
		Ref:       "refs/pull/12/head",
		Event:     protocol.TriggerEventPullRequest,
		Pr: &protocol.TriggerPr{
			Number:           12,
			HeadRef:          "feature",
			HeadRepoFullName: "fork/web",
			Fork:             true,
		},
		BaseSha: &base,
		Attempt: 1,
		Trust:   protocol.TriggerTrustUntrusted,
	}
	frame, err := protocol.Marshal("trigger", in)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var out protocol.Trigger
	if err := protocol.Unmarshal(frame, &out); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(in, out) {
		t.Errorf("round trip mismatch:\n in  %+v\n out %+v", in, out)
	}
}
