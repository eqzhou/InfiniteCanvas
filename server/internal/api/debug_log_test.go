package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDatedDebugLogWriterRotatesAtLocalMidnight(t *testing.T) {
	dataDir := t.TempDir()
	now := time.Date(2026, time.July, 31, 23, 59, 59, 0, time.Local)
	writer, err := newDatedDebugLogWriter(dataDir, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}

	if _, err := writer.Write([]byte("first event\n")); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := writer.Write([]byte("second event\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	for date, want := range map[string]string{
		"2026-07-31": "first event\n",
		"2026-08-01": "second event\n",
	} {
		path := filepath.Join(dataDir, "debug", "debug-"+date+".log")
		got, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("read %s: %v", path, readErr)
		}
		if string(got) != want {
			t.Fatalf("%s = %q, want %q", path, got, want)
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			t.Fatal(statErr)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s permissions = %o, want 600", path, info.Mode().Perm())
		}
	}
}

func TestDatedDebugLogWriterRejectsInvalidRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := newDatedDebugLogWriter(file, time.Now); err == nil {
		t.Fatal("expected a file root to be rejected")
	}
}
