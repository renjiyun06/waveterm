// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package codexremote

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func registerTestSession(t *testing.T, registry *Registry) {
	t.Helper()
	err := registry.Register(wshrpc.CodexSessionRegisterData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Cwd:      "/work/project",
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
}

func TestSnapshotAndNotificationsBuildChat(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	snapshot := `{
		"thread": {
			"id": "thread-1",
			"name": "Wave work",
			"preview": "hello",
			"cwd": "/work/project",
			"status": {"type": "idle"},
			"turns": [{
				"id": "turn-1",
				"status": "completed",
				"startedAt": 1700000000,
				"items": [
					{"id": "user-1", "type": "userMessage", "content": [{"type": "text", "text": "hello"}]},
					{"id": "agent-1", "type": "agentMessage", "text": "hi"}
				]
			}]
		},
		"cwd": "/work/project"
	}`
	err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "snapshot",
		Data:     snapshot,
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	err = registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "notification",
		Data:     `{"method":"item/agentMessage/delta","params":{"itemId":"agent-2","delta":"stream"}}`,
	})
	if err != nil {
		t.Fatalf("notification: %v", err)
	}
	session, ok := registry.Get("block-12345678")
	if !ok {
		t.Fatalf("session missing")
	}
	if session.ThreadId != "thread-1" || session.Title != "Wave work" {
		t.Fatalf("unexpected session metadata: %#v", session)
	}
	if len(session.Messages) != 3 || session.Messages[2].Text != "stream" {
		t.Fatalf("unexpected messages: %#v", session.Messages)
	}
}

func TestSubmitSelectsStartOrSteer(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "snapshot",
		Data:     `{"thread":{"id":"thread-1","cwd":"/work","preview":"","status":{"type":"idle"},"turns":[]}}`,
	}); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if err := registry.Submit("block-12345678", "first"); err != nil {
		t.Fatalf("submit: %v", err)
	}
	action, err := registry.Poll(context.Background(), wshrpc.CodexSessionPollData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
	})
	if err != nil || action.Kind != "turn/start" || action.Text != "first" {
		t.Fatalf("unexpected start action: %#v, %v", action, err)
	}
	if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "notification",
		Data:     `{"method":"turn/started","params":{"turn":{"id":"turn-2","status":"inProgress","items":[]}}}`,
	}); err != nil {
		t.Fatalf("turn started: %v", err)
	}
	if err := registry.Submit("block-12345678", "steer"); err != nil {
		t.Fatalf("steer submit: %v", err)
	}
	action, err = registry.Poll(context.Background(), wshrpc.CodexSessionPollData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
	})
	if err != nil || action.Kind != "turn/steer" || action.TurnId != "turn-2" {
		t.Fatalf("unexpected steer action: %#v, %v", action, err)
	}
}

func TestOldBridgeCannotRemoveReplacement(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	if err := registry.Register(wshrpc.CodexSessionRegisterData{
		BridgeId: "bridge-2",
		BlockId:  "block-12345678",
	}); err != nil {
		t.Fatalf("replacement register: %v", err)
	}
	_ = registry.Unregister(wshrpc.CodexSessionUnregisterData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
	})
	if _, ok := registry.Get("block-12345678"); !ok {
		t.Fatalf("old bridge removed replacement session")
	}
}

func TestBlockRenameWinsOverCodexThreadName(t *testing.T) {
	registry := NewRegistry()
	if err := registry.Register(wshrpc.CodexSessionRegisterData{
		BridgeId:  "bridge-1",
		BlockId:   "block-12345678",
		BlockName: "My terminal",
		Cwd:       "/work/project",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "snapshot",
		Data:     `{"thread":{"id":"thread-1","name":"Codex title","status":{"type":"idle"},"turns":[]}}`,
	}); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "notification",
		Data:     `{"method":"thread/name/updated","params":{"threadId":"thread-1","threadName":"New Codex title"}}`,
	}); err != nil {
		t.Fatalf("thread rename: %v", err)
	}
	session, ok := registry.Get("block-12345678")
	if !ok || session.Title != "My terminal" {
		t.Fatalf("renamed block title was not preserved: %#v", session)
	}
	registry.UpdateBlockName("block-12345678", "")
	session, ok = registry.Get("block-12345678")
	if !ok || session.Title != "New Codex title" {
		t.Fatalf("clearing block rename did not restore the Codex title: %#v", session)
	}
}

