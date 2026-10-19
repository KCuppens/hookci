package netns

import "strconv"

// InNSProxyPort is the fixed port jobs use inside the namespace. pasta
// forwards 127.0.0.1:InNSProxyPort in the namespace to the run's egress
// proxy on the host.
const InNSProxyPort = 3128

// ProxyEnv returns the proxy variables that point jobs at
// http://127.0.0.1:<port>, in a fixed order. Loopback is exempt so local
// services in the namespace are not proxied.
func ProxyEnv(port int) []string {
	url := "http://127.0.0.1:" + strconv.Itoa(port)
	return []string{
		"HTTP_PROXY=" + url,
		"HTTPS_PROXY=" + url,
		"http_proxy=" + url,
		"https_proxy=" + url,
		"npm_config_proxy=" + url,
		"npm_config_https_proxy=" + url,
		"CARGO_HTTP_PROXY=" + url,
		"NO_PROXY=localhost,127.0.0.1",
		"no_proxy=localhost,127.0.0.1",
	}
}
