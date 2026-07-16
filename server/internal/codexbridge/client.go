package codexbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

const maxMessageBytes = 8 << 20

type Notification struct {
	Method string
	Params json.RawMessage
}

type ServerRequest struct {
	ID     json.RawMessage
	Method string
	Params json.RawMessage
}

type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("app-server RPC %d: %s", e.Code, e.Message) }

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *RPCError       `json:"error"`
	err    error
}

type Client struct {
	reader io.Reader
	writer io.Writer
	closer io.Closer

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[int]chan rpcResponse

	notifications chan Notification
	requests      chan ServerRequest
	done          chan struct{}
	finishOnce    sync.Once
	transportOnce sync.Once
}

func NewClient(reader io.Reader, writer io.Writer) *Client {
	client := &Client{
		reader:        reader,
		writer:        writer,
		pending:       make(map[int]chan rpcResponse),
		notifications: make(chan Notification, 256),
		requests:      make(chan ServerRequest, 64),
		done:          make(chan struct{}),
	}
	if closer, ok := reader.(io.Closer); ok {
		client.closer = closer
	}
	go client.readLoop()
	return client
}

func (c *Client) Notifications() <-chan Notification { return c.notifications }
func (c *Client) Requests() <-chan ServerRequest     { return c.requests }

func (c *Client) Call(ctx context.Context, method string, params any, destination any) error {
	if method == "" {
		return errors.New("app-server method is required")
	}
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	response := make(chan rpcResponse, 1)
	c.pending[id] = response
	c.mu.Unlock()

	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := c.writeJSON(ctx, request); err != nil {
		c.removePending(id)
		return err
	}

	select {
	case result := <-response:
		if result.err != nil {
			return result.err
		}
		if result.Error != nil {
			return result.Error
		}
		if destination == nil || len(result.Result) == 0 || string(result.Result) == "null" {
			return nil
		}
		if err := json.Unmarshal(result.Result, destination); err != nil {
			return fmt.Errorf("decode app-server response: %w", err)
		}
		return nil
	case <-ctx.Done():
		c.removePending(id)
		return ctx.Err()
	case <-c.done:
		return errors.New("app-server connection closed")
	}
}

// Notify sends a JSON-RPC notification without waiting for a response.
func (c *Client) Notify(ctx context.Context, method string, params any) error {
	if method == "" {
		return errors.New("app-server method is required")
	}
	return c.writeJSON(ctx, map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *Client) Respond(ctx context.Context, id json.RawMessage, result any, rpcErr *RPCError) error {
	if len(id) == 0 {
		return errors.New("app-server request id is required")
	}
	response := map[string]any{"jsonrpc": "2.0", "id": id}
	if rpcErr != nil {
		response["error"] = rpcErr
	} else {
		response["result"] = result
	}
	return c.writeJSON(ctx, response)
}

func (c *Client) Close() error {
	var closeErr error
	c.transportOnce.Do(func() {
		if c.closer != nil {
			closeErr = c.closer.Close()
		}
	})
	c.finish(errors.New("app-server connection closed"))
	return closeErr
}

func (c *Client) writeJSON(ctx context.Context, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode app-server message: %w", err)
	}
	if len(encoded) > maxMessageBytes {
		return errors.New("app-server message exceeds size limit")
	}
	encoded = append(encoded, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-c.done:
		return errors.New("app-server connection closed")
	default:
	}
	if _, err := c.writer.Write(encoded); err != nil {
		return fmt.Errorf("write app-server message: %w", err)
	}
	return nil
}

func (c *Client) readLoop() {
	scanner := bufio.NewScanner(c.reader)
	scanner.Buffer(make([]byte, 64*1024), maxMessageBytes)
	for scanner.Scan() {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *RPCError       `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			c.finish(fmt.Errorf("decode app-server message: %w", err))
			return
		}
		if message.Method != "" {
			if len(message.ID) > 0 && string(message.ID) != "null" {
				select {
				case c.requests <- ServerRequest{ID: message.ID, Method: message.Method, Params: message.Params}:
				case <-c.done:
					return
				}
			} else {
				select {
				case c.notifications <- Notification{Method: message.Method, Params: message.Params}:
				case <-c.done:
					return
				}
			}
			continue
		}
		var id int
		if err := json.Unmarshal(message.ID, &id); err != nil {
			continue
		}
		c.mu.Lock()
		pending := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if pending != nil {
			pending <- rpcResponse{Result: message.Result, Error: message.Error}
		}
	}
	err := scanner.Err()
	if err == nil {
		err = io.EOF
	}
	c.finish(err)
}

func (c *Client) removePending(id int) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) finish(err error) {
	c.finishOnce.Do(func() {
		close(c.done)
		c.mu.Lock()
		pending := c.pending
		c.pending = make(map[int]chan rpcResponse)
		c.mu.Unlock()
		for _, waiter := range pending {
			waiter <- rpcResponse{err: err}
		}
	})
}
