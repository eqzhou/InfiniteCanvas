package api

import (
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func validateFilmTimeline(timeline filmTimeline) error {
	if timeline.Revision < 1 || timeline.Width < 320 || timeline.Width > 7680 || timeline.Height < 240 || timeline.Height > 4320 || timeline.FrameRate < 1 || timeline.FrameRate > 120 {
		return errors.New("timeline output settings are outside supported limits")
	}
	if len(timeline.Tracks) != 5 {
		return errors.New("timeline requires five production tracks")
	}
	allowedKinds := map[string]struct{}{"video": {}, "dialogue": {}, "music": {}, "sfx": {}, "subtitle": {}}
	seenKinds := map[string]struct{}{}
	trackIDs := map[string]struct{}{}
	clipIDs := map[string]struct{}{}
	clipCount := 0
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
		if clipCount > 10_000 {
			return errors.New("timeline contains too many clips")
		}
		for _, clip := range track.Clips {
			if err := addUniqueFilmID(clipIDs, clip.ID, "timeline clip"); err != nil {
				return err
			}
			if clip.Revision < 1 || clip.Order < 0 || clip.Order > 10_000 || !validFilmText(clip.Source, 512, true) || !validFilmText(clip.Text, 20_000, false) {
				return errors.New("timeline clip identity is invalid")
			}
			values := []float64{clip.Start, clip.End, clip.TrimIn, clip.TrimOut, clip.Volume, clip.FadeIn, clip.FadeOut}
			for _, value := range values {
				if math.IsNaN(value) || math.IsInf(value, 0) {
					return errors.New("timeline clip contains a non-finite value")
				}
			}
			if clip.Start < 0 || clip.End <= clip.Start || clip.End > 24*60*60 || clip.TrimIn < 0 || clip.TrimOut < 0 || clip.Volume < 0 || clip.Volume > 4 || clip.FadeIn < 0 || clip.FadeOut < 0 {
				return errors.New("timeline clip values are outside supported limits")
			}
			if clip.Transition != "cut" && clip.Transition != "fade" {
				return errors.New("timeline transition is unsupported")
			}
		}
	}
	return nil
}

func safeFilmMediaPath(value string) bool {
	if value == "" || strings.ContainsAny(value, "\x00\r\n") || !filepath.IsAbs(value) {
		return false
	}
	cleaned := filepath.Clean(value)
	return cleaned == value && !strings.Contains(value, ";") && !strings.Contains(value, "|") && !strings.Contains(value, "&")
}

func filmFloat(value float64) string {
	return strconv.FormatFloat(value, 'f', 3, 64)
}

func buildFilmFFmpegArguments(timeline filmTimeline, outputPath string) ([]string, error) {
	if err := validateFilmTimeline(timeline); err != nil {
		return nil, err
	}
	if !safeFilmMediaPath(outputPath) {
		return nil, errors.New("invalid ffmpeg output path")
	}
	var videoClips []filmTimelineClip
	for _, track := range timeline.Tracks {
		if track.Kind == "video" {
			videoClips = append(videoClips, track.Clips...)
		}
	}
	if len(videoClips) == 0 {
		return nil, errors.New("timeline has no video clips")
	}
	sort.SliceStable(videoClips, func(i, j int) bool {
		if videoClips[i].Order == videoClips[j].Order {
			return videoClips[i].Start < videoClips[j].Start
		}
		return videoClips[i].Order < videoClips[j].Order
	})
	args := []string{"-nostdin", "-y"}
	for _, clip := range videoClips {
		if !safeFilmMediaPath(clip.Source) {
			return nil, fmt.Errorf("invalid video clip source %q", clip.ID)
		}
		duration := clip.End - clip.Start - clip.TrimOut
		if duration <= 0 {
			return nil, fmt.Errorf("video clip %q has no renderable duration", clip.ID)
		}
		args = append(args, "-ss", filmFloat(clip.TrimIn), "-t", filmFloat(duration), "-i", clip.Source)
	}
	if len(videoClips) == 1 {
		args = append(args, "-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", timeline.Width, timeline.Height, timeline.Width, timeline.Height))
	} else {
		filters := make([]string, 0, len(videoClips)+1)
		labels := make([]string, len(videoClips))
		for index := range videoClips {
			label := fmt.Sprintf("v%d", index)
			labels[index] = "[" + label + "]"
			filters = append(filters, fmt.Sprintf("[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2[%s]", index, timeline.Width, timeline.Height, timeline.Width, timeline.Height, label))
		}
		filters = append(filters, strings.Join(labels, "")+fmt.Sprintf("concat=n=%d:v=1:a=0[outv]", len(videoClips)))
		args = append(args, "-filter_complex", strings.Join(filters, ";"), "-map", "[outv]")
	}
	args = append(args,
		"-r", strconv.Itoa(timeline.FrameRate), "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputPath,
	)
	return args, nil
}
