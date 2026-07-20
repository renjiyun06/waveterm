// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package codexremote

import (
	"context"
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
