// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestShouldManageCodex(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "new session", args: nil, want: true},
		{name: "prompt", args: []string{"fix this"}, want: true},
		{name: "prompt named exec after delimiter", args: []string{"--", "exec"}, want: true},
		{name: "prompt named help flag after delimiter", args: []string{"--", "--help"}, want: true},
		{name: "resume picker", args: []string{"resume"}, want: true},
		{name: "resume id", args: []string{"resume", "0190-id"}, want: true},
		{name: "resume argument named review", args: []string{"resume", "review"}, want: true},
		{name: "fork", args: []string{"fork", "--last"}, want: true},
		{name: "global option before resume", args: []string{"--model", "gpt-5.4", "resume", "--last"}, want: true},
		{name: "global option value named exec", args: []string{"--profile", "exec", "resume"}, want: true},
		{name: "exec", args: []string{"exec", "fix this"}, want: false},
		{name: "apply alias", args: []string{"a"}, want: false},
		{name: "option before exec", args: []string{"--model=gpt-5.4", "exec", "fix this"}, want: false},
		{name: "login", args: []string{"login"}, want: false},
		{name: "explicit remote", args: []string{"--remote", "ws://example.test", "resume"}, want: false},
		{name: "version", args: []string{"--version"}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldManageCodex(test.args); got != test.want {
				t.Fatalf("shouldManageCodex(%q) = %v, want %v", test.args, got, test.want)
			}
		})
	}
}

func TestCodexBlockNameUsesTerminalRename(t *testing.T) {
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_FrameText:   "  Renamed terminal  ",
		waveobj.MetaKey_FrameTitle:  "Frame title",
		waveobj.MetaKey_DisplayName: "Display name",
	}
	if got := codexBlockName(meta); got != "Renamed terminal" {
		t.Fatalf("block name = %q", got)
	}
}

func TestBoundedLogBufferKeepsTail(t *testing.T) {
	buffer := &boundedLogBuffer{limit: 5}
	_, _ = buffer.Write([]byte("abc"))
	_, _ = buffer.Write([]byte("def"))
	if got := buffer.String(); got != "bcdef" {
		t.Fatalf("log tail = %q", got)
	}
}

func TestFindWindowsNpmCodexNative(t *testing.T) {
	entrypoint := filepath.Join(t.TempDir(), "node_modules", "@openai", "codex", "bin", "codex.js")
	nativePath := filepath.Join(
		filepath.Dir(filepath.Dir(entrypoint)),
		"node_modules",
		"@openai",
		"codex-win32-x64",
		"vendor",
		"x86_64-pc-windows-msvc",
		"bin",
		"codex.exe",
	)
	if err := os.MkdirAll(filepath.Dir(nativePath), 0o755); err != nil {
		t.Fatalf("create native package: %v", err)
	}
	if err := os.WriteFile(nativePath, []byte("test"), 0o755); err != nil {
		t.Fatalf("create native executable: %v", err)
	}
	if got := findWindowsNpmCodexNative(entrypoint, "amd64"); got != nativePath {
		t.Fatalf("native Codex path = %q, want %q", got, nativePath)
	}
	if got := findWindowsNpmCodexNative(entrypoint, "386"); got != "" {
		t.Fatalf("unsupported architecture returned %q", got)
	}
}

func TestMakeCodexActionRequestPreservesText(t *testing.T) {
	request, err := makeCodexActionRequest(wshrpc.CodexSessionAction{
		ActionId: "action-1",
		Kind:     "turn/steer",
		ThreadId: "thread-1",
		TurnId:   "turn-1",
		Text:     "好的 \"quoted\"\nsecond line",
	})
	if err != nil {
		t.Fatalf("make request: %v", err)
	}
	var decoded struct {
		Method string `json:"method"`
		Params struct {
			ExpectedTurnId string `json:"expectedTurnId"`
			Input          []struct {
				Text string `json:"text"`
			} `json:"input"`
		} `json:"params"`
	}
	if err := json.Unmarshal(request, &decoded); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if decoded.Method != "turn/steer" || decoded.Params.ExpectedTurnId != "turn-1" ||
		len(decoded.Params.Input) != 1 || decoded.Params.Input[0].Text != "好的 \"quoted\"\nsecond line" {
		t.Fatalf("unexpected request: %s", request)
	}
}

