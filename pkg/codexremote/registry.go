// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package codexremote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	maxMessageBytes = 64 * 1024
	sessionTTL      = 45 * time.Second
	pollWait        = 25 * time.Second
)

var defaultRegistry = NewRegistry()

type Message struct {
	Id        string `json:"id"`
	Role      string `json:"role"`
	Text      string `json:"text"`
	Status    string `json:"status,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type Session struct {
	BlockId      string    `json:"blockId"`
	TabId        string    `json:"tabId,omitempty"`
	WorkspaceId  string    `json:"workspaceId,omitempty"`
	Connection   string    `json:"connection,omitempty"`
	BlockName    string    `json:"blockName,omitempty"`
	ThreadId     string    `json:"threadId,omitempty"`
	Title        string    `json:"title"`
	Cwd          string    `json:"cwd,omitempty"`
	State        string    `json:"state"`
	ActiveTurnId string    `json:"activeTurnId,omitempty"`
	Error        string    `json:"error,omitempty"`
	UpdatedAt    int64     `json:"updatedAt"`
	Revision     int64     `json:"revision"`
	Messages     []Message `json:"messages"`
	threadTitle  string
}

type sessionState struct {
	Session
	bridgeId string
	lastSeen time.Time
	actions  chan wshrpc.CodexSessionAction
}

type Registry struct {
	lock        sync.Mutex
	sessions    map[string]*sessionState
	subscribers map[int64]chan struct{}
	nextSubId   int64
	revision    int64
	nowFn       func() time.Time
}

type appServerEnvelope struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type remoteThread struct {
	Id      string          `json:"id"`
	Name    *string         `json:"name"`
	Preview string          `json:"preview"`
	Cwd     string          `json:"cwd"`
	Status  json.RawMessage `json:"status"`
	Turns   []remoteTurn    `json:"turns"`
}

type remoteTurn struct {
	Id        string       `json:"id"`
	Status    string       `json:"status"`
	StartedAt *int64       `json:"startedAt"`
	Items     []remoteItem `json:"items"`
}

type remoteItem struct {
	Id      string            `json:"id"`
	Type    string            `json:"type"`
	Text    string            `json:"text"`
	Content []remoteUserInput `json:"content"`
}

type remoteUserInput struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func NewRegistry() *Registry {
	return &Registry{
		sessions:    make(map[string]*sessionState),
		subscribers: make(map[int64]chan struct{}),
		nowFn:       time.Now,
	}
}

func DefaultRegistry() *Registry {
	return defaultRegistry
}

func (r *Registry) Register(data wshrpc.CodexSessionRegisterData) error {
	if data.BlockId == "" || data.BridgeId == "" {
		return errors.New("blockid and bridgeid are required")
	}
	now := r.nowFn()
	r.lock.Lock()
	r.sessions[data.BlockId] = &sessionState{
		Session: Session{
			BlockId:     data.BlockId,
			TabId:       data.TabId,
			WorkspaceId: data.WorkspaceId,
			Connection:  data.Connection,
			BlockName:   data.BlockName,
			Title:       fallbackTitle(data.BlockId, data.Cwd, data.BlockName),
			Cwd:         data.Cwd,
			State:       "starting",
			UpdatedAt:   now.UnixMilli(),
			Messages:    make([]Message, 0),
			threadTitle: fallbackTitle(data.BlockId, data.Cwd, ""),
		},
		bridgeId: data.BridgeId,
		lastSeen: now,
		actions:  make(chan wshrpc.CodexSessionAction, 32),
	}
	r.touchLocked(r.sessions[data.BlockId])
	r.broadcastLocked()
	r.lock.Unlock()
	return nil
}

func (r *Registry) UpdateBlockName(blockId string, blockName string) {
	r.lock.Lock()
	session := r.sessions[blockId]
	if session != nil {
		session.BlockName = strings.TrimSpace(blockName)
		refreshSessionTitle(&session.Session)
		r.touchLocked(session)
		r.broadcastLocked()
	}
	r.lock.Unlock()
}

func (r *Registry) Unregister(data wshrpc.CodexSessionUnregisterData) error {
	r.lock.Lock()
	session := r.sessions[data.BlockId]
	if session != nil && session.bridgeId == data.BridgeId {
		delete(r.sessions, data.BlockId)
		r.revision++
		r.broadcastLocked()
	}
	r.lock.Unlock()
	return nil
}

func (r *Registry) ApplyEvent(data wshrpc.CodexSessionEventData) error {
	if len(data.Data) > 8*1024*1024 {
		return errors.New("codex session event is too large")
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	session := r.sessions[data.BlockId]
	if session == nil || session.bridgeId != data.BridgeId {
		return nil
	}
	session.lastSeen = r.nowFn()
	var err error
	switch data.Kind {
	case "snapshot":
		err = applySnapshot(&session.Session, []byte(data.Data))
	case "notification":
		err = applyNotification(&session.Session, []byte(data.Data))
	case "action-error":
		session.Error = strings.TrimSpace(data.Data)
		session.State = "error"
	default:
		return fmt.Errorf("unsupported codex session event kind %q", data.Kind)
	}
	if err != nil {
		return err
	}
	r.touchLocked(session)
	r.broadcastLocked()
	return nil
}

func (r *Registry) Poll(ctx context.Context, data wshrpc.CodexSessionPollData) (wshrpc.CodexSessionAction, error) {
	r.lock.Lock()
	session := r.sessions[data.BlockId]
	if session == nil || session.bridgeId != data.BridgeId {
		r.lock.Unlock()
		return wshrpc.CodexSessionAction{}, errors.New("codex session is no longer registered")
	}
	session.lastSeen = r.nowFn()
	actions := session.actions
	r.lock.Unlock()

	timer := time.NewTimer(pollWait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return wshrpc.CodexSessionAction{}, ctx.Err()
	case action := <-actions:
		return action, nil
	case <-timer.C:
		return wshrpc.CodexSessionAction{Kind: "noop"}, nil
	}
}

func (r *Registry) Submit(blockId string, text string) error {
	text = strings.TrimSpace(text)
	if text == "" {
		return errors.New("message cannot be empty")
	}
	if len([]byte(text)) > maxMessageBytes {
		return fmt.Errorf("message exceeds %d bytes", maxMessageBytes)
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	session := r.sessions[blockId]
	if session == nil || session.ThreadId == "" {
		return errors.New("codex session is not ready")
	}
	action := wshrpc.CodexSessionAction{
		ActionId: uuid.NewString(),
		Kind:     "turn/start",
		ThreadId: session.ThreadId,
		Text:     text,
	}
	if session.ActiveTurnId != "" {
		action.Kind = "turn/steer"
		action.TurnId = session.ActiveTurnId
	}
	select {
	case session.actions <- action:
		return nil
	default:
		return errors.New("codex session command queue is full")
	}
}

func (r *Registry) Interrupt(blockId string) error {
	r.lock.Lock()
	defer r.lock.Unlock()
	session := r.sessions[blockId]
	if session == nil || session.ThreadId == "" || session.ActiveTurnId == "" {
		return errors.New("codex session has no active turn")
	}
	action := wshrpc.CodexSessionAction{
		ActionId: uuid.NewString(),
		Kind:     "turn/interrupt",
		ThreadId: session.ThreadId,
		TurnId:   session.ActiveTurnId,
	}
	select {
	case session.actions <- action:
		return nil
	default:
		return errors.New("codex session command queue is full")
	}
}

func (r *Registry) List() []Session {
	r.lock.Lock()
	r.pruneLocked()
	result := make([]Session, 0, len(r.sessions))
	for _, state := range r.sessions {
		result = append(result, cloneSession(state.Session))
	}
	r.lock.Unlock()
	sort.Slice(result, func(i int, j int) bool {
		return result[i].UpdatedAt > result[j].UpdatedAt
	})
	return result
}

func (r *Registry) Get(blockId string) (Session, bool) {
	r.lock.Lock()
	r.pruneLocked()
	session := r.sessions[blockId]
	if session == nil {
		r.lock.Unlock()
		return Session{}, false
	}
	result := cloneSession(session.Session)
	r.lock.Unlock()
	return result, true
}

func (r *Registry) Subscribe() (<-chan struct{}, func()) {
	r.lock.Lock()
	r.nextSubId++
	id := r.nextSubId
	ch := make(chan struct{}, 1)
	r.subscribers[id] = ch
	r.lock.Unlock()
	cancel := func() {
		r.lock.Lock()
		if existing := r.subscribers[id]; existing != nil {
			delete(r.subscribers, id)
			close(existing)
		}
		r.lock.Unlock()
	}
	return ch, cancel
}

func (r *Registry) touchLocked(session *sessionState) {
	r.revision++
	session.Revision = r.revision
	session.UpdatedAt = r.nowFn().UnixMilli()
}

func (r *Registry) broadcastLocked() {
	for _, subscriber := range r.subscribers {
		select {
		case subscriber <- struct{}{}:
		default:
		}
	}
}

func (r *Registry) pruneLocked() {
	cutoff := r.nowFn().Add(-sessionTTL)
	changed := false
	for blockId, session := range r.sessions {
		if session.lastSeen.Before(cutoff) {
			delete(r.sessions, blockId)
			changed = true
		}
	}
	if changed {
		r.revision++
		r.broadcastLocked()
	}
}

func cloneSession(session Session) Session {
	session.Messages = append([]Message(nil), session.Messages...)
	return session
}

func applySnapshot(session *Session, data []byte) error {
	var response struct {
		Thread remoteThread `json:"thread"`
		Cwd    string       `json:"cwd"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return fmt.Errorf("decoding codex thread snapshot: %w", err)
	}
	if response.Thread.Id == "" {
		return errors.New("codex thread snapshot has no thread id")
	}
	session.ThreadId = response.Thread.Id
	if response.Thread.Cwd != "" {
		session.Cwd = response.Thread.Cwd
	} else if response.Cwd != "" {
		session.Cwd = response.Cwd
	}
	setThreadTitle(session, response.Thread)
	session.Messages = session.Messages[:0]
	session.ActiveTurnId = ""
	for _, turn := range response.Thread.Turns {
		for _, item := range turn.Items {
			upsertRemoteItem(session, item, turnTimestamp(turn))
		}
		if turn.Status == "inProgress" {
			session.ActiveTurnId = turn.Id
		}
	}
	applyThreadStatus(session, response.Thread.Status)
	if session.State == "starting" || session.State == "" {
		session.State = "idle"
	}
	session.Error = ""
	return nil
}

