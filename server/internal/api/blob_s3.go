package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/openboard/openboard/server/internal/store"
)

const s3BlobMetadataHeader = "X-Amz-Meta-Openboard-Blob"

var s3BucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

type S3BlobStorageConfig struct {
	Endpoint              string
	Bucket                string
	Region                string
	Prefix                string
	AccessKeyID           string
	SecretAccessKey       string
	SessionToken          string
	AllowInsecureLoopback bool
	HTTPClient            *http.Client
}

type s3BlobObjectStore struct {
	endpoint        *url.URL
	bucket          string
	region          string
	prefix          string
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
	client          *http.Client
	now             func() time.Time
}

func newS3BlobObjectStore(config S3BlobStorageConfig) (*s3BlobObjectStore, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Host == "" || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.User != nil ||
		(endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return nil, errInvalidBlobObjectConfig
	}
	if endpoint.Scheme == "http" {
		host := endpoint.Hostname()
		ip := net.ParseIP(host)
		if !config.AllowInsecureLoopback || !(strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback())) {
			return nil, errInvalidBlobObjectConfig
		}
	}
	bucket := strings.TrimSpace(config.Bucket)
	region := strings.TrimSpace(config.Region)
	if !s3BucketPattern.MatchString(bucket) || strings.Contains(bucket, "..") || region == "" ||
		strings.TrimSpace(config.AccessKeyID) == "" || strings.TrimSpace(config.SecretAccessKey) == "" {
		return nil, errInvalidBlobObjectConfig
	}
	prefix := strings.Trim(strings.TrimSpace(config.Prefix), "/")
	if prefix == "" {
		prefix = "openboard"
	}
	for _, segment := range strings.Split(prefix, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return nil, errInvalidBlobObjectConfig
		}
	}
	client := &http.Client{Timeout: 70 * time.Second}
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		client = &copy
		if client.Timeout <= 0 || client.Timeout > 70*time.Second {
			client.Timeout = 70 * time.Second
		}
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return errors.New("S3 redirects are disabled")
	}
	return &s3BlobObjectStore{
		endpoint: endpoint, bucket: bucket, region: region, prefix: prefix,
		accessKeyID: strings.TrimSpace(config.AccessKeyID), secretAccessKey: config.SecretAccessKey,
		sessionToken: config.SessionToken, client: client, now: time.Now,
	}, nil
}

func (s *s3BlobObjectStore) Kind() string { return "s3" }

func (s *s3BlobObjectStore) Ping(ctx context.Context) error {
	// Startup validates the complete endpoint and credential shape. Avoid a
	// periodic missing-object GET here: S3 returns 403 without ListBucket even
	// when GetObject/PutObject are correctly scoped, and health probes should
	// not require broader bucket permissions or create request cost.
	return ctx.Err()
}

func (s *s3BlobObjectStore) Get(ctx context.Context, tenantID, name string, limit int64) (blobObject, error) {
	request, err := s.request(ctx, http.MethodGet, tenantID, name, nil, "")
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
		return blobObject{}, fmt.Errorf("S3 get failed with status %d", response.StatusCode)
	}
	if limit < 0 || (response.ContentLength > limit && response.ContentLength >= 0) {
		return blobObject{}, errBlobObjectTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return blobObject{}, err
	}
	if int64(len(data)) > limit {
		return blobObject{}, errBlobObjectTooLarge
	}
	metadata, err := decodeS3BlobMetadata(response.Header.Get(s3BlobMetadataHeader))
	if err != nil {
		return blobObject{}, err
	}
	version := response.Header.Get("ETag")
	if version == "" {
		return blobObject{}, errors.New("S3 blob version is missing")
	}
	return blobObject{Data: data, Metadata: metadata, Version: version}, nil
}

