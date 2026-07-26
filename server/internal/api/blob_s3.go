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
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
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

// s3PutRequestTrace is allocated per PUT. A request is safe to route to a
// different provider only when the transport failed before it acquired a
// connection and before it reported writing any request bytes. This includes
// DNS, dial, and TLS-handshake failures. Once a connection is acquired we stay
// conservative: a reused connection can fail while writing without every
// write callback being observable to the caller.
type s3PutRequestTrace struct {
	gotConn      atomic.Bool
	wroteHeaders atomic.Bool
	wroteRequest atomic.Bool
}

func (t *s3PutRequestTrace) clientTrace() *httptrace.ClientTrace {
	return &httptrace.ClientTrace{
		GotConn:      func(httptrace.GotConnInfo) { t.gotConn.Store(true) },
		WroteHeaders: func() { t.wroteHeaders.Store(true) },
		WroteRequest: func(httptrace.WroteRequestInfo) { t.wroteRequest.Store(true) },
	}
}

func (t *s3PutRequestTrace) definitelyFailedBeforeWrite() bool {
	return !t.gotConn.Load() && !t.wroteHeaders.Load() && !t.wroteRequest.Load()
}

var blockedS3Networks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("224.0.0.0/4"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("::/128"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
	netip.MustParsePrefix("ff00::/8"),
}

func safeS3IP(ip net.IP, allowLoopback bool) bool {
	if ip.IsLoopback() {
		return allowLoopback
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	for _, blocked := range blockedS3Networks {
		if blocked.Contains(address) {
			return false
		}
	}
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast()
}

type s3LookupIPFunc func(context.Context, string, string) ([]net.IP, error)
type s3DialContextFunc func(context.Context, string, string) (net.Conn, error)

// safeS3DialContext resolves once, validates every answer, then dials a
// validated address directly. This prevents a second DNS lookup from rebinding
// the endpoint after validation.
func safeS3DialContext(loopbackOnly bool, lookupIP s3LookupIPFunc, dialContext s3DialContextFunc) s3DialContextFunc {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, fmt.Errorf("invalid S3 address: %w", err)
		}
		addresses := []net.IP{net.ParseIP(host)}
		if addresses[0] == nil {
			addresses, err = lookupIP(ctx, "ip", host)
			if err != nil {
				return nil, fmt.Errorf("failed to resolve S3 endpoint: %w", err)
			}
			if len(addresses) == 0 {
				return nil, errors.New("S3 endpoint resolved without addresses")
			}
		}
		for _, ip := range addresses {
			if (loopbackOnly && !ip.IsLoopback()) || (!loopbackOnly && !safeS3IP(ip, false)) {
				return nil, errors.New("S3 endpoint resolved to a blocked address")
			}
		}
		var lastErr error
		for _, ip := range addresses {
			connection, dialErr := dialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if dialErr == nil {
				return connection, nil
			}
			lastErr = dialErr
		}
		if lastErr == nil {
			lastErr = errors.New("failed to connect to S3 endpoint")
		}
		return nil, lastErr
	}
}

func newS3BlobObjectStore(config S3BlobStorageConfig) (*s3BlobObjectStore, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Host == "" || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.User != nil ||
		(endpoint.Scheme != "https" && endpoint.Scheme != "http") {
		return nil, errInvalidBlobObjectConfig
	}
	// Normalize trailing slashes so equivalent endpoints produce one stable
	// destination fingerprint (rebind protection) and one request base path.
	endpoint.Path = strings.TrimRight(endpoint.Path, "/")
	endpoint.RawPath = ""
	host := endpoint.Hostname()
	ip := net.ParseIP(host)
	allowLoopback := endpoint.Scheme == "http" && config.AllowInsecureLoopback &&
		(strings.EqualFold(host, "localhost") || (ip != nil && ip.IsLoopback()))
	if endpoint.Scheme == "http" && !allowLoopback {
		return nil, errInvalidBlobObjectConfig
	}
	if endpoint.Scheme == "https" && (strings.EqualFold(host, "localhost") || (ip != nil && !safeS3IP(ip, false))) {
		return nil, errInvalidBlobObjectConfig
	}
	if ip != nil && !safeS3IP(ip, allowLoopback) {
		if !(allowLoopback && ip.IsLoopback()) {
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
	baseTransport := http.DefaultTransport.(*http.Transport).Clone()
	if config.HTTPClient != nil {
		copy := *config.HTTPClient
		client = &copy
		if client.Timeout <= 0 || client.Timeout > 70*time.Second {
			client.Timeout = 70 * time.Second
		}
		if client.Transport != nil {
			transport, ok := client.Transport.(*http.Transport)
			if !ok {
				return nil, errInvalidBlobObjectConfig
			}
			baseTransport = transport.Clone()
		}
	}
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	baseTransport.Proxy = nil
	baseTransport.DialContext = safeS3DialContext(allowLoopback, net.DefaultResolver.LookupIP, dialer.DialContext)
	baseTransport.DialTLSContext = nil
	client.Transport = baseTransport
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
	// Standard S3 has no permission-neutral health operation. Bucket HEAD/LIST
	// can return 403 for valid credentials intentionally scoped to object paths.
	return ctx.Err()
}

func (s *s3BlobObjectStore) Health(context.Context) blobStorageHealthState {
	return blobStorageHealthUnknown
}

// The S3 API has no portable bucket-capacity operation. Providers that expose
// proprietary quota APIs can implement capacity at a higher adapter layer.
func (s *s3BlobObjectStore) Capacity(context.Context) (blobStorageCapacity, error) {
	return blobStorageCapacity{}, errBlobStorageCapacityUnknown
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
