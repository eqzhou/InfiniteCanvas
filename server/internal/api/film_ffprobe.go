package api

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	maxFilmProbeOutput  = 256 << 10
	maxFilmProbeStreams = 8
	maxFilmInputBitrate = int64(100_000_000)
	maxFilmInputFrames  = int64(500_000)
)

var errFilmFFprobeFailed = errors.New("media input failed the bounded FFprobe validation")

type filmProbeRunner interface {
	Probe(context.Context, string, []string) ([]byte, error)
}

type execFilmProbeRunner struct{}

func (execFilmProbeRunner) Probe(ctx context.Context, path string, args []string) ([]byte, error) {
	command := exec.CommandContext(ctx, path, args...)
	stdout := &boundedFilmWriter{limit: maxFilmProbeOutput}
	stderr := &boundedFilmWriter{limit: 32 << 10}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Run(); err != nil {
		return nil, err
	}
	if stdout.buffer.Len() >= maxFilmProbeOutput {
		return nil, errFilmFFprobeFailed
	}
	return append([]byte(nil), stdout.buffer.Bytes()...), nil
}

func resolveFilmFFprobePath(ffmpegPath string) string {
	if configured := strings.TrimSpace(os.Getenv("OPENBOARD_FFPROBE_PATH")); configured != "" {
		return configured
	}
	if !validFilmFFmpegPath(ffmpegPath) {
		return ""
	}
	return filepath.Join(filepath.Dir(ffmpegPath), "ffprobe")
}

type filmProbeNumber string

func (value filmProbeNumber) number() (float64, error) {
	parsed, err := strconv.ParseFloat(string(value), 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed < 0 {
		return 0, errFilmFFprobeFailed
	}
	return parsed, nil
}

type filmProbeResult struct {
	// Newer FFprobe versions emit these empty top-level arrays even when
	// -show_entries does not request their fields. Keep strict decoding while
	// rejecting actual programs/groups below.
	Programs     []json.RawMessage `json:"programs"`
	StreamGroups []json.RawMessage `json:"stream_groups"`
	Streams      []struct {
		CodecType string          `json:"codec_type"`
		Width     int             `json:"width"`
		Height    int             `json:"height"`
		Duration  filmProbeNumber `json:"duration"`
		BitRate   filmProbeNumber `json:"bit_rate"`
		Frames    filmProbeNumber `json:"nb_frames"`
	} `json:"streams"`
	Format struct {
		Duration filmProbeNumber `json:"duration"`
		BitRate  filmProbeNumber `json:"bit_rate"`
	} `json:"format"`
}

type filmProbeMetadata struct {
	Duration float64
	Width    int
	Height   int
}

func optionalFilmProbeNumber(value filmProbeNumber) (float64, error) {
	if value == "" || value == "N/A" {
		return 0, nil
	}
	return value.number()
}

func (s *Server) probeFilmInput(ctx context.Context, probePath, inputPath, expectedKind string, expectedDuration float64) error {
	_, err := s.probeFilmInputMetadata(ctx, probePath, inputPath, expectedKind, expectedDuration)
	return err
}

func (s *Server) probeFilmInputMetadata(ctx context.Context, probePath, inputPath, expectedKind string, expectedDuration float64) (filmProbeMetadata, error) {
	if !validFilmFFmpegPath(probePath) || !safeFilmMediaPath(inputPath) || (expectedKind != "video" && expectedKind != "audio") || expectedDuration <= 0 || expectedDuration > maxFilmTimelineDuration {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []string{"-hide_banner", "-v", "error", "-probesize", "1048576", "-analyzeduration", "2000000", "-protocol_whitelist", "file,pipe", "-threads", "1", "-show_entries", "format=duration,bit_rate:stream=codec_type,width,height,duration,bit_rate,nb_frames", "-of", "json", inputPath}
	raw, err := s.filmProbeRunner.Probe(probeCtx, probePath, args)
	if err != nil || len(raw) == 0 || len(raw) > maxFilmProbeOutput {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	var result filmProbeResult
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&result) != nil || ensureJSONEOF(decoder) != nil || len(result.Programs) != 0 || len(result.StreamGroups) != 0 || len(result.Streams) == 0 || len(result.Streams) > maxFilmProbeStreams {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	duration, err := optionalFilmProbeNumber(result.Format.Duration)
	if err != nil || duration <= 0 || duration > maxFilmTimelineDuration || duration > expectedDuration+60 {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	bitrate, err := optionalFilmProbeNumber(result.Format.BitRate)
	if err != nil || int64(bitrate) > maxFilmInputBitrate {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	found, totalFrames, pixelFrames := false, int64(0), float64(0)
	metadata := filmProbeMetadata{Duration: duration}
	for _, stream := range result.Streams {
		if stream.CodecType != "video" && stream.CodecType != "audio" && stream.CodecType != "subtitle" {
			return filmProbeMetadata{}, errFilmFFprobeFailed
		}
		if stream.CodecType == expectedKind {
			found = true
		}
		if stream.CodecType == "video" && (stream.Width < 1 || stream.Height < 1 || stream.Width > 3840 || stream.Height > 2160) {
			return filmProbeMetadata{}, errFilmFFprobeFailed
		}
		if stream.CodecType == "video" && metadata.Width == 0 {
			metadata.Width, metadata.Height = stream.Width, stream.Height
		}
		streamBitrate, numberErr := optionalFilmProbeNumber(stream.BitRate)
		if numberErr != nil || int64(streamBitrate) > maxFilmInputBitrate {
			return filmProbeMetadata{}, errFilmFFprobeFailed
		}
		frames, numberErr := optionalFilmProbeNumber(stream.Frames)
		if numberErr != nil || frames > float64(maxFilmInputFrames) {
			return filmProbeMetadata{}, errFilmFFprobeFailed
		}
		totalFrames += int64(frames)
		if stream.CodecType == "video" {
			if frames == 0 {
				frames = duration * 60
			}
			pixelFrames += float64(stream.Width) * float64(stream.Height) * frames
		}
	}
	if !found || totalFrames > maxFilmInputFrames || pixelFrames > maxFilmPixelFrameBudget {
		return filmProbeMetadata{}, errFilmFFprobeFailed
	}
	return metadata, nil
}