func TestEmptySessionMessagesEncodeAsArray(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	session, ok := registry.Get("block-12345678")
	if !ok {
		t.Fatal("session missing")
	}
	data, err := json.Marshal(session)
	if err != nil {
		t.Fatalf("marshal session: %v", err)
	}
	if !strings.Contains(string(data), `"messages":[]`) {
		t.Fatalf("empty messages encoded as null: %s", data)
	}
}

func TestSnapshotIncludesReasoningAndToolActivity(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	snapshot := `{
		"thread": {
			"id": "thread-activity",
			"status": {"type": "idle"},
			"turns": [{
				"id": "turn-activity",
				"status": "completed",
				"startedAt": 1700000000,
				"items": [
					{"id":"reason-1","type":"reasoning","summary":["检查仓库","运行测试"],"content":["raw reasoning must not be exposed"]},
					{"id":"command-1","type":"commandExecution","command":"go test ./...","cwd":"/work/project","status":"completed","aggregatedOutput":"ok","exitCode":0},
					{"id":"mcp-1","type":"mcpToolCall","server":"github","tool":"get_issue","status":"completed","arguments":{"number":42},"result":{"content":[{"type":"text","text":"done"}]}},
					{"id":"file-1","type":"fileChange","status":"completed","changes":[{"path":"main.go","kind":{"type":"update","move_path":null},"diff":"@@ changed"}]},
					{"id":"web-1","type":"webSearch","query":"Codex app server","action":{"type":"search","query":"Codex app server","queries":null}},
					{"id":"agent-1","type":"agentMessage","text":"完成"}
				]
			}]
		}
	}`
	if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
		BridgeId: "bridge-1",
		BlockId:  "block-12345678",
		Kind:     "snapshot",
		Data:     snapshot,
	}); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	session, ok := registry.Get("block-12345678")
	if !ok {
		t.Fatal("session missing")
	}
	if len(session.Messages) != 6 {
		t.Fatalf("timeline length = %d, want 6: %#v", len(session.Messages), session.Messages)
	}
	if session.Messages[0].Kind != "reasoning" ||
		session.Messages[0].Text != "检查仓库\n\n运行测试" ||
		strings.Contains(session.Messages[0].Text, "raw reasoning") {
		t.Fatalf("unexpected reasoning item: %#v", session.Messages[0])
	}
	if session.Messages[1].ToolType != "command" ||
		session.Messages[1].Output != "ok\n\n退出码: 0" {
		t.Fatalf("unexpected command item: %#v", session.Messages[1])
	}
	if session.Messages[2].ToolType != "mcp" ||
		!strings.Contains(session.Messages[2].Input, `"number": 42`) ||
		!strings.Contains(session.Messages[2].Output, `"done"`) {
		t.Fatalf("unexpected MCP item: %#v", session.Messages[2])
	}
	if session.Messages[3].ToolType != "file" ||
		!strings.Contains(session.Messages[3].Output, "@@ changed") {
		t.Fatalf("unexpected file item: %#v", session.Messages[3])
	}
	if session.Messages[4].ToolType != "web" || session.Messages[5].Kind != "message" {
		t.Fatalf("unexpected final timeline items: %#v", session.Messages[4:])
	}
}

