package isolation

import "testing"

func TestUnitNameSanitizes(t *testing.T) {
	if got, want := UnitName("01HX", "lint/ts x"), "zeroci-run-01HX-lint_ts_x"; got != want {
		t.Errorf("UnitName = %q, want %q", got, want)
	}
	if got, want := UnitName("01HX", "setup"), "zeroci-run-01HX-setup"; got != want {
		t.Errorf("setup UnitName = %q, want %q", got, want)
	}
	if got, want := SanitizeUnitPart("a:b_c.d-E9/é$"), "a:b_c.d-E9____"; got != want {
		t.Errorf("SanitizeUnitPart = %q, want %q", got, want)
	}
}
