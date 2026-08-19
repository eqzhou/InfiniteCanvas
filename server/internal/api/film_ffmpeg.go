package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxFilmTimelineClips    = 256
	maxFilmTimelineDuration = 2 * 60 * 60
	maxFilmPixelFrameBudget = float64(1920 * 1080 * 30 * 60 * 60)
	maxFilmRenderBytes      = int64(maxUploadBytes)
	filmOutputToken         = "{openboard-film-output}"
)

var (
	errFilmFFmpegUnavailable = errors.New("FFmpeg is not configured or failed its capability probe")
	errFilmFFmpegFailed      = errors.New("FFmpeg could not render the bounded timeline")
	errFilmRenderBusy        = errors.New("film render concurrency limit reached")
)

type filmFFmpegCapabilityCache struct {
	path       string
	probePath  string
	available  bool
	diagnostic string
	expiresAt  time.Time
	probing    bool
	wait       chan struct{}
}

type filmCommandRunner interface {
	Run(context.Context, string, []string) error
}

type execFilmCommandRunner struct{}

type boundedFilmWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (writer *boundedFilmWriter) Write(value []byte) (int, error) {
	original := len(value)
	remaining := writer.limit - writer.buffer.Len()
	if remaining > 0 {
		if len(value) > remaining {
			value = value[:remaining]
		}
		_, _ = writer.buffer.Write(value)
	}
	return original, nil
}

func (execFilmCommandRunner) Run(ctx context.Context, path string, args []string) error {
	command := exec.CommandContext(ctx, path, args...)
	diagnostic := &boundedFilmWriter{limit: 32 << 10}
	command.Stdout = diagnostic
	command.Stderr = diagnostic
	return command.Run()
}

