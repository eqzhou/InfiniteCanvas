package api

import (
	"strings"
	"testing"
)

const validLocalWorkflowManifest = `{
  "version":1,"id":"comfy-video","name":"Local video","endpoint":"http://127.0.0.1:8188",
  "businessMode":"first_frame_to_video","nodes":[
    {"id":"load","type":"LoadImage","inputs":{"image":"${references}"}},
    {"id":"sampler","type":"KSampler","inputs":{"prompt":"${prompt}","seed":"${seed}"}},
    {"id":"save","type":"SaveVideo","inputs":{"source":"sampler"}}
  ],"outputs":["save"],"limits":{"maxSeconds":15,"maxWidth":1920,"maxHeight":1080}
}`

func TestLocalWorkflowManifestIsDeclarativeBoundedAndVersioned(t *testing.T) {
	manifest, err := decodeLocalWorkflowManifest([]byte(validLocalWorkflowManifest))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.ContractHash == "" || len(manifest.ContractHash) != 64 {
		t.Fatalf("contract hash = %q", manifest.ContractHash)
	}
	again, err := decodeLocalWorkflowManifest([]byte(strings.Replace(validLocalWorkflowManifest, "\n", "", -1)))
	if err != nil || again.ContractHash != manifest.ContractHash {
		t.Fatalf("canonical hash drift: %v %q != %q", err, again.ContractHash, manifest.ContractHash)
	}
}

func TestLocalWorkflowManifestRejectsExecutableAndSSRFInputs(t *testing.T) {
	tests := []struct{ name, old, replacement string }{
		{"unknown field", `"outputs":["save"]`, `"outputs":["save"],"script":"rm -rf /"`},
		{"unknown node", `"type":"KSampler"`, `"type":"ShellCommand"`},
		{"public endpoint", `http://127.0.0.1:8188`, `https://workflow.example.com`},
		{"metadata endpoint", `http://127.0.0.1:8188`, `http://169.254.169.254/latest/meta-data`},
		{"placeholder injection", `${prompt}`, `${constructor.prototype.polluted}`},
		{"missing mapping", `first_frame_to_video`, `unknown_video_mode`},
		{"unknown output", `"outputs":["save"]`, `"outputs":["missing"]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeLocalWorkflowManifest([]byte(strings.Replace(validLocalWorkflowManifest, test.old, test.replacement, 1))); err == nil {
				t.Fatal("unsafe workflow manifest was accepted")
			}
		})
	}
}

func TestLocalWorkflowManifestAllowsExplicitLiteralPrivateEndpointOnly(t *testing.T) {
	private := strings.Replace(validLocalWorkflowManifest, `"endpoint":"http://127.0.0.1:8188"`, `"endpoint":"https://10.0.0.8:8188","allowPrivate":true`, 1)
	if _, err := decodeLocalWorkflowManifest([]byte(private)); err != nil {
		t.Fatalf("explicit private endpoint rejected: %v", err)
	}
	private = strings.Replace(private, `10.0.0.8`, `comfy.internal`, 1)
	if _, err := decodeLocalWorkflowManifest([]byte(private)); err == nil {
		t.Fatal("unresolved private hostname was accepted")
	}
}
