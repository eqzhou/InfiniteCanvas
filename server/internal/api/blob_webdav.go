package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const webDAVEnvelopeMagic = "OBDAV1\n"

type WebDAVBlobStorageConfig struct {
	Endpoint              string
	Prefix                string
	Username              string
	Password              string
	AllowPrivate          bool
	AllowInsecureLoopback bool
	HTTPClient            *http.Client
}

type webDAVBlobObjectStore struct {
	endpoint *url.URL
	prefix   string
	username string
	password string
	client   *http.Client
}

func safeWebDAVIP(ip net.IP, allowPrivate, loopbackOnly bool) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return loopbackOnly
	}
	if loopbackOnly {
		return false
	}
	if ip.IsPrivate() {
		return allowPrivate
	}
	return safeS3IP(ip, false)
}

func safeWebDAVDialContext(allowPrivate, loopbackOnly bool, lookup s3LookupIPFunc, dial s3DialContextFunc) s3DialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid WebDAV address")
		}
		addresses := []net.IP{net.ParseIP(host)}
		if addresses[0] == nil {
			addresses, err = lookup(ctx, "ip", host)
			if err != nil || len(addresses) == 0 {
				return nil, errors.New("failed to resolve WebDAV endpoint")
			}
		}
		for _, ip := range addresses {
			if !safeWebDAVIP(ip, allowPrivate, loopbackOnly) {
				return nil, errors.New("WebDAV endpoint resolved to a blocked address")
			}
		}
		var lastErr error
		for _, ip := range addresses {
			connection, dialErr := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		return nil, lastErr
	}
}

func normalizeWebDAVPrefix(raw string) (string, error) {
	prefix := strings.Trim(strings.TrimSpace(raw), "/")
	if prefix == "" {
		prefix = "openboard"
	}
	for _, segment := range strings.Split(prefix, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", errInvalidBlobObjectConfig
		}
	}
	return prefix, nil
}

func newWebDAVBlobObjectStore(config WebDAVBlobStorageConfig) (*webDAVBlobObjectStore, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") || strings.TrimSpace(config.Username) == "" || config.Password == "" {
		return nil, errInvalidBlobObjectConfig
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/")
	endpoint.RawPath = ""
	host := endpoint.Hostname()
	ip := net.ParseIP(host)
	loopbackHost := strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())
	loopbackOnly := endpoint.Scheme == "http" && config.AllowInsecureLoopback && loopbackHost
	if endpoint.Scheme == "http" && !loopbackOnly {
		return nil, errInvalidBlobObjectConfig
	}
	if ip != nil && !safeWebDAVIP(ip, config.AllowPrivate, loopbackOnly) {
		return nil, errInvalidBlobObjectConfig
	}
	if loopbackHost && !loopbackOnly {
		return nil, errInvalidBlobObjectConfig
	}
	prefix, err := normalizeWebDAVPrefix(config.Prefix)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 70 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		client = &copy
		if client.Timeout <= 0 || client.Timeout > 70*time.Second {
			client.Timeout = 70 * time.Second
		}
		if client.Transport != nil {
			provided, ok := client.Transport.(*http.Transport)
			if !ok {
				return nil, errInvalidBlobObjectConfig
			}
			transport = provided.Clone()
		}
	}
	transport.Proxy = nil
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = safeWebDAVDialContext(config.AllowPrivate, loopbackOnly, net.DefaultResolver.LookupIP, dialer.DialContext)
	transport.DialTLSContext = nil
	client.Transport = transport
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("WebDAV redirects are disabled") }
	return &webDAVBlobObjectStore{endpoint: endpoint, prefix: prefix, username: strings.TrimSpace(config.Username), password: config.Password, client: client}, nil
}

func (s *webDAVBlobObjectStore) Kind() string { return "webdav" }