func TestParseCodexDeltaReportPreservesActivityMetadata(t *testing.T) {
	summaryIndex := 2
	tests := []struct {
		name        string
		method      string
		params      string
		wantKey     string
		wantDelta   string
		wantSummary *int
	}{
		{
			name:      "agent message",
			method:    "item/agentMessage/delta",
			params:    `{"threadId":"thread-1","turnId":"turn-1","itemId":"agent-1","delta":"hello"}`,
			wantKey:   "item/agentMessage/delta\x00agent-1",
			wantDelta: "hello",
		},
		{
			name:        "reasoning summary segment",
			method:      "item/reasoning/summaryTextDelta",
			params:      `{"threadId":"thread-1","turnId":"turn-1","itemId":"reason-1","summaryIndex":2,"delta":"inspect"}`,
			wantKey:     "item/reasoning/summaryTextDelta\x00reason-1\x002",
			wantDelta:   "inspect",
			wantSummary: &summaryIndex,
		},
		{
			name:      "command output",
			method:    "item/commandExecution/outputDelta",
			params:    `{"threadId":"thread-1","turnId":"turn-1","itemId":"command-1","delta":"ok\n"}`,
			wantKey:   "item/commandExecution/outputDelta\x00command-1",
			wantDelta: "ok\n",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report, key, ok := parseCodexDeltaReport(bridgeReport{
				kind: "notification",
				data: `{"method":` + mustJSON(t, test.method) + `,"params":` + test.params + `}`,
			})
			if !ok {
				t.Fatal("activity delta was not recognized")
			}
			if report.Method != test.method || report.ItemId == "" ||
				report.Delta != test.wantDelta || key != test.wantKey {
				t.Fatalf("unexpected delta report: %#v, key %q", report, key)
			}
			if test.wantSummary == nil {
				if report.SummaryIndex != nil {
					t.Fatalf("unexpected summary index: %d", *report.SummaryIndex)
				}
			} else if report.SummaryIndex == nil || *report.SummaryIndex != *test.wantSummary {
				t.Fatalf("summary index = %v, want %d", report.SummaryIndex, *test.wantSummary)
			}
		})
	}

	if _, _, ok := parseCodexDeltaReport(bridgeReport{
		kind: "notification",
		data: `{"method":"item/reasoning/textDelta","params":{"itemId":"reason-1","delta":"private"}}`,
	}); ok {
		t.Fatal("raw reasoning delta must not be exposed")
	}
}

func TestShouldReportCodexActivityNotifications(t *testing.T) {
	reported := []string{
		"item/started",
		"item/completed",
		"item/reasoning/summaryTextDelta",
		"item/commandExecution/outputDelta",
		"item/fileChange/patchUpdated",
		"item/mcpToolCall/progress",
	}
	for _, method := range reported {
		if !shouldReportCodexNotification(method) {
			t.Fatalf("%s notification was not reported", method)
		}
	}
	if shouldReportCodexNotification("item/reasoning/textDelta") {
		t.Fatal("raw reasoning notification must not be reported")
	}
}

func TestProxyCapturesThreadSnapshotAndConsumesWebResponse(t *testing.T) {
	bridge := &codexBridge{
		reports: make(chan bridgeReport, 2),
		done:    make(chan struct{}),
	}
	pollStarted := make(chan struct{}, 1)
	proxy := &codexProxy{
		bridge:        bridge,
		tuiRequests:   map[string]string{"0": "thread/list", "1": "thread/resume"},
		webRequestIds: map[string]struct{}{`"wave-web:1"`: {}},
		pollFn: func() {
			pollStarted <- struct{}{}
		},
	}
	if consumed := proxy.observeServerMessage([]byte(`{"jsonrpc":"2.0","id":0,"result":{"data":[]}}`)); consumed {
		t.Fatalf("TUI picker response must be forwarded")
	}
	select {
	case <-pollStarted:
		t.Fatal("picker request must not start Web action polling")
	default:
	}
	if consumed := proxy.observeServerMessage([]byte(`{"jsonrpc":"2.0","id":1,"result":{"thread":{"id":"thread-1"}}}`)); consumed {
		t.Fatalf("TUI lifecycle response must be forwarded")
	}
	select {
	case <-pollStarted:
	case <-time.After(time.Second):
		t.Fatal("thread lifecycle response did not start Web action polling")
	}
	report := <-bridge.reports
	if report.kind != "snapshot" {
		t.Fatalf("unexpected report: %#v", report)
	}
	if consumed := proxy.observeServerMessage([]byte(`{"jsonrpc":"2.0","id":"wave-web:1","result":{"turn":{"id":"turn-1"}}}`)); !consumed {
		t.Fatalf("Web response must be consumed by the proxy")
	}
	userNotification := []byte(`{"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"user-1","type":"userMessage","content":[{"type":"text","text":"from web"}]}}}`)
	if consumed := proxy.observeServerMessage(userNotification); consumed {
		t.Fatal("Web user-message notification must be forwarded to the desktop TUI")
	}
	report = <-bridge.reports
	if report.kind != "notification" || report.data != string(userNotification) {
		t.Fatalf("Web user message was not reported to the registry: %#v", report)
	}
}

