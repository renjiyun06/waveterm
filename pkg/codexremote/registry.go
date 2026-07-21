// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package codexremote

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	maxMessageBytes       = 64 * 1024
	maxActivityDetailSize = 512 * 1024
	sessionTTL            = 45 * time.Second
	pollWait              = 25 * time.Second
	detailTruncationMark  = "\n\n… 内容过长，已保留开头和末尾 …\n\n"
)

var defaultRegistry = NewRegistry()

type Message struct {
	Id        string     `json:"id"`
	Role      string     `json:"role"`
	Kind      string     `json:"kind,omitempty"`
	ToolType  string     `json:"toolType,omitempty"`
	Title     string     `json:"title,omitempty"`
	Text      string     `json:"text"`
	Plan      []PlanStep `json:"plan,omitempty"`
	Input     string     `json:"input,omitempty"`
	Output    string     `json:"output,omitempty"`
	Status    string     `json:"status,omitempty"`
	Truncated bool       `json:"truncated,omitempty"`
	CreatedAt int64      `json:"createdAt"`

	summaryIndex int
}

type PlanStep struct {
	Step   string `json:"step"`
	Status string `json:"status"`
}

type Session struct {
	BlockId         string    `json:"blockId"`
	TabId           string    `json:"tabId,omitempty"`
	WorkspaceId     string    `json:"workspaceId,omitempty"`
	Connection      string    `json:"connection,omitempty"`
	BlockName       string    `json:"blockName,omitempty"`
	ThreadId        string    `json:"threadId,omitempty"`
	Model           string    `json:"model,omitempty"`
	ReasoningEffort string    `json:"reasoningEffort,omitempty"`
	ContextTokens   int64     `json:"contextTokens"`
	ContextWindow   int64     `json:"contextWindow"`
	Title           string    `json:"title"`
	Cwd             string    `json:"cwd,omitempty"`
	State           string    `json:"state"`
	ActiveTurnId    string    `json:"activeTurnId,omitempty"`
	Error           string    `json:"error,omitempty"`
	UpdatedAt       int64     `json:"updatedAt"`
	Revision        int64     `json:"revision"`
	Messages        []Message `json:"messages"`
	threadTitle     string
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
	Id                string                `json:"id"`
	Type              string                `json:"type"`
	Text              string                `json:"text"`
	Content           json.RawMessage       `json:"content"`
	Summary           []string              `json:"summary"`
	Command           string                `json:"command"`
	CommandActions    []remoteCommandAction `json:"commandActions"`
	Cwd               string                `json:"cwd"`
	Status            string                `json:"status"`
	AggregatedOutput  string                `json:"aggregatedOutput"`
	ExitCode          *int                  `json:"exitCode"`
	DurationMs        *int64                `json:"durationMs"`
	Changes           []remoteFileChange    `json:"changes"`
	Server            string                `json:"server"`
	Tool              string                `json:"tool"`
	Arguments         json.RawMessage       `json:"arguments"`
	Result            json.RawMessage       `json:"result"`
	Error             json.RawMessage       `json:"error"`
	Namespace         *string               `json:"namespace"`
	ContentItems      json.RawMessage       `json:"contentItems"`
	Success           *bool                 `json:"success"`
	Query             string                `json:"query"`
	Action            json.RawMessage       `json:"action"`
	Prompt            *string               `json:"prompt"`
	Model             *string               `json:"model"`
	ReceiverThreadIds []string              `json:"receiverThreadIds"`
	AgentsStates      json.RawMessage       `json:"agentsStates"`
	Path              string                `json:"path"`
}

type remoteCommandAction struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Query   string `json:"query"`
}

type remoteUserInput struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type remoteFileChange struct {
	Path string          `json:"path"`
	Kind json.RawMessage `json:"kind"`
	Diff string          `json:"diff"`
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
	case "history-snapshot":
		err = applyHistorySnapshot(&session.Session, []byte(data.Data))
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
	session.Messages = append(make([]Message, 0, len(session.Messages)), session.Messages...)
	for index := range session.Messages {
		session.Messages[index].Plan = append([]PlanStep(nil), session.Messages[index].Plan...)
	}
	return session
}