func applyNotification(session *Session, data []byte) error {
	var envelope appServerEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return fmt.Errorf("decoding codex notification: %w", err)
	}
	switch envelope.Method {
	case "thread/started":
		var params struct {
			Thread remoteThread `json:"thread"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		if params.Thread.Id != "" {
			session.ThreadId = params.Thread.Id
		}
		if params.Thread.Cwd != "" {
			session.Cwd = params.Thread.Cwd
		}
		setThreadTitle(session, params.Thread)
		applyThreadStatus(session, params.Thread.Status)
	case "thread/name/updated":
		var params struct {
			ThreadId   string  `json:"threadId"`
			ThreadName *string `json:"threadName"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		if params.ThreadName != nil && strings.TrimSpace(*params.ThreadName) != "" {
			session.threadTitle = strings.TrimSpace(*params.ThreadName)
			refreshSessionTitle(session)
		}
	case "thread/status/changed":
		var params struct {
			Status json.RawMessage `json:"status"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		applyThreadStatus(session, params.Status)
	case "turn/started":
		var params struct {
			Turn remoteTurn `json:"turn"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		session.ActiveTurnId = params.Turn.Id
		session.State = "working"
		session.Error = ""
		for _, item := range params.Turn.Items {
			upsertRemoteItem(session, item, turnTimestamp(params.Turn))
		}
	case "turn/completed":
		var params struct {
			Turn remoteTurn `json:"turn"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		for _, item := range params.Turn.Items {
			upsertRemoteItem(session, item, turnTimestamp(params.Turn))
		}
		if session.ActiveTurnId == params.Turn.Id {
			session.ActiveTurnId = ""
		}
		session.State = "idle"
	case "item/started", "item/completed":
		var params struct {
			Item        remoteItem `json:"item"`
			StartedAtMs int64      `json:"startedAtMs"`
			CompletedAt int64      `json:"completedAtMs"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		timestamp := params.StartedAtMs
		if timestamp == 0 {
			timestamp = params.CompletedAt
		}
		upsertRemoteItem(session, params.Item, timestamp)
	case "item/agentMessage/delta":
		var params struct {
			ItemId string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		appendAgentDelta(session, params.ItemId, params.Delta)
	case "error":
		var params struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			WillRetry bool `json:"willRetry"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		session.Error = params.Error.Message
		if !params.WillRetry {
			session.State = "error"
		}
	}
	return nil
}

func applyThreadStatus(session *Session, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var status struct {
		Type        string   `json:"type"`
		ActiveFlags []string `json:"activeFlags"`
	}
	if json.Unmarshal(raw, &status) != nil {
		return
	}
	switch status.Type {
	case "active":
		session.State = "working"
		for _, flag := range status.ActiveFlags {
			if flag == "waitingOnApproval" || flag == "waitingOnUserInput" {
				session.State = flag
				break
			}
		}
	case "idle":
		session.State = "idle"
	case "systemError":
		session.State = "error"
	}
}

func setThreadTitle(session *Session, thread remoteThread) {
	if thread.Name != nil && strings.TrimSpace(*thread.Name) != "" {
		session.threadTitle = strings.TrimSpace(*thread.Name)
	} else if strings.TrimSpace(thread.Preview) != "" {
		session.threadTitle = truncateRunes(strings.TrimSpace(thread.Preview), 72)
	} else {
		session.threadTitle = fallbackTitle(session.BlockId, session.Cwd, "")
	}
	refreshSessionTitle(session)
}

func refreshSessionTitle(session *Session) {
	if strings.TrimSpace(session.BlockName) != "" {
		session.Title = strings.TrimSpace(session.BlockName)
		return
	}
	if strings.TrimSpace(session.threadTitle) != "" {
		session.Title = strings.TrimSpace(session.threadTitle)
		return
	}
	session.Title = fallbackTitle(session.BlockId, session.Cwd, "")
}

func upsertRemoteItem(session *Session, item remoteItem, timestamp int64) {
	var role string
	var text string
	switch item.Type {
	case "userMessage":
		role = "user"
		text = userInputText(item.Content)
	case "agentMessage":
		role = "assistant"
		text = item.Text
	default:
		return
	}
	if item.Id == "" {
		return
	}
	if timestamp == 0 {
		timestamp = time.Now().UnixMilli()
	} else if timestamp < 10_000_000_000 {
		timestamp *= 1000
	}
	for index := range session.Messages {
		if session.Messages[index].Id == item.Id {
			session.Messages[index].Role = role
			session.Messages[index].Text = text
			session.Messages[index].Status = "completed"
			return
		}
	}
	session.Messages = append(session.Messages, Message{
		Id:        item.Id,
		Role:      role,
		Text:      text,
		Status:    "completed",
		CreatedAt: timestamp,
	})
}

func appendAgentDelta(session *Session, itemId string, delta string) {
	if itemId == "" || delta == "" {
		return
	}
	for index := range session.Messages {
		if session.Messages[index].Id == itemId {
			session.Messages[index].Text += delta
			session.Messages[index].Status = "streaming"
			return
		}
	}
	session.Messages = append(session.Messages, Message{
		Id:        itemId,
		Role:      "assistant",
		Text:      delta,
		Status:    "streaming",
		CreatedAt: time.Now().UnixMilli(),
	})
}

func userInputText(content []remoteUserInput) string {
	parts := make([]string, 0, len(content))
	for _, input := range content {
		if input.Type == "text" && input.Text != "" {
			parts = append(parts, input.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func turnTimestamp(turn remoteTurn) int64 {
	if turn.StartedAt == nil {
		return 0
	}
	return *turn.StartedAt
}

func fallbackTitle(blockId string, cwd string, blockName string) string {
	if strings.TrimSpace(blockName) != "" {
		return strings.TrimSpace(blockName)
	}
	if cwd != "" {
		name := filepath.Base(filepath.Clean(cwd))
		if name != "." && name != string(filepath.Separator) && name != "" {
			return "Codex · " + name
		}
	}
	if len(blockId) > 8 {
		blockId = blockId[:8]
	}
	return "Codex · " + blockId
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max-1]) + "…"
}
