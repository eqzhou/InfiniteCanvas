package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// KIE caps consecutive poll retries; APIMart shares the same retry predicate and
// the same poll loop, so it must cap them too. Without a cap a provider that
// keeps answering 503 is hammered for the entire maxDuration window instead of
// failing fast, which both amplifies load on an already-throttled upstream and
// hides the error from the user until the deadline expires.
func TestAPIMartVideoPollRetriesAreBounded(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/videos/generations":
			_, _ = io.WriteString(w, `{"code":200,"data":{"task_id":"task_retry"}}`)
		case "/v1/tasks/task_retry":
			polls.Add(1)
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	_, err := executor.Generate(context.Background(), videoGenerationRequest{
		Protocol: "apimart", BaseURL: server.URL, APIKey: "token", Model: "kling-v3", Prompt: "move",
		Mode: "std", Seconds: 5, Ratio: "16:9",
	}, nil, func(videoProviderCheckpoint) error { return nil })

	if err == nil {
		t.Fatal("expected the poll loop to surface the upstream failure")
	}
	if got := polls.Load(); got != apimartMaxConsecutivePollRetries+1 {
		t.Fatalf("polls = %d, want %d (bounded retries)", got, apimartMaxConsecutivePollRetries+1)
	}
}

func TestAPIMartVideoRetryBudgetResetsAfterSuccessfulPoll(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/videos/generations":
			_, _ = io.WriteString(w, `{"code":200,"data":{"task_id":"task_retry_reset"}}`)
		case "/v1/tasks/task_retry_reset":
			poll := polls.Add(1)
			switch poll {
			case 3:
				// A successful pending response starts a fresh retry streak.
				_, _ = io.WriteString(w, `{"code":200,"data":{"status":"processing"}}`)
			default:
				w.WriteHeader(http.StatusServiceUnavailable)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	executor := newHTTPVideoExecutor()
	executor.client = server.Client()
	executor.pollInterval = 0
	executor.maxDuration = time.Second
	_, err := executor.Generate(context.Background(), videoGenerationRequest{
		Protocol: "apimart", BaseURL: server.URL, APIKey: "token", Model: "kling-v3", Prompt: "move",
		Mode: "std", Seconds: 5, Ratio: "16:9",
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil {
		t.Fatal("expected the fourth post-success failure to exhaust the reset retry budget")
	}
	if got := polls.Load(); got != 7 {
		t.Fatalf("polls = %d, want 7 after two retry streaks", got)
	}
}

func TestAPIMartImageRetryBudgetResetsAfterSuccessfulPoll(t *testing.T) {
	var polls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			_, _ = io.WriteString(w, `{"code":200,"data":[{"task_id":"task_image_retry_reset"}]}`)
		case "/v1/tasks/task_image_retry_reset":
			poll := polls.Add(1)
			if poll == 3 {
				_, _ = io.WriteString(w, `{"code":200,"data":{"status":"processing"}}`)
				return
			}
			w.WriteHeader(http.StatusServiceUnavailable)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	executor := newOpenAIImageExecutor()
	executor.client = server.Client()
	executor.apimartPollInterval = 0
	executor.apimartMaxDuration = time.Second
	_, err := executor.GenerateResumable(context.Background(), imageGenerationRequest{
		Protocol: "apimart", BaseURL: server.URL, APIKey: "token", Model: "gpt-image-1-official",
		Prompt: "draw", Size: "1:1", Quality: "auto", Count: 1,
	}, nil, func(videoProviderCheckpoint) error { return nil })
	if err == nil {
		t.Fatal("expected the fourth post-success failure to exhaust the reset retry budget")
	}
	if got := polls.Load(); got != 7 {
		t.Fatalf("polls = %d, want 7 after two retry streaks", got)
	}
}
