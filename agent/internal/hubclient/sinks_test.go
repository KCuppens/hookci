package hubclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const sinkCred = "hci_agent_sinksinksinksink"

// sinkCall is one request the fake hub saw.
type sinkCall struct {
	method, uri, body, auth, contentType string
}

// sinkHub answers every request with status and body and records it.
func sinkHub(t *testing.T, status int, body string) (*Client, *sinkCall) {
	t.Helper()
	var got sinkCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = sinkCall{r.Method, r.URL.RequestURI(), string(b), r.Header.Get("Authorization"), r.Header.Get("Content-Type")}
		if body != "" {
			w.Header().Set("Content-Type", "application/json")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return New(Config{HubURL: srv.URL + "/", AgentID: "agt_1", Credential: sinkCred, Version: "v1.2.3"}, nil, nil, nil), &got
}

func checkCall(t *testing.T, got *sinkCall, method, uri, body string) {
	t.Helper()
	if got.method != method || got.uri != uri || got.body != body {
		t.Errorf("request = %s %s %q, want %s %s %q", got.method, got.uri, got.body, method, uri, body)
	}
	if got.auth != "Bearer "+sinkCred {
		t.Errorf("Authorization = %q, want the agent credential", got.auth)
	}
	if body != "" && got.contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got.contentType)
	}
}

const sinkJSON = `{"id":"snk_1","kind":"webhook","repo":"acme/web","label":null,"target":"https://hooks.example.com/hookci","created_at":"2026-01-02T03:04:05.000Z","disabled_at":null,"last_error":null}`

func TestListSinks(t *testing.T) {
	c, got := sinkHub(t, http.StatusOK, `{"sinks":[`+sinkJSON+`]}`)

	sinks, err := c.ListSinks(context.Background(), "acme/web")

	if err != nil {
		t.Fatal(err)
	}
	checkCall(t, got, http.MethodGet, "/v1/agent/sinks?repo=acme%2Fweb", "")
	if len(sinks) != 1 || sinks[0].ID != "snk_1" || sinks[0].Target.String() != "https://hooks.example.com/hookci" || sinks[0].Label != nil || sinks[0].DisabledAt != nil {
		t.Errorf("sinks = %+v, want snk_1", sinks)
	}
}

func TestListSinksEmptyIsNotNil(t *testing.T) {
	c, _ := sinkHub(t, http.StatusOK, `{"sinks":[]}`)

	sinks, err := c.ListSinks(context.Background(), "acme/web")

	if err != nil || sinks == nil || len(sinks) != 0 {
		t.Errorf("ListSinks = %#v, %v; want an empty non-nil slice", sinks, err)
	}
}

func TestAddSinkTelegram(t *testing.T) {
	c, got := sinkHub(t, http.StatusCreated, `{"sink":{"id":"snk_2","kind":"telegram","repo":"acme/web","label":"ops","target":"chat -100","created_at":"x","disabled_at":null,"last_error":null}}`)

	res, err := c.AddSink(context.Background(), AddSinkRequest{Kind: "telegram", Repo: "acme/web", BotToken: "123:abc", ChatID: "-100", Label: "ops"})

	if err != nil {
		t.Fatal(err)
	}
	checkCall(t, got, http.MethodPost, "/v1/agent/sinks", `{"kind":"telegram","repo":"acme/web","bot_token":"123:abc","chat_id":"-100","label":"ops"}`)
	if res.Sink.ID != "snk_2" || res.Sink.Label == nil || *res.Sink.Label != "ops" || res.GeneratedSecret != "" {
		t.Errorf("AddSink = %+v, want snk_2 labelled ops without a secret", res)
	}
}

func TestAddSinkWebhook(t *testing.T) {
	c, got := sinkHub(t, http.StatusCreated, `{"sink":`+sinkJSON+`,"generated_secret":"whsec_abc"}`)

	res, err := c.AddSink(context.Background(), AddSinkRequest{Kind: "webhook", Repo: "acme/web", URL: "https://hooks.example.com/hookci"})

	if err != nil {
		t.Fatal(err)
	}
	checkCall(t, got, http.MethodPost, "/v1/agent/sinks", `{"kind":"webhook","repo":"acme/web","url":"https://hooks.example.com/hookci"}`)
	if res.Sink.ID != "snk_1" || res.GeneratedSecret != "whsec_abc" {
		t.Errorf("AddSink = %+v, want snk_1 with secret whsec_abc", res)
	}
}