func filmRenderTimeout() time.Duration {
	const fallback = 15 * time.Minute
	raw := strings.TrimSpace(os.Getenv("OPENBOARD_FILM_RENDER_TIMEOUT_SECONDS"))
	if raw == "" {
		return fallback
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 1 || seconds > 3_600 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func validFilmFFmpegPath(value string) bool {
	return value != "" && filepath.IsAbs(value) && filepath.Clean(value) == value && !strings.ContainsAny(value, "\x00\r\n")
}

func (s *Server) filmFFmpegCapability(ctx context.Context) (string, bool, string) {
	path := strings.TrimSpace(os.Getenv("OPENBOARD_FFMPEG_PATH"))
	probePath := resolveFilmFFprobePath(path)
	s.filmCapabilityMu.Lock()
	cache := s.filmCapabilityCache
	if cache.path == path && cache.probePath == probePath && time.Now().Before(cache.expiresAt) && !cache.probing {
		s.filmCapabilityMu.Unlock()
		return cache.path, cache.available, cache.diagnostic
	}
	if cache.path == path && cache.probePath == probePath && cache.probing {
		wait := cache.wait
		s.filmCapabilityMu.Unlock()
		select {
		case <-ctx.Done():
			return "", false, "FFmpeg capability probe was canceled"
		case <-wait:
			return s.filmFFmpegCapability(ctx)
		}
	}
	wait := make(chan struct{})
	s.filmCapabilityCache = filmFFmpegCapabilityCache{path: path, probePath: probePath, probing: true, wait: wait}
	s.filmCapabilityMu.Unlock()
	available, diagnostic := s.probeFilmFFmpeg(ctx, path, probePath)
	s.filmCapabilityMu.Lock()
	s.filmCapabilityCache = filmFFmpegCapabilityCache{path: path, probePath: probePath, available: available, diagnostic: diagnostic, expiresAt: time.Now().Add(30 * time.Second)}
	close(wait)
	s.filmCapabilityMu.Unlock()
	return path, available, diagnostic
}

func (s *Server) probeFilmFFmpeg(ctx context.Context, path, probePath string) (bool, string) {
	resolved, err := resolveFilmMediaExecutable(path)
	if err != nil {
		if !validFilmFFmpegPath(path) {
			return false, "FFmpeg is not configured; set OPENBOARD_FFMPEG_PATH to an executable absolute path"
		}
		return false, "Configured FFmpeg executable is unavailable"
	}
	probeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	if err := s.filmCommandRunner.Run(probeCtx, resolved, []string{"-hide_banner", "-version"}); err != nil {
		return false, "Configured FFmpeg failed its capability probe"
	}
	probeResolved, err := resolveFilmMediaExecutable(probePath)
	if err != nil {
		return false, "FFprobe is unavailable; set OPENBOARD_FFPROBE_PATH to an executable absolute path"
	}
	if _, err := s.filmProbeRunner.Probe(probeCtx, probeResolved, []string{"-hide_banner", "-version"}); err != nil {
		return false, "Configured FFprobe failed its capability probe"
	}
	return true, ""
}

func validFilmExecutable(path string) bool {
	_, err := resolveFilmMediaExecutable(path)
	return err == nil
}

func resolveFilmMediaExecutable(path string) (string, error) {
	if !validFilmFFmpegPath(path) {
		return "", errFilmFFmpegUnavailable
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !validFilmFFmpegPath(resolved) {
		return "", errFilmFFmpegUnavailable
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 || info.Mode().Perm()&0o022 != 0 {
		return "", errFilmFFmpegUnavailable
	}
	return resolved, nil
}

func (s *Server) acquireFilmRender(ctx context.Context, tenantID string) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case s.filmRenderGlobal <- struct{}{}:
	default:
		return nil, errFilmRenderBusy
	}
	s.filmRenderMu.Lock()
	if s.filmTenantRenders[tenantID] >= 1 {
		s.filmRenderMu.Unlock()
		<-s.filmRenderGlobal
		return nil, errFilmRenderBusy
	}
	s.filmTenantRenders[tenantID] = 1
	s.filmRenderMu.Unlock()
	return func() {
		s.filmRenderMu.Lock()
		delete(s.filmTenantRenders, tenantID)
		s.filmRenderMu.Unlock()
		<-s.filmRenderGlobal
	}, nil
}

func (s *Server) executeFilmFFmpeg(ctx context.Context, ffmpegPath string, args []string, timeout time.Duration) ([]byte, error) {
	root := filepath.Join(s.dataDir, "film-render")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, errFilmFFmpegFailed
	}
	temporary, err := os.MkdirTemp(root, "render-")
	if err != nil {
		return nil, errFilmFFmpegFailed
	}
	defer os.RemoveAll(temporary)
	output := filepath.Join(temporary, "output.mp4")
	resolved := append([]string(nil), args...)
	for index, value := range resolved {
		if value == filmOutputToken {
			resolved[index] = output
		}
	}
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := s.filmCommandRunner.Run(commandCtx, ffmpegPath, resolved); err != nil {
		if commandCtx.Err() != nil {
			return nil, commandCtx.Err()
		}
		return nil, errFilmFFmpegFailed
	}
	value, err := os.ReadFile(output)
	if err != nil {
		// Capability/unit invocations need no output file.
		return nil, nil
	}
	if len(value) == 0 || int64(len(value)) > maxFilmRenderBytes {
		return nil, errFilmFFmpegFailed
	}
	return value, nil
}

func validateFilmTimeline(timeline filmTimeline) error {
	if timeline.Revision < 1 || timeline.Width < 320 || timeline.Width > 3840 || timeline.Height < 240 || timeline.Height > 2160 || timeline.FrameRate < 1 || timeline.FrameRate > 60 {
		return errors.New("timeline output settings are outside supported limits")
	}
	if len(timeline.Tracks) != 5 {
		return errors.New("timeline requires five production tracks")
	}
	allowedKinds := map[string]struct{}{"video": {}, "dialogue": {}, "music": {}, "sfx": {}, "subtitle": {}}
	seenKinds, trackIDs, clipIDs := map[string]struct{}{}, map[string]struct{}{}, map[string]struct{}{}
	clipCount := 0
	maximumEnd := 0.0
	for _, track := range timeline.Tracks {
		if err := addUniqueFilmID(trackIDs, track.ID, "timeline track"); err != nil {
			return err
		}
		if track.Revision < 1 || !validFilmText(track.Title, 500, true) {
			return errors.New("timeline track is invalid")
		}
		if _, allowed := allowedKinds[track.Kind]; !allowed {
			return errors.New("timeline track kind is unsupported")
		}
		if _, duplicate := seenKinds[track.Kind]; duplicate {
			return errors.New("timeline track kinds must be unique")
		}
		seenKinds[track.Kind] = struct{}{}
		clipCount += len(track.Clips)
		if clipCount > maxFilmTimelineClips {
			return errors.New("timeline contains too many clips")
		}
		for _, clip := range track.Clips {
			if err := addUniqueFilmID(clipIDs, clip.ID, "timeline clip"); err != nil {
				return err
			}
			if clip.Revision < 1 || clip.Order < 0 || clip.Order > maxFilmTimelineClips || !validFilmText(clip.Source, 512, track.Kind != "subtitle") || !validFilmText(clip.Text, 20_000, false) {
				return errors.New("timeline clip identity is invalid")
			}
			values := []float64{clip.Start, clip.End, clip.TrimIn, clip.TrimOut, clip.Volume, clip.FadeIn, clip.FadeOut}
			for _, value := range values {
				if math.IsNaN(value) || math.IsInf(value, 0) {
					return errors.New("timeline clip contains a non-finite value")
				}
			}
			if clip.Start < 0 || clip.End <= clip.Start || clip.End > maxFilmTimelineDuration || clip.TrimIn < 0 || clip.TrimOut < 0 || clip.Volume < 0 || clip.Volume > 4 || clip.FadeIn < 0 || clip.FadeOut < 0 {
				return errors.New("timeline clip values are outside supported limits")
			}
			duration := clip.End - clip.Start - clip.TrimOut
			if duration <= 0 || clip.FadeIn > duration || clip.FadeOut > duration {
				return errors.New("timeline clip has no valid render duration")
			}
			if clip.Transition != "cut" && clip.Transition != "fade" {
				return errors.New("timeline transition is unsupported")
			}
			if clip.End > maximumEnd {
				maximumEnd = clip.End
			}
		}
	}
	if maximumEnd > maxFilmTimelineDuration {
		return errors.New("timeline total duration exceeds its limit")
	}
	if float64(timeline.Width)*float64(timeline.Height)*float64(timeline.FrameRate)*maximumEnd > maxFilmPixelFrameBudget {
		return errors.New("timeline exceeds the pixel-frame render budget")
	}
	videos := make([]filmTimelineClip, 0)
	for _, track := range timeline.Tracks {
		if track.Kind == "video" {
			videos = append(videos, track.Clips...)
		}
	}
	sort.SliceStable(videos, func(i, j int) bool { return videos[i].Start < videos[j].Start })
	for index := 1; index < len(videos); index++ {
		if videos[index].Start < videos[index-1].End {
			return errors.New("overlapping video clips are unsupported")
		}
	}
	return nil
}

func safeFilmMediaPath(value string) bool {
	return value != "" && !strings.ContainsAny(value, "\x00\r\n") && filepath.IsAbs(value) && filepath.Clean(value) == value
}

func filmFloat(value float64) string { return strconv.FormatFloat(value, 'f', 3, 64) }

type indexedFilmClip struct {
	clip       filmTimelineClip
	trackKind  string
	inputIndex int
}

func sortedFilmTrackClips(timeline filmTimeline, kinds map[string]bool) []indexedFilmClip {
	result := []indexedFilmClip{}
	for _, track := range timeline.Tracks {
		if !kinds[track.Kind] {
			continue
		}
		for _, clip := range track.Clips {
			result = append(result, indexedFilmClip{clip: clip, trackKind: track.Kind})
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].clip.Start == result[j].clip.Start {
			if result[i].clip.Order == result[j].clip.Order {
				return result[i].clip.ID < result[j].clip.ID
			}
			return result[i].clip.Order < result[j].clip.Order
		}
		return result[i].clip.Start < result[j].clip.Start
	})
	return result
}

