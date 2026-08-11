package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	defaultFilmPDFTextTimeout = 30 * time.Second
	maxFilmPDFTextTimeout     = 2 * time.Minute
	minFilmPDFOutputBytes     = int64(4 << 10)
	maxFilmPDFDiagnosticBytes = int64(8 << 10)
	maxFilmPDFInputBytes      = int64(20 << 20)
	filmPDFCapabilityRetryTTL = 5 * time.Second
)

var (
	errFilmPDFOutputLimit     = errors.New("PDF extracted text exceeds its configured output limit")
	errFilmPDFToolUnavailable = errors.New("PDF text extraction tool is unavailable")
)

type filmPDFTextConfig struct {
	Executable        string
	SandboxExecutable string
	TempRoot          string
	Timeout           time.Duration
	OutputLimit       int64
}

type filmPDFTextRunner func(ctx context.Context, executable string, arguments []string, stdout, stderr io.Writer) error

type execFilmPDFTextRunner struct{}

func (execFilmPDFTextRunner) Run(ctx context.Context, executable string, arguments []string, stdout, stderr io.Writer) error {
	command := exec.CommandContext(ctx, executable, arguments...)
	command.Env = []string{"HOME=/nonexistent", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=/usr/bin:/bin"}
	command.Stdout = stdout
	command.Stderr = stderr
	return command.Run()
}

func (s *Server) filmPDFTextCapability() (filmPDFTextConfig, error) {
	// Injected runners are test-only and may be attached after a test server is
	// mounted, so they deliberately bypass the immutable production cache.
	if s.filmPDFTextRunner != nil {
		return resolveFilmPDFTextConfig(s.dataDir, true)
	}
	s.filmPDFCapabilityMu.Lock()
	defer s.filmPDFCapabilityMu.Unlock()
	if s.filmPDFCapabilityReady {
		return s.filmPDFCapabilityConfig, nil
	}
	now := time.Now()
	if s.filmPDFCapabilityErr != nil && now.Before(s.filmPDFRetryAt) {
		return filmPDFTextConfig{}, s.filmPDFCapabilityErr
	}
	s.filmPDFCapabilityConfig, s.filmPDFCapabilityErr = resolveFilmPDFTextConfig(s.dataDir)
	if s.filmPDFCapabilityErr == nil {
		s.filmPDFCapabilityReady = true
		s.filmPDFRetryAt = time.Time{}
	} else {
		s.filmPDFRetryAt = now.Add(filmPDFCapabilityRetryTTL)
	}
	return s.filmPDFCapabilityConfig, s.filmPDFCapabilityErr
}

func resolveFilmPDFTextConfig(dataDir string, allowInjectedTestRunner ...bool) (filmPDFTextConfig, error) {
	executable := strings.TrimSpace(os.Getenv("OPENBOARD_PDFTOTEXT_PATH"))
	if executable != "" && !filepath.IsAbs(executable) {
		return filmPDFTextConfig{}, errors.New("OPENBOARD_PDFTOTEXT_PATH must be an absolute path")
	}
	if executable == "" {
		resolved, err := exec.LookPath("pdftotext")
		if err != nil {
			return filmPDFTextConfig{}, fmt.Errorf("%w: install Poppler pdftotext or set OPENBOARD_PDFTOTEXT_PATH to its absolute path", errFilmPDFToolUnavailable)
		}
		absolute, absoluteErr := filepath.Abs(resolved)
		if absoluteErr != nil {
			return filmPDFTextConfig{}, errors.New("PDF text extractor path could not be resolved")
		}
		executable = absolute
	}
	executable, err := resolveFilmPDFExecutable(executable)
	if err != nil {
		return filmPDFTextConfig{}, fmt.Errorf("%w: configured pdftotext executable is missing or not executable", errFilmPDFToolUnavailable)
	}
	sandboxExecutable := strings.TrimSpace(os.Getenv("OPENBOARD_PDF_SANDBOX_PATH"))
	if sandboxExecutable == "" && !(len(allowInjectedTestRunner) == 1 && allowInjectedTestRunner[0]) {
		return filmPDFTextConfig{}, fmt.Errorf("%w: OPENBOARD_PDF_SANDBOX_PATH is required for PDF parsing", errFilmPDFToolUnavailable)
	}
	if sandboxExecutable != "" {
		if !filepath.IsAbs(sandboxExecutable) {
			return filmPDFTextConfig{}, errors.New("OPENBOARD_PDF_SANDBOX_PATH must be an absolute path")
		}
		sandboxExecutable, err = resolveFilmPDFExecutable(sandboxExecutable)
		if err != nil {
			return filmPDFTextConfig{}, fmt.Errorf("%w: configured PDF sandbox is missing, writable, or not executable", errFilmPDFToolUnavailable)
		}
		if err := probeFilmPDFSandbox(sandboxExecutable); err != nil {
			return filmPDFTextConfig{}, fmt.Errorf("%w: configured PDF sandbox self-test failed", errFilmPDFToolUnavailable)
		}
	}
	timeout := defaultFilmPDFTextTimeout
	if raw := strings.TrimSpace(os.Getenv("OPENBOARD_PDFTOTEXT_TIMEOUT")); raw != "" {
		parsed, parseErr := time.ParseDuration(raw)
		if parseErr != nil || parsed < time.Second || parsed > maxFilmPDFTextTimeout {
			return filmPDFTextConfig{}, fmt.Errorf("OPENBOARD_PDFTOTEXT_TIMEOUT must be between 1s and %s", maxFilmPDFTextTimeout)
		}
		timeout = parsed
	}
	outputLimit := int64(maxFilmSourceBytes)
	if raw := strings.TrimSpace(os.Getenv("OPENBOARD_PDFTOTEXT_MAX_OUTPUT_BYTES")); raw != "" {
		parsed, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || parsed < minFilmPDFOutputBytes || parsed > int64(maxFilmSourceBytes) {
			return filmPDFTextConfig{}, fmt.Errorf("OPENBOARD_PDFTOTEXT_MAX_OUTPUT_BYTES must be between %d and %d", minFilmPDFOutputBytes, maxFilmSourceBytes)
		}
		outputLimit = parsed
	}
	if strings.TrimSpace(dataDir) == "" {
		dataDir = os.TempDir()
	}
	tempRoot, err := filepath.Abs(filepath.Join(dataDir, "film-import-tmp"))
	if err != nil {
		return filmPDFTextConfig{}, errors.New("PDF extraction temporary directory could not be resolved")
	}
	return filmPDFTextConfig{Executable: executable, SandboxExecutable: sandboxExecutable, TempRoot: tempRoot, Timeout: timeout, OutputLimit: outputLimit}, nil
}

func probeFilmPDFSandbox(executable string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "--self-test")
	command.Env = []string{"HOME=/nonexistent", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "PATH=/usr/bin:/bin"}
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	return command.Run()
}

