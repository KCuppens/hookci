package cli

import (
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
)

// stateDirFlags are the --state-dir and --installation flags of a command
// that works on one agent's state directory.
type stateDirFlags struct {
	dir          *string
	installation *int64
	root         string
}

// addStateDirFlags defines --state-dir, defaulting to the global state dir,
// and --installation on fs.
func addStateDirFlags(fs *flag.FlagSet, d Deps) stateDirFlags {
	return stateDirFlags{
		dir:          fs.String("state-dir", d.Globals.StateDir, "agent state directory, as given to zeroci connect"),
		installation: fs.Int64("installation", 0, "use the agent of this installation in "+d.StateRoot+"/<ID>, as the zeroci-agent@ unit does"),
		root:         d.StateRoot,
	}
}

// resolve returns the state dir the parsed flags pick: <StateRoot>/<ID> for
// --installation, else --state-dir. A negative installation id is reported
// on stderr and gives false.
func (f stateDirFlags) resolve(stderr io.Writer) (string, bool) {
	switch {
	case *f.installation < 0:
		fmt.Fprintln(stderr, "zeroci: --installation must be a positive installation id")
		return "", false
	case *f.installation > 0:
		return filepath.Join(f.root, strconv.FormatInt(*f.installation, 10)), true
	}
	return *f.dir, true
}
