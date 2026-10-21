package testutil

import (
	"os"
	"testing"
)

func TestRequireIntegrationSkipsByDefault(t *testing.T) {
	if os.Getenv("HOOKCI_INTEGRATION") == "1" {
		t.Skip("HOOKCI_INTEGRATION=1 set in environment; cannot verify default-skip behavior")
	}

	var ran bool
	t.Run("sub", func(t *testing.T) {
		RequireIntegration(t)
		ran = true
	})

	if ran {
		t.Error("RequireIntegration did not skip when HOOKCI_INTEGRATION is unset")
	}
}