func (s *webDAVBlobObjectStore) objectURL(tenantID, name string) (*url.URL, error) {
	if strings.TrimSpace(name) == "" || strings.Contains(name, "\\") {
		return nil, errors.New("invalid WebDAV object name")
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return nil, errors.New("invalid WebDAV object name")
		}
	}
	tenantHash := sha256.Sum256([]byte(tenantID))
	result := *s.endpoint
	result.Path = path.Join(result.Path, s.prefix, "tenants", hex.EncodeToString(tenantHash[:]), name)
	return &result, nil
}

func (s *webDAVBlobObjectStore) request(ctx context.Context, method, tenantID, name string, body []byte) (*http.Request, error) {
	endpoint, err := s.objectURL(tenantID, name)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.SetBasicAuth(s.username, s.password)
	request.Header.Set("Accept", "application/octet-stream")
	return request, nil
}

func (s *webDAVBlobObjectStore) ensureParentCollections(ctx context.Context, objectEndpoint *url.URL) error {
	basePath := path.Clean("/" + strings.Trim(s.endpoint.Path, "/"))
	parentPath := path.Dir(objectEndpoint.Path)
	if parentPath == basePath {
		return nil
	}
	var relative string
	if basePath == "/" {
		relative = strings.TrimPrefix(parentPath, "/")
	} else {
		basePrefix := basePath + "/"
		if !strings.HasPrefix(parentPath, basePrefix) {
			return errors.New("WebDAV object path escaped endpoint")
		}
		relative = strings.TrimPrefix(parentPath, basePrefix)
	}
	if relative == "" {
		return nil
	}
	currentPath := basePath
	for _, segment := range strings.Split(relative, "/") {
		currentPath = path.Join(currentPath, segment)
		collectionEndpoint := *s.endpoint
		collectionEndpoint.Path = currentPath
		request, err := http.NewRequestWithContext(ctx, "MKCOL", collectionEndpoint.String(), nil)
		if err != nil {
			return err
		}
		request.SetBasicAuth(s.username, s.password)
		response, err := s.client.Do(request)
		if err != nil {
			return err
		}
		_ = response.Body.Close()
		if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != http.StatusMethodNotAllowed {
			return fmt.Errorf("WebDAV MKCOL failed with status %d", response.StatusCode)
		}
	}
	return nil
}

func (s *webDAVBlobObjectStore) Ping(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, s.endpoint.String(), nil)
	if err != nil {
		return err
	}
	request.SetBasicAuth(s.username, s.password)
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return fmt.Errorf("WebDAV health check failed with status %d", response.StatusCode)
	}
	return nil
}

func encodeWebDAVBlob(value blobObject) ([]byte, error) {
	if !allowedBlobMediaType(value.Metadata.ContentType) {
		return nil, errors.New("WebDAV blob metadata is invalid")
	}
	metadata, err := json.Marshal(value.Metadata)
	if err != nil || len(metadata) > 16<<10 {
		return nil, errors.New("WebDAV blob metadata is invalid")
	}
	result := make([]byte, len(webDAVEnvelopeMagic)+4+len(metadata)+len(value.Data))
	copy(result, webDAVEnvelopeMagic)
	binary.BigEndian.PutUint32(result[len(webDAVEnvelopeMagic):], uint32(len(metadata)))
	copy(result[len(webDAVEnvelopeMagic)+4:], metadata)
	copy(result[len(webDAVEnvelopeMagic)+4+len(metadata):], value.Data)
	return result, nil
}

