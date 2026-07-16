package store

import (
	"context"
	"errors"
)

var ErrNotFound = errors.New("not found")

type ProjectSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
}

type Store interface {
	Close()
	Ping(context.Context) error
	ListProjects(context.Context) ([]ProjectSummary, error)
	GetProject(context.Context, string) ([]byte, error)
	PutProject(context.Context, string, []byte) error
	DeleteProject(context.Context, string) error
	GetState(context.Context, string) ([]byte, error)
	PutState(context.Context, string, []byte) error
}