func (s *s3BlobObjectStore) Put(ctx context.Context, tenantID, name string, value blobObject, expectedVersion string) (string, error) {
	metadata, err := encodeS3BlobMetadata(value.Metadata)
	if err != nil {
		return "", err
	}
	request, err := s.request(ctx, http.MethodPut, tenantID, name, value.Data, value.Metadata.ContentType)
	if err != nil {
		return "", err
	}
	request.Header.Set(s3BlobMetadataHeader, metadata)
	if expectedVersion == blobVersionAbsent {
		request.Header.Set("If-None-Match", "*")
	} else if expectedVersion != "" {
		request.Header.Set("If-Match", expectedVersion)
	}
	s.sign(request, value.Data)
	response, err := s.client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusPreconditionFailed || response.StatusCode == http.StatusConflict {
		return "", errBlobObjectConflict
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", fmt.Errorf("S3 put failed with status %d", response.StatusCode)
	}
	version := response.Header.Get("ETag")
	if version == "" {
		return "", errors.New("S3 blob version is missing")
	}
	return version, nil
}

func (s *s3BlobObjectStore) Delete(ctx context.Context, tenantID, name, expectedVersion string) error {
	request, err := s.request(ctx, http.MethodDelete, tenantID, name, nil, "")
	if err != nil {
		return err
	}
	if expectedVersion != "" {
		request.Header.Set("If-Match", expectedVersion)
	}
	s.sign(request, nil)
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
	return fmt.Errorf("S3 delete failed with status %d", response.StatusCode)
}

func (s *s3BlobObjectStore) request(ctx context.Context, method, tenantID, name string, body []byte, contentType string) (*http.Request, error) {
	tenantHash := sha256.Sum256([]byte(tenantID))
	objectPath := path.Join(s.endpoint.Path, s.bucket, s.prefix, "tenants", hex.EncodeToString(tenantHash[:]), name)
	endpoint := *s.endpoint
	endpoint.Path = objectPath
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	s.sign(request, body)
	return request, nil
}

func (s *s3BlobObjectStore) sign(request *http.Request, body []byte) {
	request.Header.Del("Authorization")
	now := s.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	payloadHash := sha256.Sum256(body)
	payloadHex := hex.EncodeToString(payloadHash[:])
	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Content-Sha256", payloadHex)
	if s.sessionToken != "" {
		request.Header.Set("X-Amz-Security-Token", s.sessionToken)
	}
	request.Host = request.URL.Host
	canonicalHeaders, signedHeaders := canonicalS3Headers(request)
	canonicalRequest := strings.Join([]string{
		request.Method,
		request.URL.EscapedPath(),
		canonicalS3Query(request.URL.Query()),
		canonicalHeaders,
		signedHeaders,
		payloadHex,
	}, "\n")
	canonicalHash := sha256.Sum256([]byte(canonicalRequest))
	scope := date + "/" + s.region + "/s3/aws4_request"
	stringToSign := "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + hex.EncodeToString(canonicalHash[:])
	dateKey := hmacSHA256([]byte("AWS4"+s.secretAccessKey), date)
	regionKey := hmacSHA256(dateKey, s.region)
	serviceKey := hmacSHA256(regionKey, "s3")
	signingKey := hmacSHA256(serviceKey, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(signingKey, stringToSign))
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.accessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
}

func canonicalS3Headers(request *http.Request) (string, string) {
	values := map[string]string{"host": request.Host}
	for name, items := range request.Header {
		lower := strings.ToLower(name)
		if lower == "authorization" || lower == "user-agent" || lower == "content-length" {
			continue
		}
		parts := make([]string, len(items))
		for index, value := range items {
			parts[index] = strings.Join(strings.Fields(value), " ")
		}
		values[lower] = strings.Join(parts, ",")
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var canonical strings.Builder
	for _, key := range keys {
		canonical.WriteString(key)
		canonical.WriteByte(':')
		canonical.WriteString(values[key])
		canonical.WriteByte('\n')
	}
	return canonical.String(), strings.Join(keys, ";")
}

func canonicalS3Query(values url.Values) string {
	return values.Encode()
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func encodeS3BlobMetadata(metadata blobMetadata) (string, error) {
	value, err := json.Marshal(metadata)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func decodeS3BlobMetadata(value string) (blobMetadata, error) {
	if value == "" {
		return blobMetadata{}, errors.New("S3 blob metadata is missing")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(decoded) > 16<<10 {
		return blobMetadata{}, errors.New("S3 blob metadata is invalid")
	}
	metadata := blobMetadata{}
	if json.Unmarshal(decoded, &metadata) != nil || !allowedBlobMediaType(metadata.ContentType) {
		return blobMetadata{}, errors.New("S3 blob metadata is invalid")
	}
	return metadata, nil
}