func applySnapshot(session *Session, data []byte) error {
	var response struct {
		Thread          remoteThread `json:"thread"`
		Cwd             string       `json:"cwd"`
		Model           string       `json:"model"`
		ReasoningEffort *string      `json:"reasoningEffort"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return fmt.Errorf("decoding codex thread snapshot: %w", err)
	}
	if response.Thread.Id == "" {
		return errors.New("codex thread snapshot has no thread id")
	}
	session.ThreadId = response.Thread.Id
	if strings.TrimSpace(response.Model) != "" {
		session.Model = strings.TrimSpace(response.Model)
	}
	if response.ReasoningEffort != nil {
		session.ReasoningEffort = strings.TrimSpace(*response.ReasoningEffort)
	}
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
			upsertRemoteItem(session, item, turnTimestamp(turn), "completed")
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

func applyHistorySnapshot(session *Session, data []byte) error {
	var response struct {
		Thread struct {
			Id string `json:"id"`
		} `json:"thread"`
	}
	if err := json.Unmarshal(data, &response); err != nil {
		return fmt.Errorf("decoding Codex history snapshot: %w", err)
	}
	if session.ThreadId != "" && response.Thread.Id != session.ThreadId {
		return fmt.Errorf("Codex history snapshot thread %q does not match active thread %q", response.Thread.Id, session.ThreadId)
	}
	return applySnapshot(session, data)
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
	case "thread/tokenUsage/updated":
		var params struct {
			ThreadId   string `json:"threadId"`
			TokenUsage struct {
				Last struct {
					TotalTokens int64 `json:"totalTokens"`
				} `json:"last"`
				ModelContextWindow *int64 `json:"modelContextWindow"`
			} `json:"tokenUsage"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		if !threadMatches(session, params.ThreadId) {
			return nil
		}
		session.ContextTokens = max(0, params.TokenUsage.Last.TotalTokens)
		if params.TokenUsage.ModelContextWindow != nil {
			session.ContextWindow = max(0, *params.TokenUsage.ModelContextWindow)
		}
	case "thread/settings/updated":
		var params struct {
			ThreadId       string `json:"threadId"`
			ThreadSettings struct {
				Model  string  `json:"model"`
				Effort *string `json:"effort"`
			} `json:"threadSettings"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		if !threadMatches(session, params.ThreadId) {
			return nil
		}
		if strings.TrimSpace(params.ThreadSettings.Model) != "" {
			session.Model = strings.TrimSpace(params.ThreadSettings.Model)
		}
		if params.ThreadSettings.Effort != nil {
			session.ReasoningEffort = strings.TrimSpace(*params.ThreadSettings.Effort)
		}
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
			upsertRemoteItem(session, item, turnTimestamp(params.Turn), "inProgress")
		}
	case "turn/completed":
		var params struct {
			Turn remoteTurn `json:"turn"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		for _, item := range params.Turn.Items {
			upsertRemoteItem(session, item, turnTimestamp(params.Turn), "completed")
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
		lifecycleStatus := "inProgress"
		if envelope.Method == "item/completed" {
			lifecycleStatus = "completed"
		}
		upsertRemoteItem(session, params.Item, timestamp, lifecycleStatus)
	case "item/agentMessage/delta":
		var params struct {
			ItemId string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		appendAgentDelta(session, params.ItemId, params.Delta)
	case "item/reasoning/summaryTextDelta":
		var params struct {
			ItemId       string `json:"itemId"`
			Delta        string `json:"delta"`
			SummaryIndex int    `json:"summaryIndex"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		appendReasoningDelta(session, params.ItemId, params.Delta, params.SummaryIndex)
	case "item/plan/delta":
		var params struct {
			ItemId string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		appendPlanDelta(session, params.ItemId, params.Delta)
	case "item/commandExecution/outputDelta":
		var params struct {
			ItemId string `json:"itemId"`
			Delta  string `json:"delta"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		appendToolOutput(session, params.ItemId, params.Delta, "command", "终端命令")
	case "item/fileChange/patchUpdated":
		var params struct {
			ItemId  string             `json:"itemId"`
			Changes []remoteFileChange `json:"changes"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		upsertRemoteItem(session, remoteItem{
			Id:      params.ItemId,
			Type:    "fileChange",
			Status:  "inProgress",
			Changes: params.Changes,
		}, 0, "inProgress")
	case "item/mcpToolCall/progress":
		var params struct {
			ItemId  string `json:"itemId"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		if strings.TrimSpace(params.Message) != "" {
			appendToolOutput(session, params.ItemId, params.Message+"\n", "mcp", "MCP 工具")
		}
	case "turn/plan/updated":
		var params struct {
			TurnId      string     `json:"turnId"`
			Explanation *string    `json:"explanation"`
			Plan        []PlanStep `json:"plan"`
		}
		if err := json.Unmarshal(envelope.Params, &params); err != nil {
			return err
		}
		upsertTurnPlan(session, params.TurnId, params.Explanation, params.Plan)
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

func threadMatches(session *Session, threadId string) bool {
	threadId = strings.TrimSpace(threadId)
	return threadId != "" && (session.ThreadId == "" || threadId == session.ThreadId)
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

func upsertRemoteItem(session *Session, item remoteItem, timestamp int64, lifecycleStatus string) {
	if item.Id == "" {
		return
	}
	status := item.Status
	if status == "" {
		status = lifecycleStatus
	}
	if status == "" {
		status = "completed"
	}
	message := Message{
		Id:        item.Id,
		Role:      "assistant",
		Status:    status,
		CreatedAt: normalizeTimestamp(timestamp),
	}
	switch item.Type {
	case "userMessage":
		message.Role = "user"
		message.Kind = "message"
		message.Text = userInputText(item.Content)
	case "agentMessage":
		message.Kind = "message"
		message.Text = item.Text
	case "reasoning":
		message.Kind = "reasoning"
		message.Title = "思考"
		message.Text = joinNonEmpty(item.Summary)
		message.summaryIndex = max(0, len(item.Summary)-1)
	case "plan":
		message.Kind = "plan"
		message.Title = "计划"
		message.Text = item.Text
		if message.Text == "" && status != "inProgress" && findMessage(session, item.Id) == nil {
			return
		}
	case "commandExecution":
		message.Kind = "tool"
		message.ToolType = "command"
		message.Title, message.Text = formatCommandActions(item.CommandActions, item.Command)
		message.Input = formatCommandInput(item.Command, item.Cwd)
		message.Output = item.AggregatedOutput
		if item.ExitCode != nil {
			message.Output = strings.TrimRight(message.Output, "\n")
			if message.Output != "" {
				message.Output += "\n\n"
			}
			message.Output += fmt.Sprintf("退出码: %d", *item.ExitCode)
		}
	case "fileChange":
		message.Kind = "tool"
		message.ToolType = "file"
		message.Title, message.Text, message.Output = formatFileChanges(item.Changes)
	case "mcpToolCall":
		message.Kind = "tool"
		message.ToolType = "mcp"
		message.Title = strings.Trim(strings.Join([]string{"MCP", item.Server, item.Tool}, " · "), " ·")
		message.Text = strings.Trim(strings.Join([]string{item.Server, item.Tool}, " / "), " /")
		message.Input = prettyJSON(item.Arguments)
		applyToolActivitySummary(&message, item.Tool, item.Arguments)
		if !rawJSONEmpty(item.Error) {
			message.Output = "错误\n" + prettyJSON(item.Error)
		} else {
			message.Output = prettyJSON(item.Result)
		}
	case "dynamicToolCall":
		message.Kind = "tool"
		message.ToolType = "dynamic"
		toolName := item.Tool
		if item.Namespace != nil && strings.TrimSpace(*item.Namespace) != "" {
			toolName = strings.TrimSpace(*item.Namespace) + " / " + toolName
		}
		message.Title = "工具 · " + toolName
		message.Text = toolName
		message.Input = prettyJSON(item.Arguments)
		message.Output = prettyJSON(item.ContentItems)
		applyToolActivitySummary(&message, item.Tool, item.Arguments)
	case "collabAgentToolCall":
		message.Kind = "tool"
		message.ToolType = "collab"
		message.Title = "协作代理 · " + item.Tool
		if item.Prompt != nil {
			message.Text = strings.TrimSpace(*item.Prompt)
		}
		input := map[string]any{"receivers": item.ReceiverThreadIds}
		if item.Model != nil {
			input["model"] = *item.Model
		}
		message.Input = prettyValue(input)
		message.Output = prettyJSON(item.AgentsStates)
	case "webSearch":
		message.Kind = "tool"
		message.ToolType = "web"
		message.Title = "Web 搜索"
		message.Text = item.Query
		message.Input = prettyJSON(item.Action)
	case "imageView":
		message.Kind = "tool"
		message.ToolType = "image"
		message.Title = "查看图片"
		message.Text = item.Path
	case "sleep":
		message.Kind = "tool"
		message.ToolType = "wait"
		message.Title = "等待"
		if item.DurationMs != nil {
			message.Text = fmt.Sprintf("%d ms", *item.DurationMs)
		}
	case "contextCompaction":
		message.Kind = "tool"
		message.ToolType = "context"
		message.Title = "压缩上下文"
		message.Text = "Codex 已整理会话上下文"
	default:
		if strings.TrimSpace(item.Type) == "" {
			return
		}
		message.Kind = "tool"
		message.ToolType = "generic"
		message.Title = "未识别活动 · " + item.Type
		message.Text = item.Type
	}
	if message.Kind == "reasoning" || message.Kind == "plan" {
		var textTruncated bool
		message.Text, textTruncated = limitActivityDetail(message.Text)
		message.Truncated = message.Truncated || textTruncated
	}
	var inputTruncated bool
	message.Input, inputTruncated = limitActivityDetail(message.Input)
	message.Truncated = message.Truncated || inputTruncated
	var outputTruncated bool
	message.Output, outputTruncated = limitActivityDetail(message.Output)
	message.Truncated = message.Truncated || outputTruncated
	upsertMessage(session, message)
}

func formatCommandActions(actions []remoteCommandAction, command string) (string, string) {
	title := "终端命令"
	if len(actions) == 0 {
		return title, command
	}
	lines := make([]string, 0, len(actions))
	types := make(map[string]bool)
	for _, action := range actions {
		types[action.Type] = true
		var line string
		switch action.Type {
		case "read":
			line = strings.TrimSpace(action.Path)
			if line == "" {
				line = strings.TrimSpace(action.Name)
			}
		case "listFiles":
			line = strings.TrimSpace(action.Path)
		case "search":
			parts := make([]string, 0, 2)
			if strings.TrimSpace(action.Query) != "" {
				parts = append(parts, "“"+strings.TrimSpace(action.Query)+"”")
			}
			if strings.TrimSpace(action.Path) != "" {
				parts = append(parts, strings.TrimSpace(action.Path))
			}
			line = strings.Join(parts, " · ")
		}
		if line != "" && !containsString(lines, line) {
			lines = append(lines, line)
		}
	}
	if len(types) == 1 {
		switch {
		case types["read"]:
			title = "读取文件"
		case types["listFiles"]:
			title = "列出目录"
		case types["search"]:
			title = "搜索文件"
		}
	} else if types["read"] || types["listFiles"] || types["search"] {
		title = "读取工作区"
	}
	if len(lines) == 0 {
		return title, command
	}
	return title, strings.Join(lines, "\n")
}

func formatCommandInput(command string, cwd string) string {
	parts := make([]string, 0, 2)
	if strings.TrimSpace(cwd) != "" {
		parts = append(parts, "工作目录: "+strings.TrimSpace(cwd))
	}
	if strings.TrimSpace(command) != "" {
		parts = append(parts, "命令: "+strings.TrimSpace(command))
	}
	return strings.Join(parts, "\n")
}

func applyToolActivitySummary(message *Message, toolName string, arguments json.RawMessage) {
	normalized := strings.ToLower(strings.NewReplacer("-", "", "_", "", "/", "", ".", "").Replace(toolName))
	words := strings.Fields(strings.ToLower(strings.NewReplacer("-", " ", "_", " ", "/", " ", ".", " ", ":", " ").Replace(toolName)))
	hasWord := func(values ...string) bool {
		for _, value := range values {
			if containsString(words, value) {
				return true
			}
		}
		return false
	}
	var title string
	switch {
	case strings.Contains(normalized, "readfile"), strings.Contains(normalized, "getfile"),
		strings.HasPrefix(normalized, "read") && (strings.HasSuffix(normalized, "file") || strings.HasSuffix(normalized, "files")),
		hasWord("read", "get") && hasWord("file", "files"):
		title = "读取文件"
	case strings.Contains(normalized, "listfiles"), strings.Contains(normalized, "listdirectory"),
		hasWord("list") && hasWord("file", "files", "directory", "directories", "dir"):
		title = "列出目录"
	case strings.Contains(normalized, "searchfiles"), strings.Contains(normalized, "findfiles"),
		hasWord("search", "find") && hasWord("file", "files"):
		title = "搜索文件"
	default:
		return
	}
	message.Title = title + " · " + toolName
	if summary := toolArgumentSummary(arguments); summary != "" {
		message.Text = summary
	}
}

func toolArgumentSummary(raw json.RawMessage) string {
	if rawJSONEmpty(raw) {
		return ""
	}
	var values map[string]any
	if json.Unmarshal(raw, &values) != nil {
		return ""
	}
	parts := make([]string, 0, 2)
	for _, key := range []string{"path", "filePath", "filepath", "directory", "dir", "query", "pattern"} {
		value, ok := values[key].(string)
		value = strings.TrimSpace(value)
		if ok && value != "" && !containsString(parts, value) {
			parts = append(parts, value)
		}
		if len(parts) == 2 {
			break
		}
	}
	return strings.Join(parts, " · ")
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func upsertMessage(session *Session, message Message) {
	for index := range session.Messages {
		if session.Messages[index].Id != message.Id {
			continue
		}
		existing := session.Messages[index]
		message.CreatedAt = existing.CreatedAt
		if message.Text == "" {
			message.Text = existing.Text
		}
		if message.Title == "" {
			message.Title = existing.Title
		}
		if message.Input == "" {
			message.Input = existing.Input
		}
		if message.Output == "" {
			message.Output = existing.Output
		}
		if message.Status == "" {
			message.Status = existing.Status
		}
		if message.summaryIndex == 0 && existing.summaryIndex > 0 {
			message.summaryIndex = existing.summaryIndex
		}
		message.Truncated = message.Truncated || existing.Truncated
		session.Messages[index] = message
		return
	}
	session.Messages = append(session.Messages, message)
}

func findMessage(session *Session, itemId string) *Message {
	for index := range session.Messages {
		if session.Messages[index].Id == itemId {
			return &session.Messages[index]
		}
	}
	return nil
}

func appendAgentDelta(session *Session, itemId string, delta string) {
	if itemId == "" || delta == "" {
		return
	}
	if message := findMessage(session, itemId); message != nil {
		message.Text += delta
		message.Status = "streaming"
		return
	}
	session.Messages = append(session.Messages, Message{
		Id:        itemId,
		Role:      "assistant",
		Kind:      "message",
		Text:      delta,
		Status:    "streaming",
		CreatedAt: time.Now().UnixMilli(),
	})
}

func appendReasoningDelta(session *Session, itemId string, delta string, summaryIndex int) {
	if itemId == "" || delta == "" {
		return
	}
	if message := findMessage(session, itemId); message != nil {
		separator := ""
		if message.Text != "" && summaryIndex > message.summaryIndex {
			separator = "\n\n"
		}
		var truncated bool
		message.Text, truncated = appendActivityDetail(message.Text, separator+delta)
		message.Truncated = message.Truncated || truncated
		message.summaryIndex = summaryIndex
		message.Status = "streaming"
		return
	}
	text, truncated := limitActivityDetail(delta)
	session.Messages = append(session.Messages, Message{
		Id:           itemId,
		Role:         "assistant",
		Kind:         "reasoning",
		Title:        "思考",
		Text:         text,
		Status:       "streaming",
		Truncated:    truncated,
		CreatedAt:    time.Now().UnixMilli(),
		summaryIndex: summaryIndex,
	})
}

func appendPlanDelta(session *Session, itemId string, delta string) {
	if itemId == "" || delta == "" {
		return
	}
	if message := findMessage(session, itemId); message != nil {
		var truncated bool
		message.Text, truncated = appendActivityDetail(message.Text, delta)
		message.Truncated = message.Truncated || truncated
		message.Status = "streaming"
		return
	}
	text, truncated := limitActivityDetail(delta)
	session.Messages = append(session.Messages, Message{
		Id:        itemId,
		Role:      "assistant",
		Kind:      "plan",
		Title:     "计划",
		Text:      text,
		Status:    "streaming",
		Truncated: truncated,
		CreatedAt: time.Now().UnixMilli(),
	})
}

func appendToolOutput(session *Session, itemId string, delta string, toolType string, title string) {
	if itemId == "" || delta == "" {
		return
	}
	if message := findMessage(session, itemId); message != nil {
		var truncated bool
		message.Output, truncated = appendActivityDetail(message.Output, delta)
		message.Truncated = message.Truncated || truncated
		message.Status = "inProgress"
		return
	}
	output, truncated := limitActivityDetail(delta)
	session.Messages = append(session.Messages, Message{
		Id:        itemId,
		Role:      "assistant",
		Kind:      "tool",
		ToolType:  toolType,
		Title:     title,
		Output:    output,
		Status:    "inProgress",
		Truncated: truncated,
		CreatedAt: time.Now().UnixMilli(),
	})
}

func upsertTurnPlan(session *Session, turnId string, explanation *string, steps []PlanStep) {
	if turnId == "" || (explanation == nil && len(steps) == 0) {
		return
	}
	text := ""
	if explanation != nil && strings.TrimSpace(*explanation) != "" {
		text = strings.TrimSpace(*explanation)
	}
	text, truncated := limitActivityDetail(text)
	status := "completed"
	for _, step := range steps {
		if step.Status != "completed" {
			status = "streaming"
		}
	}
	upsertMessage(session, Message{
		Id:        "turn-plan:" + turnId,
		Role:      "assistant",
		Kind:      "plan",
		Title:     "计划",
		Text:      text,
		Plan:      append([]PlanStep(nil), steps...),
		Status:    status,
		Truncated: truncated,
		CreatedAt: time.Now().UnixMilli(),
	})
}

func formatFileChanges(changes []remoteFileChange) (string, string, string) {
	title := "文件修改"
	if len(changes) != 0 {
		title = fmt.Sprintf("文件修改 · %d 个文件", len(changes))
	}
	paths := make([]string, 0, len(changes))
	details := make([]string, 0, len(changes))
	for _, change := range changes {
		if change.Path == "" {
			continue
		}
		kind := fileChangeKind(change.Kind)
		paths = append(paths, kind+" "+change.Path)
		detail := kind + " " + change.Path
		if change.Diff != "" {
			detail += "\n" + change.Diff
		}
		details = append(details, detail)
	}
	return title, strings.Join(paths, "\n"), strings.Join(details, "\n\n")
}

func fileChangeKind(raw json.RawMessage) string {
	var value struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &value) != nil {
		return "修改"
	}
	switch value.Type {
	case "add":
		return "新增"
	case "delete":
		return "删除"
	default:
		return "修改"
	}
}

func joinNonEmpty(values []string) string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return strings.Join(result, "\n\n")
}

func prettyJSON(raw json.RawMessage) string {
	if rawJSONEmpty(raw) {
		return ""
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return string(raw)
	}
	return prettyValue(value)
}

func prettyValue(value any) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return ""
	}
	return string(data)
}

func rawJSONEmpty(raw json.RawMessage) bool {
	value := bytes.TrimSpace(raw)
	return len(value) == 0 || bytes.Equal(value, []byte("null"))
}

func normalizeTimestamp(timestamp int64) int64 {
	if timestamp == 0 {
		return time.Now().UnixMilli()
	}
	if timestamp < 10_000_000_000 {
		return timestamp * 1000
	}
	return timestamp
}

func limitActivityDetail(value string) (string, bool) {
	if len(value) <= maxActivityDetailSize {
		return value, false
	}
	headBudget := maxActivityDetailSize / 3
	tailBudget := maxActivityDetailSize - headBudget - len(detailTruncationMark)
	head := validUTF8Prefix(value, headBudget)
	tail := validUTF8Suffix(value, tailBudget)
	return head + detailTruncationMark + tail, true
}

func appendActivityDetail(current string, delta string) (string, bool) {
	if marker := strings.Index(current, detailTruncationMark); marker >= 0 {
		head := current[:marker]
		tail := current[marker+len(detailTruncationMark):] + delta
		tailBudget := maxActivityDetailSize - len(head) - len(detailTruncationMark)
		return head + detailTruncationMark + validUTF8Suffix(tail, tailBudget), true
	}
	return limitActivityDetail(current + delta)
}

func validUTF8Prefix(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	end := limit
	for end > 0 && !utf8.ValidString(value[:end]) {
		end--
	}
	return value[:end]
}

func validUTF8Suffix(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	start := len(value) - limit
	for start < len(value) && !utf8.RuneStart(value[start]) {
		start++
	}
	return value[start:]
}

func userInputText(raw json.RawMessage) string {
	var content []remoteUserInput
	if json.Unmarshal(raw, &content) != nil {
		return ""
	}
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