func TestStreamingReasoningAndToolOutputUpdateTimeline(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	apply := func(notification string) {
		t.Helper()
		if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
			BridgeId: "bridge-1",
			BlockId:  "block-12345678",
			Kind:     "notification",
			Data:     notification,
		}); err != nil {
			t.Fatalf("notification: %v", err)
		}
	}
	apply(`{"method":"item/started","params":{"item":{"id":"reason-1","type":"reasoning","summary":[],"content":[]},"startedAtMs":1700000000000}}`)
	apply(`{"method":"item/reasoning/summaryTextDelta","params":{"itemId":"reason-1","summaryIndex":0,"delta":"先检查"}}`)
	apply(`{"method":"item/reasoning/summaryTextDelta","params":{"itemId":"reason-1","summaryIndex":1,"delta":"再修改"}}`)
	apply(`{"method":"item/completed","params":{"item":{"id":"reason-1","type":"reasoning","summary":["先检查","再修改"],"content":[]},"completedAtMs":1700000001000}}`)
	apply(`{"method":"item/started","params":{"item":{"id":"command-1","type":"commandExecution","command":"go test","cwd":"/work","status":"inProgress","aggregatedOutput":null},"startedAtMs":1700000002000}}`)
	apply(`{"method":"item/commandExecution/outputDelta","params":{"itemId":"command-1","delta":"ok\n"}}`)
	apply(`{"method":"item/completed","params":{"item":{"id":"command-1","type":"commandExecution","command":"go test","cwd":"/work","status":"completed","aggregatedOutput":"ok\n","exitCode":0},"completedAtMs":1700000003000}}`)

	session, ok := registry.Get("block-12345678")
	if !ok || len(session.Messages) != 2 {
		t.Fatalf("unexpected timeline: %#v", session.Messages)
	}
	if session.Messages[0].Text != "先检查\n\n再修改" || session.Messages[0].Status != "completed" {
		t.Fatalf("unexpected reasoning stream: %#v", session.Messages[0])
	}
	if session.Messages[1].Output != "ok\n\n退出码: 0" || session.Messages[1].Status != "completed" {
		t.Fatalf("unexpected command stream: %#v", session.Messages[1])
	}
}

func TestTurnPlanKeepsStructuredSteps(t *testing.T) {
	registry := NewRegistry()
	registerTestSession(t, registry)
	apply := func(plan string) {
		t.Helper()
		if err := registry.ApplyEvent(wshrpc.CodexSessionEventData{
			BridgeId: "bridge-1",
			BlockId:  "block-12345678",
			Kind:     "notification",
			Data:     `{"method":"turn/plan/updated","params":{"turnId":"turn-1","explanation":"先验证再修改","plan":` + plan + `}}`,
		}); err != nil {
			t.Fatalf("plan update: %v", err)
		}
	}

	apply(`[{"step":"检查事件","status":"completed"},{"step":"调整界面","status":"inProgress"},{"step":"运行测试","status":"pending"}]`)
	session, ok := registry.Get("block-12345678")
	if !ok || len(session.Messages) != 1 {
		t.Fatalf("unexpected plan timeline: %#v", session.Messages)
	}
	message := session.Messages[0]
	if message.Kind != "plan" || message.Text != "先验证再修改" || message.Status != "streaming" {
		t.Fatalf("unexpected plan message: %#v", message)
	}
	if len(message.Plan) != 3 ||
		message.Plan[0].Status != "completed" ||
		message.Plan[1].Status != "inProgress" ||
		message.Plan[2].Status != "pending" {
		t.Fatalf("structured plan was not preserved: %#v", message.Plan)
	}

	session.Messages[0].Plan[0].Step = "mutated clone"
	again, _ := registry.Get("block-12345678")
	if again.Messages[0].Plan[0].Step != "检查事件" {
		t.Fatal("session clone shared its plan step backing array")
	}

	apply(`[{"step":"检查事件","status":"completed"},{"step":"调整界面","status":"completed"},{"step":"运行测试","status":"completed"}]`)
	completed, _ := registry.Get("block-12345678")
	if completed.Messages[0].Status != "completed" {
		t.Fatalf("completed plan status = %q", completed.Messages[0].Status)
	}
}
