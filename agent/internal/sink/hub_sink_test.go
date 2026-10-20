package sink

import (
	"context"
	"fmt"
	"testing"

	"github.com/KCuppens/hookci/agent/internal/hubclient"
	"github.com/KCuppens/hookci/agent/internal/protocol"
	"github.com/KCuppens/hookci/agent/internal/store"
)

func TestHubSinkSplitsAnnotations(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	h := NewHub(hubclient.New(hubclient.Config{}, st, nil, nil), "run-1")
	items := make([]protocol.AnnotationsItemsElem, 120)
	for i := range items {
		items[i] = protocol.AnnotationsItemsElem{Path: ".hookci.yml", Line: i + 1, Level: protocol.AnnotationsItemsElemLevelFailure, Message: fmt.Sprint("problem ", i)}
	}
	if err := h.Annotations(ctx, "_config", items); err != nil {
		t.Fatal(err)
	}

	pending, err := st.Pending(ctx, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	var sizes []int
	next := 0
	for _, it := range pending {
		if it.Kind != store.KindAnnotations {
			t.Fatalf("outbox kind %q, want annotations", it.Kind)
		}
		var a protocol.Annotations
		if err := protocol.Unmarshal(it.Payload, &a); err != nil {
			t.Fatal(err)
		}
		if a.RunId != "run-1" || a.Job != "_config" || a.Total == nil || *a.Total != 120 || int64(a.AgentSeq) != it.Seq {
			t.Errorf("frame = run %q job %q total %v agent_seq %d (outbox seq %d)", a.RunId, a.Job, a.Total, a.AgentSeq, it.Seq)
		}
		for _, item := range a.Items {
			if item.Line != next+1 {
				t.Fatalf("item line %d, want %d: items out of order", item.Line, next+1)
			}
			next++
		}
		sizes = append(sizes, len(a.Items))
	}
	if fmt.Sprint(sizes) != "[50 50 20]" {
		t.Errorf("frame sizes = %v, want [50 50 20]", sizes)
	}
}
