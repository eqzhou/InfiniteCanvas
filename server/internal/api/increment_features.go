package api

import (
	"os"
	"strings"
)

const (
	webDAVMediaFeatureEnv     = "OPENBOARD_WEBDAV_MEDIA"
	advancedVoiceFeatureEnv   = "OPENBOARD_ADVANCED_VOICE"
	localWorkflowsFeatureEnv  = "OPENBOARD_LOCAL_WORKFLOWS"
	styleExtractionFeatureEnv = "OPENBOARD_STYLE_EXTRACTION"
	filmStageWaiverFeatureEnv = "OPENBOARD_FILM_STAGE_WAIVER"
)

// incrementFeatureEnabled is deliberately strict. Incremental production
// capabilities remain disabled unless an operator explicitly opts in with
// the word "true"; ambiguous values such as 1 or yes fail closed.
func incrementFeatureEnabled(name string) bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(name)), "true")
}

func incrementFeatureCapabilities() map[string]bool {
	return map[string]bool{
		"webdavMedia":     incrementFeatureEnabled(webDAVMediaFeatureEnv),
		"advancedVoice":   incrementFeatureEnabled(advancedVoiceFeatureEnv),
		"localWorkflows":  incrementFeatureEnabled(localWorkflowsFeatureEnv),
		"styleExtraction": incrementFeatureEnabled(styleExtractionFeatureEnv),
		"stageWaiver":     incrementFeatureEnabled(filmStageWaiverFeatureEnv),
	}
}
