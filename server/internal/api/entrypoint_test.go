package api

import (
	"os"
	"strings"
	"testing"
)

func TestEntrypointCleansAllFilmRenderTemporaryDirectories(t *testing.T) {
	script, err := os.ReadFile("../../../docker/entrypoint.sh")
	if err != nil {
		t.Fatal(err)
	}
	text := string(script)
	for _, pattern := range []string{"render-*", "timeline-*"} {
		if !strings.Contains(text, "-name '"+pattern+"'") {
			t.Fatalf("entrypoint does not clean %s temporary directories", pattern)
		}
	}
}