func TestCodexProxyHostAcceptsSequentialConnections(t *testing.T) {
	var upstreamConnections atomic.Int32
	upstreamUpgrader := websocket.Upgrader{CheckOrigin: func(_ *http.Request) bool { return true }}
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upstreamUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		upstreamConnections.Add(1)
		for {
			messageType, message, readErr := connection.ReadMessage()
			if readErr != nil {
				return
			}
			if writeErr := connection.WriteMessage(messageType, message); writeErr != nil {
				return
			}
		}
	}))
	defer upstreamServer.Close()

	bridge := &codexBridge{
		reports: make(chan bridgeReport, 2),
		done:    make(chan struct{}),
	}
	host := newCodexProxyHost(bridge, "ws"+strings.TrimPrefix(upstreamServer.URL, "http"))
	defer host.Close()
	proxyServer := httptest.NewServer(host)
	defer proxyServer.Close()
	proxyURL := "ws" + strings.TrimPrefix(proxyServer.URL, "http")

	connectAndEcho := func(payload string) {
		t.Helper()
		connection, _, err := websocket.DefaultDialer.Dial(proxyURL, nil)
		if err != nil {
			t.Fatalf("connect proxy: %v", err)
		}
		if err := connection.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
			connection.Close()
			t.Fatalf("write proxy: %v", err)
		}
		_, response, err := connection.ReadMessage()
		if err != nil {
			connection.Close()
			t.Fatalf("read proxy: %v", err)
		}
		if string(response) != payload {
			connection.Close()
			t.Fatalf("proxy response = %q, want %q", response, payload)
		}
		if err := connection.Close(); err != nil {
			t.Fatalf("close proxy connection: %v", err)
		}
	}

	connectAndEcho("picker")
	connectAndEcho("thread")
	if got := upstreamConnections.Load(); got != 2 {
		t.Fatalf("upstream connections = %d, want 2", got)
	}
}

func TestCodexAppServerLifecycle(t *testing.T) {
	if os.Getenv("WAVE_CODEX_INTEGRATION") == "" {
		t.Skip("set WAVE_CODEX_INTEGRATION=1 to test the installed Codex app-server")
	}
	t.Setenv("CODEX_HOME", t.TempDir())
	executable, err := findCodexExecutable()
	if err != nil {
		t.Fatalf("find Codex: %v", err)
	}
	endpoint, child, done, err := startCodexAppServer(executable)
	if err != nil {
		t.Fatalf("start app-server: %v", err)
	}
	defer stopChildProcess(child, done)
	connection, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatalf("connect app-server: %v", err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(30 * time.Second))
	if err := connection.WriteJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"clientInfo": map[string]string{"name": "wave-integration-test", "version": "1"},
		},
	}); err != nil {
		t.Fatalf("initialize write: %v", err)
	}
	readResponseId(t, connection, "1")
	if err := connection.WriteJSON(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}}); err != nil {
		t.Fatalf("initialized write: %v", err)
	}
	if err := connection.WriteJSON(map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "thread/start",
		"params":  map[string]any{"cwd": t.TempDir(), "ephemeral": true},
	}); err != nil {
		t.Fatalf("thread start write: %v", err)
	}
	response := readResponseId(t, connection, "2")
	var payload struct {
		Result struct {
			Thread struct {
				Id string `json:"id"`
			} `json:"thread"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(response, &payload); err != nil {
		t.Fatalf("decode thread response: %v", err)
	}
	if len(payload.Error) != 0 && string(payload.Error) != "null" {
		t.Fatalf("thread/start error: %s", payload.Error)
	}
	if payload.Result.Thread.Id == "" {
		t.Fatalf("thread/start returned no thread id: %s", response)
	}
}

func mustJSON(t *testing.T, value string) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal test value: %v", err)
	}
	return string(data)
}

func readResponseId(t *testing.T, connection *websocket.Conn, wanted string) []byte {
	t.Helper()
	for {
		_, message, err := connection.ReadMessage()
		if err != nil {
			t.Fatalf("read app-server response %s: %v", wanted, err)
		}
		var envelope rpcEnvelope
		if json.Unmarshal(message, &envelope) == nil && requestIdKey(envelope.Id) == wanted {
			return message
		}
	}
}