func decodeWebDAVBlob(raw []byte, limit int64) (blobObject, error) {
	if len(raw) < len(webDAVEnvelopeMagic)+4 || string(raw[:len(webDAVEnvelopeMagic)]) != webDAVEnvelopeMagic {
		return blobObject{}, errors.New("WebDAV blob envelope is invalid")
	}
	metadataLength := int(binary.BigEndian.Uint32(raw[len(webDAVEnvelopeMagic):]))
	offset := len(webDAVEnvelopeMagic) + 4
	if metadataLength < 2 || metadataLength > 16<<10 || offset+metadataLength > len(raw) {
		return blobObject{}, errors.New("WebDAV blob envelope is invalid")
	}
	data := raw[offset+metadataLength:]
	if limit < 0 || int64(len(data)) > limit {
		return blobObject{}, errBlobObjectTooLarge
	}
	var metadata blobMetadata
	if json.Unmarshal(raw[offset:offset+metadataLength], &metadata) != nil || !allowedBlobMediaType(metadata.ContentType) {
		return blobObject{}, errors.New("WebDAV blob metadata is invalid")
	}
	return blobObject{Data: append([]byte(nil), data...), Metadata: metadata}, nil
}

func (s *webDAVBlobObjectStore) Get(ctx context.Context, tenantID, name string, limit int64) (blobObject, error) {
	request, err := s.request(ctx, http.MethodGet, tenantID, name, nil)
	if err != nil {
		return blobObject{}, err
	}
	response, err := s.client.Do(request)
	if err != nil {
		return blobObject{}, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return blobObject{}, store.ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return blobObject{}, fmt.Errorf("WebDAV get failed with status %d", response.StatusCode)
	}
	if limit < 0 || (response.ContentLength >= 0 && response.ContentLength > limit+(20<<10)) {
		return blobObject{}, errBlobObjectTooLarge
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+(20<<10)+1))
	if err != nil {
		return blobObject{}, err
	}
	value, err := decodeWebDAVBlob(raw, limit)
	if err != nil {
		return blobObject{}, err
	}
	value.Version = response.Header.Get("ETag")
	if value.Version == "" {
		return blobObject{}, errors.New("WebDAV blob version is missing")
	}
	return value, nil
}

func (s *webDAVBlobObjectStore) Put(ctx context.Context, tenantID, name string, value blobObject, expectedVersion string) (string, error) {
	body, err := encodeWebDAVBlob(value)
	if err != nil {
		return "", err
	}
	objectEndpoint, err := s.objectURL(tenantID, name)
	if err != nil {
		return "", err
	}
	if err := s.ensureParentCollections(ctx, objectEndpoint); err != nil {
		return "", err
	}
	request, err := s.request(ctx, http.MethodPut, tenantID, name, body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/octet-stream")
	if expectedVersion == blobVersionAbsent {
		request.Header.Set("If-None-Match", "*")
	} else if expectedVersion != "" {
		request.Header.Set("If-Match", expectedVersion)
	}
	trace := &s3PutRequestTrace{}
	request = request.WithContext(httptrace.WithClientTrace(request.Context(), trace.clientTrace()))
	response, err := s.client.Do(request)
	if err != nil {
		if trace.definitelyFailedBeforeWrite() {
			return "", fmt.Errorf("%w: %w", errBlobStorageProviderUnavailable, err)
		}
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusPreconditionFailed || response.StatusCode == http.StatusConflict {
		return "", errBlobObjectConflict
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("WebDAV put failed with status %d", response.StatusCode)
	}
	version := response.Header.Get("ETag")
	if version == "" {
		return "", errors.New("WebDAV blob version is missing")
	}
	return version, nil
}

func (s *webDAVBlobObjectStore) Delete(ctx context.Context, tenantID, name, expectedVersion string) error {
	request, err := s.request(ctx, http.MethodDelete, tenantID, name, nil)
	if err != nil {
		return err
	}
	if expectedVersion != "" {
		request.Header.Set("If-Match", expectedVersion)
	}
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusPreconditionFailed || response.StatusCode == http.StatusConflict {
		return errBlobObjectConflict
	}
	if response.StatusCode == http.StatusNotFound || (response.StatusCode >= 200 && response.StatusCode < 300) {
		return nil
	}
	return fmt.Errorf("WebDAV delete failed with status %d", response.StatusCode)
}

func webDAVBlobStorageDestination(store *webDAVBlobObjectStore) string {
	return "webdav:" + store.endpoint.String() + "/" + store.prefix
}
