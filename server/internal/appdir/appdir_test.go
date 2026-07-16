package appdir

import (
	"path/filepath"
	"testing"
)

func TestDefaultDataDirIsUserScoped(t *testing.T) {
	dir := DefaultDataDir()
	if dir == "" || filepath.Base(dir) != "data" {
		t.Fatalf("default data directory = %q", dir)
	}
	if filepath.Base(filepath.Dir(dir)) != "OpenBoard" && filepath.Base(filepath.Dir(dir)) != ".openboard" {
		t.Fatalf("default data directory is not app-scoped: %q", dir)
	}
}
