package hubclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const validInfo = `{"name":"hookci-hub","version":"1.4.0","mode":"self_hosted","protocol_versions":[1,2],"github_app":{"slug":"acme-ci"},"slack":{"enabled":true}}`

func infoServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/info" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchInfoParsesHub(t *testing.T) {
	srv := infoServer(t, http.StatusOK, validInfo)
	got, err := FetchInfo(context.Background(), srv.Client(), srv.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	var want HubInfo
	want.Name, want.Version, want.Mode, want.ProtocolVersions = "hookci-hub", "1.4.0", "self_hosted", []int{1, 2}
	want.GithubApp.Slug = "acme-ci"
	want.Slack.Enabled = true
	if !reflect.DeepEqual(got, want) {
		t.Errorf("FetchInfo = %+v, want %+v", got, want)
	}
}

func TestFetchInfoErrors(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		notAHub bool
		want    string
	}{
		{"other name", http.StatusOK, `{"name":"gitea","version":"1.0"}`, true, "not a hookci hub"},
		{"not json", http.StatusOK, `<html>hello</html>`, true, "not a hookci hub"},
		{"404", http.StatusNotFound, `{"error":"not_found"}`, false, "HTTP 404"},
		{"500", http.StatusInternalServerError, validInfo, false, "HTTP 500"},
		{"bad protocol range", http.StatusOK, `{"name":"hookci-hub","protocol_versions":[2,1]}`, false, "protocol_versions"},
		{"no protocol range", http.StatusOK, `{"name":"hookci-hub"}`, false, "protocol_versions"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := infoServer(t, tc.status, tc.body)
			_, err := FetchInfo(context.Background(), srv.Client(), srv.URL)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("FetchInfo err = %v, want it to contain %q", err, tc.want)
			}
			if errors.Is(err, ErrNotAHub) != tc.notAHub {
				t.Errorf("errors.Is(err, ErrNotAHub) = %v, want %v", !tc.notAHub, tc.notAHub)
			}
		})
	}
}

func TestFetchInfoUnreachable(t *testing.T) {
	srv := infoServer(t, http.StatusOK, validInfo)
	url := srv.URL
	srv.Close()
	if _, err := FetchInfo(context.Background(), http.DefaultClient, url); err == nil {
		t.Fatal("FetchInfo against a closed server returned no error")
	}
}
