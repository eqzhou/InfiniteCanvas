package codexbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"
)

func TestClientCallAndNotification(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := NewClient(clientConn, clientConn)
	t.Cleanup(func() { _ = client.Close() })

	go func() {
		line, err := bufio.NewReader(serverConn).ReadBytes('\n')
		if err != nil {
			t.Errorf("read request: %v", err)
			return
		}
		var request struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(line, &request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if request.Method != "thread/start" || request.Params["cwd"] != "/tmp/board" {
			t.Errorf("unexpected request: %#v", request)
			return
		}
		_, _ = serverConn.Write([]byte(`{"method":"thread/started","params":{"thread":{"id":"thread-1"}}}` + "\n"))
		_, _ = serverConn.Write([]byte(`{"id":` + jsonNumber(request.ID) + `,"result":{"thread":{"id":"thread-1"}}}` + "\n"))
	}()

	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := client.Call(context.Background(), "thread/start", map[string]any{"cwd": "/tmp/board"}, &result); err != nil {
		t.Fatal(err)
	}
	if result.Thread.ID != "thread-1" {
		t.Fatalf("thread id = %q", result.Thread.ID)
	}
	select {
	case notification := <-client.Notifications():
		if notification.Method != "thread/started" {
			t.Fatalf("notification method = %q", notification.Method)
		}
	case <-time.After(time.Second):
		t.Fatal("notification was not delivered")
	}
}

func TestClientReceivesAndRespondsToServerRequest(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	client := NewClient(clientConn, clientConn)
	t.Cleanup(func() { _ = client.Close() })

	responseLines := make(chan []byte, 1)
	go func() {
		_, _ = serverConn.Write([]byte(`{"id":"approval-1","method":"item/tool/call","params":{"tool":"board.add_node"}}` + "\n"))
		_ = serverConn.SetReadDeadline(time.Now().Add(time.Second))
		line, err := bufio.NewReader(serverConn).ReadBytes('\n')
		if err != nil {
			t.Errorf("read response: %v", err)
			return
		}
		responseLines <- line
	}()

	select {
	case request := <-client.Requests():
		if request.Method != "item/tool/call" || string(request.ID) != `"approval-1"` {
			t.Fatalf("unexpected request: %#v", request)
		}
		if err := client.Respond(context.Background(), request.ID, map[string]any{"success": false}, nil); err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("server request was not delivered")
	}

	line := <-responseLines
	var response struct {
		ID     string         `json:"id"`
		Result map[string]any `json:"result"`
	}
	if err := json.Unmarshal(line, &response); err != nil {
		t.Fatal(err)
	}
	if response.ID != "approval-1" || response.Result["success"] != false {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func jsonNumber(value int) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
