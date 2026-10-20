// Package agentconf reads and writes agent.json, the paired agent's identity
// and hub credential.
package agentconf

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/KCuppens/zerocideploy/agent/internal/config"
)

// FileName is the config file name inside the agent state directory.
const FileName = "agent.json"

// AgentConfig is the content of agent.json: the agent's identity and the
// host settings of the agent config schema (gc limits).
type AgentConfig struct {
	HubURL         string `json:"hub_url"`
	AgentID        string `json:"agent_id"`
	Credential     string `json:"credential"`
	Name           string `json:"name"`
	InstallationID int64  `json:"installation_id"`
	config.AgentConfig
}

// Load reads dir/agent.json. It refuses a file readable or writable by group
// or others, because the file holds the agent credential. A missing file
// returns an error matching fs.ErrNotExist.
func Load(dir string) (*AgentConfig, error) {
	path := filepath.Join(dir, FileName)
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("agentconf: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, fmt.Errorf("agentconf: %w", err)
	}
	if perm := fi.Mode().Perm(); perm&0o077 != 0 {
		return nil, fmt.Errorf("agentconf: %s has mode %04o, which exposes the agent credential; run: chmod 600 %s", path, perm, path)
	}
	c := &AgentConfig{}
	if err := json.NewDecoder(f).Decode(c); err != nil {
		return nil, fmt.Errorf("agentconf: %s: %w", path, err)
	}
	return c, nil
}

// Save writes dir/agent.json with mode 0600. It writes a temp file and
// renames it, so a crash never leaves a half-written config.
func Save(dir string, c *AgentConfig) (err error) {
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	b = append(b, '\n')
	f, err := os.CreateTemp(dir, FileName+".tmp-*")
	if err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	if _, err := f.Write(b); err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, FileName)); err != nil {
		return fmt.Errorf("agentconf: %w", err)
	}
	return nil
}
