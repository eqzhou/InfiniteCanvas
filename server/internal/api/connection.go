package api

import (
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
)

func WriteConnectionFile(dataDir, baseURL, token string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("connection URL is invalid")
	}
	data, err := json.MarshalIndent(map[string]string{"baseUrl": baseURL, "token": token}, "", "  ")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dataDir, "connection.json")
	temporary := path + "." + randomID("tmp")
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return "", err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(temporary)
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(temporary)
		return "", err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return "", err
	}
	return path, os.Chmod(path, 0o600)
}
