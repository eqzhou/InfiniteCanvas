package api

import "testing"

func TestPublicBlobAPIProtectsGeneratedAndCaptureKeys(t *testing.T) {
	if !publicBlobAPIProtectedKey("film:media:image:job:abc") || !publicBlobAPIProtectedKey("film:deliverable:p:d") {
		t.Fatal("film prefixes must stay protected")
	}
	if !publicBlobAPIProtectedKey("director-capture:cap-1") {
		t.Fatal("director captures must not be writable through /api/blobs")
	}
	if !publicBlobAPIProtectedKey("image:generated:job:abc") || !publicBlobAPIProtectedKey("media:generated:video:job:abc") {
		t.Fatal("generated media must not be writable through /api/blobs")
	}
	if publicBlobAPIProtectedKey("user-upload.png") || publicBlobAPIProtectedKey("assets/cover.png") {
		t.Fatal("user-uploaded keys must remain writable")
	}
}
