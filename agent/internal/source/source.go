package source

import "context"

// Checkout contains information about the checked-out workspace.
type Checkout struct {
	Dir    string `json:"dir"`
	Commit string `json:"commit"`
}

// Source abstracts the retrieval and preparation of a workspace checkout for a run.
type Source interface {
	Prepare(ctx context.Context, targetDir string) (*Checkout, error)
}