func buildFilmFFmpegArguments(timeline filmTimeline, outputPath string) ([]string, error) {
	return buildFilmFFmpegArgumentsWithSubtitle(timeline, outputPath, "")
}

func buildFilmFFmpegArgumentsWithSubtitle(timeline filmTimeline, outputPath, subtitlePath string) ([]string, error) {
	if err := validateFilmTimeline(timeline); err != nil {
		return nil, err
	}
	if outputPath != filmOutputToken && !safeFilmMediaPath(outputPath) {
		return nil, errors.New("invalid ffmpeg output path")
	}
	videos := sortedFilmTrackClips(timeline, map[string]bool{"video": true})
	audio := sortedFilmTrackClips(timeline, map[string]bool{"dialogue": true, "music": true, "sfx": true})
	if len(videos) == 0 {
		return nil, errors.New("timeline has no video clips")
	}
	args := []string{"-hide_banner", "-nostdin", "-y", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1"}
	inputIndex := 0
	for index := range videos {
		clip := videos[index].clip
		if !safeFilmMediaPath(clip.Source) {
			return nil, fmt.Errorf("invalid video clip source %q", clip.ID)
		}
		duration := clip.End - clip.Start - clip.TrimOut
		args = append(args, "-ss", filmFloat(clip.TrimIn), "-t", filmFloat(duration), "-i", clip.Source)
		videos[index].inputIndex = inputIndex
		inputIndex++
	}
	for index := range audio {
		clip := audio[index].clip
		if !safeFilmMediaPath(clip.Source) {
			return nil, fmt.Errorf("invalid audio clip source %q", clip.ID)
		}
		duration := clip.End - clip.Start - clip.TrimOut
		args = append(args, "-ss", filmFloat(clip.TrimIn), "-t", filmFloat(duration), "-i", clip.Source)
		audio[index].inputIndex = inputIndex
		inputIndex++
	}
	subtitleInput := -1
	if subtitlePath != "" {
		if !safeFilmMediaPath(subtitlePath) {
			return nil, errors.New("invalid subtitle path")
		}
		args = append(args, "-f", "srt", "-i", subtitlePath)
		subtitleInput = inputIndex
	}
	filters := []string{}
	videoLabels := make([]string, len(videos))
	for index, value := range videos {
		clip := value.clip
		duration := clip.End - clip.Start - clip.TrimOut
		fadeIn, fadeOut := clip.FadeIn, clip.FadeOut
		if clip.Transition == "fade" && fadeIn == 0 {
			fadeIn = math.Min(0.25, duration/2)
		}
		if clip.Transition == "fade" && fadeOut == 0 {
			fadeOut = math.Min(0.25, duration/2)
		}
		filter := fmt.Sprintf("[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1", value.inputIndex, timeline.Width, timeline.Height, timeline.Width, timeline.Height)
		if fadeIn > 0 {
			filter += fmt.Sprintf(",fade=t=in:st=0:d=%s", filmFloat(fadeIn))
		}
		if fadeOut > 0 {
			filter += fmt.Sprintf(",fade=t=out:st=%s:d=%s", filmFloat(duration-fadeOut), filmFloat(fadeOut))
		}
		filter += ",setpts=PTS-STARTPTS+" + filmFloat(clip.Start) + "/TB"
		label := fmt.Sprintf("v%d", index)
		filters = append(filters, filter+"["+label+"]")
		videoLabels[index] = "[" + label + "]"
	}
	maximumEnd := 0.0
	for _, value := range videos {
		if value.clip.End > maximumEnd {
			maximumEnd = value.clip.End
		}
	}
	filters = append(filters, fmt.Sprintf("color=c=black:s=%dx%d:r=%d:d=%s[base]", timeline.Width, timeline.Height, timeline.FrameRate, filmFloat(maximumEnd)))
	base := "base"
	for index, value := range videos {
		output := fmt.Sprintf("overlay%d", index)
		if index == len(videos)-1 {
			output = "vout"
		}
		filters = append(filters, fmt.Sprintf("[%s]%soverlay=eof_action=pass:enable='between(t,%s,%s)'[%s]", base, videoLabels[index], filmFloat(value.clip.Start), filmFloat(value.clip.End), output))
		base = output
	}
	if len(audio) == 0 {
		filters = append(filters, fmt.Sprintf("anullsrc=r=48000:cl=stereo,atrim=duration=%s[aout]", filmFloat(maximumEnd)))
	} else {
		audioLabels := make([]string, len(audio))
		for index, value := range audio {
			clip := value.clip
			duration := clip.End - clip.Start - clip.TrimOut
			volume := clip.Volume
			if clip.Muted {
				volume = 0
			}
			filter := fmt.Sprintf("[%d:a]atrim=duration=%s,asetpts=PTS-STARTPTS,volume=%s", value.inputIndex, filmFloat(duration), filmFloat(volume))
			if clip.FadeIn > 0 {
				filter += fmt.Sprintf(",afade=t=in:st=0:d=%s", filmFloat(clip.FadeIn))
			}
			if clip.FadeOut > 0 {
				filter += fmt.Sprintf(",afade=t=out:st=%s:d=%s", filmFloat(duration-clip.FadeOut), filmFloat(clip.FadeOut))
			}
			filter += fmt.Sprintf(",adelay=%d|%d", int64(clip.Start*1000), int64(clip.Start*1000))
			label := fmt.Sprintf("a%d", index)
			filters = append(filters, filter+"["+label+"]")
			audioLabels[index] = "[" + label + "]"
		}
		filters = append(filters, strings.Join(audioLabels, "")+fmt.Sprintf("amix=inputs=%d:duration=longest:normalize=0[aout]", len(audio)))
	}
	args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[vout]", "-map", "[aout]")
	if subtitleInput >= 0 {
		args = append(args, "-map", fmt.Sprintf("%d:0", subtitleInput), "-c:s", "mov_text")
	}
	args = append(args, "-map_metadata", "-1", "-map_chapters", "-1", "-r", strconv.Itoa(timeline.FrameRate), "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-fs", strconv.FormatInt(maxFilmRenderBytes, 10), outputPath)
	return args, nil
}
