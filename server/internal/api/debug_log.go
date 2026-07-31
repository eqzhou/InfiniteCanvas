package api

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// datedDebugLogWriter keeps the local Agent diagnostics readable by day. The
// writer is intentionally small and append-only: the standard logger remains
// responsible for timestamps and message formatting, while this type owns
// rotation and restrictive file permissions.
type datedDebugLogWriter struct {
	mu     sync.Mutex
	root   string
	clock  func() time.Time
	date   string
	file   *os.File
	closed bool
}

func newDatedDebugLogWriter(root string, clock func() time.Time) (io.WriteCloser, error) {
	if clock == nil {
		clock = time.Now
	}
	if info, err := os.Stat(root); err == nil && !info.IsDir() {
		return nil, errors.New("debug log root must be a directory")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &datedDebugLogWriter{root: root, clock: clock}, nil
}

// NewDatedDebugLogWriter is used by the server command to route standard
// diagnostics into dataDir/debug/debug-YYYY-MM-DD.log when --debug is set.
func NewDatedDebugLogWriter(root string) (io.WriteCloser, error) {
	return newDatedDebugLogWriter(root, time.Now)
}

func (w *datedDebugLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return 0, os.ErrClosed
	}
	date := w.clock().In(time.Local).Format("2006-01-02")
	if w.file == nil || w.date != date {
		if err := w.rotateLocked(date); err != nil {
			return 0, err
		}
	}
	return w.file.Write(p)
}

func (w *datedDebugLogWriter) rotateLocked(date string) error {
	if w.file != nil {
		if err := w.file.Close(); err != nil {
			w.file = nil
			return err
		}
		w.file = nil
	}
	directory := filepath.Join(w.root, "debug")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	path := filepath.Join(directory, "debug-"+date+".log")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return err
	}
	w.file = file
	w.date = date
	return nil
}

func (w *datedDebugLogWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}
