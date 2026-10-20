package netns

import (
	"slices"
	"testing"
)

func TestProxyEnv(t *testing.T) {
	want := []string{
		"HTTP_PROXY=http://127.0.0.1:3128",
		"HTTPS_PROXY=http://127.0.0.1:3128",
		"http_proxy=http://127.0.0.1:3128",
		"https_proxy=http://127.0.0.1:3128",
		"npm_config_proxy=http://127.0.0.1:3128",
		"npm_config_https_proxy=http://127.0.0.1:3128",
		"CARGO_HTTP_PROXY=http://127.0.0.1:3128",
		"NO_PROXY=localhost,127.0.0.1",
		"no_proxy=localhost,127.0.0.1",
	}
	if got := ProxyEnv(InNSProxyPort); !slices.Equal(got, want) {
		t.Errorf("ProxyEnv(3128) =\n%q\nwant\n%q", got, want)
	}
}
