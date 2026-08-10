package api

import (
	"encoding/json"
	"errors"
	"sort"
)

type filmScriptPromptShot struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Dialogues   []string `json:"dialogues"`
}

type filmScriptPromptScene struct {
	Heading  string                 `json:"heading"`
	Synopsis string                 `json:"synopsis"`
	Shots    []filmScriptPromptShot `json:"shots"`
}

type filmScriptPromptInput struct {
	Title               string                  `json:"title"`
	Synopsis            string                  `json:"synopsis"`
	Scenes              []filmScriptPromptScene `json:"scenes"`
	AvailableCharacters []string                `json:"availableCharacters"`
	AvailableLocations  []string                `json:"availableLocations"`
}

func filmScriptTargetSnapshot(document filmDocument, episodeID string) (string, int, string, error) {
	var episode filmEpisode
	for _, current := range document.Episodes {
		if current.ID == episodeID {
			episode = current
			break
		}
	}
	if episode.ID == "" {
		return "", 0, "", errors.New("target episode is unavailable")
	}
	scenes := make([]filmScene, 0)
	for _, scene := range document.Scenes {
		if scene.EpisodeID == episode.ID {
			scenes = append(scenes, scene)
		}
	}
	sort.Slice(scenes, func(left, right int) bool { return scenes[left].Order < scenes[right].Order })
	input := filmScriptPromptInput{Title: episode.Title, Synopsis: episode.Synopsis, Scenes: []filmScriptPromptScene{}, AvailableCharacters: []string{}, AvailableLocations: []string{}}
	targetShots := make([]filmShot, 0)
	targetDialogues := make([]filmDialogue, 0)
	for _, scene := range scenes {
		shots := make([]filmShot, 0)
		for _, shot := range document.Shots {
			if shot.SceneID == scene.ID {
				shots = append(shots, shot)
				targetShots = append(targetShots, shot)
			}
		}
		sort.Slice(shots, func(left, right int) bool { return shots[left].Order < shots[right].Order })
		promptScene := filmScriptPromptScene{Heading: scene.Heading, Synopsis: scene.Synopsis, Shots: []filmScriptPromptShot{}}
		for _, shot := range shots {
			dialogues := make([]filmDialogue, 0)
			for _, dialogue := range document.Dialogues {
				if dialogue.ShotID == shot.ID {
					dialogues = append(dialogues, dialogue)
					targetDialogues = append(targetDialogues, dialogue)
				}
			}
			sort.Slice(dialogues, func(left, right int) bool { return dialogues[left].Order < dialogues[right].Order })
			lines := make([]string, 0, len(dialogues))
			for _, dialogue := range dialogues {
				lines = append(lines, dialogue.Text)
			}
			promptScene.Shots = append(promptScene.Shots, filmScriptPromptShot{Title: shot.Title, Description: shot.Description, Dialogues: lines})
		}
		input.Scenes = append(input.Scenes, promptScene)
	}
	for _, asset := range document.Assets {
		switch asset.Kind {
		case "character":
			input.AvailableCharacters = append(input.AvailableCharacters, asset.Title)
		case "location":
			input.AvailableLocations = append(input.AvailableLocations, asset.Title)
		}
	}
	sort.Strings(input.AvailableCharacters)
	sort.Strings(input.AvailableLocations)
	prompt, err := json.Marshal(input)
	if err != nil {
		return "", 0, "", err
	}
	targetSHA, err := hashGenerationInput(struct {
		Episode   filmEpisode    `json:"episode"`
		Scenes    []filmScene    `json:"scenes"`
		Shots     []filmShot     `json:"shots"`
		Dialogues []filmDialogue `json:"dialogues"`
		Assets    []filmAsset    `json:"assets"`
	}{Episode: episode, Scenes: scenes, Shots: targetShots, Dialogues: targetDialogues, Assets: document.Assets})
	if err != nil {
		return "", 0, "", err
	}
	return string(prompt), episode.Revision, targetSHA, nil
}
