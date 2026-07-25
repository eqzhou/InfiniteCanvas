package api

import (
	"context"
	"errors"
)

var (
	errBlobObjectConflict      = errors.New("blob object version conflict")
	errBlobObjectTooLarge      = errors.New("blob object exceeds size limit")
	errInvalidBlobObjectConfig = errors.New("invalid blob object storage configuration")
)

const blobVersionAbsent = "__openboard_absent__"

// blobObjectStore is the narrow, provider-neutral boundary used by protected
// tenant media. Implementations must make each Put atomically visible and use
// expectedVersion as a compare-and-swap precondition. An empty expectedVersion
// permits an unconditional write; blobVersionAbsent requires creation.
type blobObjectStore interface {
	Kind() string
	Ping(context.Context) error
	Get(ctx context.Context, tenantID, name string, limit int64) (blobObject, error)
	Put(ctx context.Context, tenantID, name string, value blobObject, expectedVersion string) (string, error)
	Delete(ctx context.Context, tenantID, name, expectedVersion string) error
}

type blobObject struct {
	Data     []byte
	Metadata blobMetadata
	Version  string
}
