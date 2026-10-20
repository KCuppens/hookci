package protocol_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/protocol"
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
	_ = protocol.LogUnsubscribe{}
	_ = protocol.Log{}
	_ = protocol.Ack{}
	_ = protocol.Welcome{}
	_ = protocol.Interrupt{}
	_ = protocol.Error{}
)

// fixture reads a frame from schema/testdata/protocol, the fixtures the
// schema's ajv tests validate.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "schema", "testdata", "protocol", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func decode[T any](t *testing.T, frame []byte) T {
	t.Helper()
	msg, err := protocol.DecodeFrame(frame)
	if err != nil {
		t.Fatalf("DecodeFrame(%s): %v", frame, err)
	}
	out, ok := msg.(T)
	if !ok {
		t.Fatalf("DecodeFrame(%s) = %T; want %T", frame, msg, out)
	}
	return out
}

func TestDecodeWelcome(t *testing.T) {
	got := decode[protocol.Welcome](t, fixture(t, "valid-welcome.json"))
	want := protocol.Welcome{
		V:              protocol.Version,
		Type:           "welcome",
		HubVersion:     "1.4.0",
		ProtocolMin:    1,
		ProtocolMax:    1,
		AgentId:        "agt_01j9zq8m4k2v7c3x5b6n0p1r2s",
		InstallationId: 4242,
	}
	if got != want {
		t.Errorf("welcome = %+v; want %+v", got, want)
	}
	if _, err := protocol.DecodeFrame(fixture(t, "invalid-welcome.json")); err == nil || !strings.Contains(err.Error(), "installation_id") {
		t.Errorf("DecodeFrame(welcome without installation_id) err = %v; want one naming installation_id", err)
	}
}

func TestDecodeInterrupt(t *testing.T) {
	run := decode[protocol.Interrupt](t, fixture(t, "valid-interrupt-run.json"))
	if run.RunId == nil || *run.RunId != "01j9zq8m4k2v7c3x5b6n0p1r2s" || run.TriggerId != nil || run.Reason != protocol.InterruptReasonSuperseded {
		t.Errorf("run interrupt = %+v", run)
	}
	trig := decode[protocol.Interrupt](t, fixture(t, "valid-interrupt-trigger.json"))
	if trig.TriggerId == nil || *trig.TriggerId != "trg_01" || trig.RunId != nil || trig.Reason != protocol.InterruptReasonRevoked {
		t.Errorf("trigger interrupt = %+v", trig)
	}
}

func TestDecodeInterruptRejectsBothIDs(t *testing.T) {
	for _, name := range []string{"invalid-interrupt-both-ids.json", "invalid-interrupt-no-id.json"} {
		msg, err := protocol.DecodeFrame(fixture(t, name))
		if err == nil || !strings.Contains(err.Error(), "exactly one of run_id or trigger_id") {
			t.Errorf("DecodeFrame(%s) = %+v, %v; want exactly-one error", name, msg, err)
		}
	}
}

func TestDecodeError(t *testing.T) {
	got := decode[protocol.Error](t, fixture(t, "valid-error.json"))
	if got.Code != protocol.ErrorCodeProtocolUnsupported || got.Message == "" || got.UpgradeHint == nil || *got.UpgradeHint != "run hookci upgrade" {
		t.Errorf("error frame = %+v", got)
	}
	if _, err := protocol.DecodeFrame([]byte(`{"v":1,"type":"error","code":"internal"}`)); err == nil || !strings.Contains(err.Error(), "message") {
		t.Errorf("DecodeFrame(error without message) err = %v; want one naming message", err)
	}
}

func TestDecodeSeqFields(t *testing.T) {
	hello := decode[protocol.Hello](t, fixture(t, "valid-hello-inbound-hwm.json"))
	if hello.InboundHwm == nil || *hello.InboundHwm != 7 {
		t.Errorf("hello inbound_hwm = %v; want 7", hello.InboundHwm)
	}
	interrupt := decode[protocol.Interrupt](t, fixture(t, "valid-interrupt-seq.json"))
	if interrupt.Seq == nil || *interrupt.Seq != 3 {
		t.Errorf("interrupt seq = %v; want 3", interrupt.Seq)
	}
	event := decode[protocol.Event](t, fixture(t, "valid-event-seq.json"))
	if event.Seq == nil || *event.Seq != 12 {
		t.Errorf("event seq = %v; want 12", event.Seq)
	}
}

