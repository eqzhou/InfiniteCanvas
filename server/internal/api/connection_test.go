package api

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWriteConnectionFileUsesOwnerOnlyPermissions(t *testing.T) {
	path, err := WriteConnectionFile(t.TempDir(), "http://127.0.0.1:8790", "secret")
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("connection mode = %o", info.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]string
	if json.Unmarshal(data, &value) != nil || value["token"] != "secret" || value["baseUrl"] != "http://127.0.0.1:8790" {
		t.Fatalf("connection contents are invalid: %s", data)
	}
}
