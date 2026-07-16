package appdir

import (
	"os"
	"path/filepath"
)

// DefaultDataDir returns a user-scoped location for persistent local data.
// Deployments should set OPENBOARD_DATA explicitly (the container uses /data).
func DefaultDataDir() string {
	if root, err := os.UserConfigDir(); err == nil && root != "" {
		return filepath.Join(root, "OpenBoard", "data")
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Join(home, ".openboard", "data")
	}
	return filepath.Join(".", ".openboard", "data")
}