func TestAddSinkLinear(t *testing.T) {
	c, got := sinkHub(t, http.StatusCreated, `{"sink":{"id":"snk_3","kind":"linear","repo":"acme/web","label":null,"target":{"teamKey":"ENG","assigneeName":"Dana"},"created_at":"x","disabled_at":null,"last_error":null}}`)

	res, err := c.AddSink(context.Background(), AddSinkRequest{Kind: "linear", Repo: "acme/web", LinearAPIKey: "lin_api_abc", TeamKey: "ENG", AssigneeEmail: "dana@acme.test"})

	if err != nil {
		t.Fatal(err)
	}
	checkCall(t, got, http.MethodPost, "/v1/agent/sinks", `{"kind":"linear","repo":"acme/web","api_key":"lin_api_abc","team_key":"ENG","assignee_email":"dana@acme.test"}`)
	if strings.Contains(got.body, "bot_token") || strings.Contains(got.body, "chat_id") {
		t.Errorf("body %q has Telegram fields", got.body)
	}
	if res.Sink.Target != (SinkTarget{TeamKey: "ENG", AssigneeName: "Dana"}) || res.Sink.Target.String() != "team=ENG assignee=Dana" {
		t.Errorf("Target = %+v (%s), want team ENG assigned to Dana", res.Sink.Target, res.Sink.Target)
	}
}

func TestSinkTargetJSONRoundTrip(t *testing.T) {
	for _, in := range []string{`"chat -100"`, `{"teamKey":"ENG"}`, `{"teamKey":"ENG","assigneeName":"Dana"}`} {
		var target SinkTarget
		if err := json.Unmarshal([]byte(in), &target); err != nil {
			t.Fatalf("Unmarshal(%s): %v", in, err)
		}
		out, err := json.Marshal(target)
		if err != nil || string(out) != in {
			t.Errorf("round trip of %s = %s, %v", in, out, err)
		}
	}
	var target SinkTarget
	if err := json.Unmarshal([]byte(`{"teamKey":"ENG"}`), &target); err != nil || target.String() != "team=ENG" {
		t.Errorf("String() = %q, %v; want team=ENG", target.String(), err)
	}
}

func TestRemoveSink(t *testing.T) {
	c, got := sinkHub(t, http.StatusNoContent, "")

	if err := c.RemoveSink(context.Background(), "snk_1"); err != nil {
		t.Fatal(err)
	}
	checkCall(t, got, http.MethodDelete, "/v1/agent/sinks/snk_1", "")
}

func TestTestSink(t *testing.T) {
	tests := []struct{ body, want string }{
		{`{"result":"ok"}`, "ok"},
		{`{"result":"fail","detail":"http_404"}`, "fail (http_404)"},
	}
	for _, tc := range tests {
		c, got := sinkHub(t, http.StatusOK, tc.body)

		res, err := c.TestSink(context.Background(), "snk_1")

		if err != nil {
			t.Fatal(err)
		}
		checkCall(t, got, http.MethodPost, "/v1/agent/sinks/snk_1/test", "")
		if res != tc.want {
			t.Errorf("TestSink on %s = %q, want %q", tc.body, res, tc.want)
		}
	}
}

func TestSinkRepoNotBound(t *testing.T) {
	c, _ := sinkHub(t, http.StatusForbidden, `{"error":"repo_not_bound"}`)

	_, err := c.ListSinks(context.Background(), "acme/web")

	if !errors.Is(err, ErrRepoNotBound) {
		t.Errorf("err = %v, want ErrRepoNotBound", err)
	}
}

func TestSinkAPIError(t *testing.T) {
	tests := []struct {
		status int
		body   string
		want   APIError
	}{
		{http.StatusBadRequest, `{"error":"invalid","message":"chat_id: must be a number"}`, APIError{http.StatusBadRequest, "invalid", "chat_id: must be a number"}},
		{http.StatusForbidden, `{"error":"suspended"}`, APIError{Status: http.StatusForbidden, Code: "suspended"}},
		{http.StatusNotFound, `{"error":"not_found"}`, APIError{Status: http.StatusNotFound, Code: "not_found"}},
		{http.StatusBadGateway, `bad gateway`, APIError{Status: http.StatusBadGateway}},
	}
	for _, tc := range tests {
		c, _ := sinkHub(t, tc.status, tc.body)

		err := c.RemoveSink(context.Background(), "snk_1")

		var apiErr *APIError
		if !errors.As(err, &apiErr) || *apiErr != tc.want {
			t.Errorf("HTTP %d %s: err = %#v, want %+v", tc.status, tc.body, err, tc.want)
		}
		if errors.Is(err, ErrRepoNotBound) {
			t.Errorf("HTTP %d %s: err matches ErrRepoNotBound", tc.status, tc.body)
		}
	}
}
