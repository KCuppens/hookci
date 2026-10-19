package testutil

import (
	"os"
	"testing"
)

func TestRequireIntegrationSkipsByDefault(t *testing.T) {
	if os.Getenv("ZEROCI_INTEGRATION") == "1" {
		t.Skip("ZEROCI_INTEGRATION=1 set in environment; cannot verify default-skip behavior")
	}

	var ran bool
	t.Run("sub", func(t *testing.T) {
		RequireIntegration(t)
		ran = true
	})

	if ran {
		t.Error("RequireIntegration did not skip when ZEROCI_INTEGRATION is unset")
	}
}