func TestDecodeLogTailFrames(t *testing.T) {
	sub := decode[protocol.LogSubscribe](t, fixture(t, "valid-log-subscribe.json"))
	if want := (protocol.LogSubscribe{V: protocol.Version, Type: "log_subscribe", RunId: "01JRUN", Job: "test", Offset: 4096}); sub != want {
		t.Errorf("log_subscribe = %+v; want %+v", sub, want)
	}
	unsub := decode[protocol.LogUnsubscribe](t, fixture(t, "valid-log-unsubscribe.json"))
	if want := (protocol.LogUnsubscribe{V: protocol.Version, Type: "log_unsubscribe", RunId: "01JRUN", Job: "test"}); unsub != want {
		t.Errorf("log_unsubscribe = %+v; want %+v", unsub, want)
	}
	eof := decode[protocol.Log](t, fixture(t, "valid-log-eof.json"))
	if want := (protocol.Log{V: protocol.Version, Type: "log", RunId: "01JRUN", Job: "test", Offset: 4096, Eof: true}); eof != want {
		t.Errorf("log eof = %+v; want %+v", eof, want)
	}
	if _, err := protocol.DecodeFrame(fixture(t, "invalid-log-no-eof.json")); err == nil || !strings.Contains(err.Error(), "eof") {
		t.Errorf("DecodeFrame(log without eof) err = %v; want one naming eof", err)
	}
}

func TestDecodeFrameRejectsUnknownTypeAndVersion(t *testing.T) {
	for _, frame := range []string{
		`{"v":1,"type":"nope"}`,
		`{"v":2,"type":"ack","upto":1}`,
		`{"v":1,"type":"ack","upto":"x"}`,
	} {
		if msg, err := protocol.DecodeFrame([]byte(frame)); err == nil {
			t.Errorf("DecodeFrame(%s) = %+v; want error", frame, msg)
		}
	}
}

// TestDecodeFrameRequiresSchemaFields checks DecodeFrame against the required
// list of every message in $defs.protocol: a frame with all of them decodes,
// and dropping any one is rejected with an error naming it.
func TestDecodeFrameRequiresSchemaFields(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "schema", "hookci.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs struct {
			Protocol struct {
				Defs map[string]struct {
					Required   []string `json:"required"`
					Properties struct {
						Type struct {
							Const string `json:"const"`
						} `json:"type"`
					} `json:"properties"`
				} `json:"$defs"`
			} `json:"protocol"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	messages := 0
	for name, def := range schema.Defs.Protocol.Defs {
		typ := def.Properties.Type.Const
		if typ == "" {
			continue
		}
		messages++
		// null decodes into any Go field, so these frames test key presence only.
		frame := func(skip string) []byte {
			fields := map[string]any{"v": protocol.Version, "type": typ}
			if typ == "interrupt" {
				fields["run_id"] = nil
			}
			for _, k := range def.Required {
				if k != "v" && k != "type" && k != skip {
					fields[k] = nil
				}
			}
			b, err := json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			return b
		}
		if _, err := protocol.DecodeFrame(frame("")); err != nil {
			t.Errorf("%s: DecodeFrame with every required field: %v", name, err)
		}
		for _, k := range def.Required {
			if k == "v" || k == "type" {
				continue
			}
			if _, err := protocol.DecodeFrame(frame(k)); err == nil || !strings.Contains(err.Error(), k) {
				t.Errorf("%s: DecodeFrame without %s err = %v; want one naming %s", name, k, err, k)
			}
		}
	}
	if messages != 16 {
		t.Errorf("schema has %d protocol messages; want 16", messages)
	}
}

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