func resolveFilmPDFExecutable(value string) (string, error) {
	resolved, err := filepath.EvalSymlinks(value)
	if err != nil || !filepath.IsAbs(resolved) {
		return "", errors.New("executable path could not be resolved")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 || info.Mode().Perm()&0o022 != 0 {
		return "", errors.New("executable path is unsafe")
	}
	return resolved, nil
}

type boundedFilmPDFWriter struct {
	buffer bytes.Buffer
	limit  int64
}

func (writer *boundedFilmPDFWriter) Write(value []byte) (int, error) {
	remaining := writer.limit - int64(writer.buffer.Len())
	if int64(len(value)) > remaining {
		if remaining > 0 {
			_, _ = writer.buffer.Write(value[:remaining])
		}
		return maxInt(0, int(remaining)), errFilmPDFOutputLimit
	}
	return writer.buffer.Write(value)
}

func (writer *boundedFilmPDFWriter) Bytes() []byte {
	return writer.buffer.Bytes()
}

type boundedFilmPDFDiagnosticWriter struct {
	buffer bytes.Buffer
	limit  int64
}

func (writer *boundedFilmPDFDiagnosticWriter) Write(value []byte) (int, error) {
	remaining := writer.limit - int64(writer.buffer.Len())
	if remaining > 0 {
		copyLength := minInt(len(value), int(remaining))
		_, _ = writer.buffer.Write(value[:copyLength])
	}
	return len(value), nil
}

func (writer *boundedFilmPDFDiagnosticWriter) Bytes() []byte {
	return writer.buffer.Bytes()
}

func validateFilmPDFEnvelope(data []byte, limit int64) error {
	if limit < 1 || int64(len(data)) > limit || int64(len(data)) > maxFilmPDFInputBytes {
		return errors.New("PDF exceeds its configured size limit")
	}
	if len(data) < 8 || !bytes.HasPrefix(data, []byte("%PDF-")) || bytes.LastIndex(data, []byte("%%EOF")) < 0 {
		return errors.New("PDF signature or trailer is invalid")
	}
	return nil
}

func extractFilmPDFWithRunner(ctx context.Context, data []byte, limit int64, config filmPDFTextConfig, runner filmPDFTextRunner) (string, error) {
	if err := validateFilmPDFEnvelope(data, limit); err != nil {
		return "", err
	}
	if !filepath.IsAbs(config.Executable) || (config.SandboxExecutable != "" && !filepath.IsAbs(config.SandboxExecutable)) || config.Timeout <= 0 || config.Timeout > maxFilmPDFTextTimeout || config.OutputLimit < 1 || config.OutputLimit > int64(maxFilmSourceBytes) {
		return "", errors.New("PDF text extraction configuration is invalid")
	}
	if runner == nil {
		defaultRunner := execFilmPDFTextRunner{}
		runner = defaultRunner.Run
	}
	if err := os.MkdirAll(config.TempRoot, 0o700); err != nil {
		return "", errors.New("PDF extraction temporary directory is unavailable")
	}
	temporaryDirectory, err := os.MkdirTemp(config.TempRoot, "pdf-")
	if err != nil {
		return "", errors.New("PDF extraction temporary directory could not be created")
	}
	defer os.RemoveAll(temporaryDirectory)
	inputPath := filepath.Join(temporaryDirectory, "input.pdf")
	if err := os.WriteFile(inputPath, data, 0o600); err != nil {
		return "", errors.New("PDF extraction input could not be staged")
	}
	commandContext, cancel := context.WithTimeout(ctx, config.Timeout)
	defer cancel()
	stdout := &boundedFilmPDFWriter{limit: config.OutputLimit}
	stderr := &boundedFilmPDFDiagnosticWriter{limit: maxFilmPDFDiagnosticBytes}
	arguments := []string{"-layout", "-enc", "UTF-8", "-nopgbrk", inputPath, "-"}
	runExecutable := config.Executable
	if config.SandboxExecutable != "" {
		arguments = append([]string{config.Executable}, arguments...)
		runExecutable = config.SandboxExecutable
	}
	runErr := runner(commandContext, runExecutable, arguments, stdout, stderr)
	if errors.Is(runErr, errFilmPDFOutputLimit) {
		return "", errFilmPDFOutputLimit
	}
	if errors.Is(commandContext.Err(), context.DeadlineExceeded) {
		return "", errors.New("PDF text extraction timed out")
	}
	if runErr != nil {
		diagnostic := strings.TrimSpace(string(stderr.Bytes()))
		if diagnostic != "" {
			diagnostic = strings.ReplaceAll(diagnostic, temporaryDirectory, "<temporary-directory>")
			diagnostic = strings.ReplaceAll(diagnostic, inputPath, "<input.pdf>")
			diagnostic = strings.Map(func(character rune) rune {
				if unicode.IsControl(character) && character != '\n' && character != '\t' {
					return -1
				}
				return character
			}, diagnostic)
			return "", fmt.Errorf("PDF text extraction failed: %s", diagnostic)
		}
		return "", errors.New("PDF text extraction failed")
	}
	output := bytes.TrimPrefix(stdout.Bytes(), []byte{0xef, 0xbb, 0xbf})
	if !utf8.Valid(output) || bytes.IndexByte(output, 0) >= 0 {
		return "", errors.New("PDF text extractor returned invalid UTF-8")
	}
	text := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(string(output), "\r\n", "\n"), "\r", "\n"))
	if !usableFilmPDFText(text) {
		return "", errFilmPDFNeedsOCR
	}
	return text, nil
}
