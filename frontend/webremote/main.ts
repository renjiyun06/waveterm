// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import "./style.css";

type PlanStep = {
    step: string;
    status: "pending" | "inProgress" | "completed";
};

type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    kind?: "message" | "reasoning" | "plan" | "tool";
    toolType?: string;
    title?: string;
    text: string;
    plan?: PlanStep[];
    input?: string;
    output?: string;
    status?: string;
    truncated?: boolean;
    createdAt: number;
};

type CodexSession = {
    blockId: string;
    tabId?: string;
    workspaceId?: string;
    connection?: string;
    threadId?: string;
    title: string;
    cwd?: string;
    state: string;
    activeTurnId?: string;
    error?: string;
    updatedAt: number;
    revision: number;
    messages: ChatMessage[];
};

type RawCodexSession = Omit<CodexSession, "messages"> & {
    messages?: ChatMessage[] | null;
};

const getElement = <T extends HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing element #${id}`);
    return element as T;
};

const appShell = getElement<HTMLDivElement>("app-shell");
const loginScreen = getElement<HTMLDivElement>("login-screen");
const loginForm = getElement<HTMLFormElement>("login-form");
const loginError = getElement<HTMLDivElement>("login-error");
const accessToken = getElement<HTMLInputElement>("access-token");
const sessionList = getElement<HTMLDivElement>("session-list");
const sessionSearch = getElement<HTMLInputElement>("session-search");
const sessionCount = getElement<HTMLSpanElement>("session-count");
const conversationTitle = getElement<HTMLDivElement>("conversation-title");
const conversationMeta = getElement<HTMLDivElement>("conversation-meta");
const connectionState = getElement<HTMLDivElement>("connection-state");
const connectionLabel = getElement<HTMLSpanElement>("connection-label");
const emptyState = getElement<HTMLDivElement>("empty-state");
const messageList = getElement<HTMLDivElement>("message-list");
const chatScroll = getElement<HTMLElement>("chat-scroll");
const composer = getElement<HTMLFormElement>("composer");
const messageInput = getElement<HTMLTextAreaElement>("message-input");
const sendButton = getElement<HTMLButtonElement>("send-message");
const interruptButton = getElement<HTMLButtonElement>("interrupt");
const sessionError = getElement<HTMLDivElement>("session-error");
const sidebar = getElement<HTMLElement>("sidebar");
const sidebarBackdrop = getElement<HTMLDivElement>("sidebar-backdrop");

let sessions: CodexSession[] = [];
let selectedBlockId = localStorage.getItem("wave-codex-selected") ?? "";
let eventSource: EventSource | null = null;
let sending = false;
let composing = false;
let checkingAuth = false;
let renderedBlockId = "";
let renderedSessionListKey = "";

const api = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    return fetch(path, { ...init, headers, credentials: "same-origin" });
};

const parseError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: string };
        return body.error ?? `请求失败 (${response.status})`;
    } catch {
        return `请求失败 (${response.status})`;
    }
};

const selectedSession = (): CodexSession | undefined => sessions.find((session) => session.blockId === selectedBlockId);

const stateLabel = (state: string): string => {
    switch (state) {
        case "starting":
            return "正在启动";
        case "working":
        case "active":
            return "正在处理";
        case "waitingOnApproval":
            return "等待桌面批准";
        case "waitingOnUserInput":
            return "等待输入";
        case "error":
            return "出现错误";
        default:
            return "可继续";
    }
};

const stateClass = (state: string): string => {
    if (state === "working" || state === "active") return "working";
    if (state === "error") return "error";
    if (state === "starting") return "starting";
    if (state.startsWith("waiting")) return "waiting";
    return "idle";
};

const compactPath = (path?: string): string => {
    if (!path) return "";
    const normalized = path.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 2) return path;
    return `…/${parts.slice(-2).join("/")}`;
};

const closeSidebar = () => {
    sidebar.classList.remove("open");
    sidebarBackdrop.classList.remove("visible");
};

const openSidebar = () => {
    sidebar.classList.add("open");
    sidebarBackdrop.classList.add("visible");
};

const selectSession = (blockId: string) => {
    selectedBlockId = blockId;
    localStorage.setItem("wave-codex-selected", blockId);
    closeSidebar();
    render();
};

const renderSessionList = () => {
    const query = sessionSearch.value.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) =>
        `${session.title} ${session.cwd ?? ""} ${session.connection ?? ""}`.toLocaleLowerCase().includes(query)
    );
    const renderKey = JSON.stringify([
        query,
        selectedBlockId,
        sessions.map((session) => [session.blockId, session.title, session.state, session.connection, session.cwd]),
    ]);
    if (renderKey === renderedSessionListKey) return;
    renderedSessionListKey = renderKey;
    sessionList.replaceChildren();
    for (const session of filtered) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-item";
        button.classList.toggle("selected", session.blockId === selectedBlockId);
        button.addEventListener("click", () => selectSession(session.blockId));

        const heading = document.createElement("div");
        heading.className = "session-item-heading";
        const title = document.createElement("span");
        title.className = "session-item-title";
        title.textContent = session.title;
        const badge = document.createElement("span");
        badge.className = `session-badge ${stateClass(session.state)}`;
        badge.textContent = stateLabel(session.state);
        heading.append(title, badge);

        const meta = document.createElement("div");
        meta.className = "session-item-meta";
        const connection = session.connection && session.connection !== "local" ? session.connection : "本机";
        meta.textContent = [connection, compactPath(session.cwd)].filter(Boolean).join(" · ");
        button.append(heading, meta);
        sessionList.append(button);
    }
    if (filtered.length === 0) {
        const notice = document.createElement("div");
        notice.className = "list-empty";
        notice.textContent = sessions.length === 0 ? "还没有正在运行的 Codex 会话" : "没有匹配的会话";
        sessionList.append(notice);
    }
    sessionCount.textContent = `${sessions.length} 个会话`;
};

const activityStatusLabel = (status?: string): string => {
    switch (status) {
        case "inProgress":
        case "streaming":
            return "进行中";
        case "failed":
            return "失败";
        case "declined":
            return "已拒绝";
        default:
            return "已完成";
    }
};

const activityStatusClass = (status?: string): string => {
    if (status === "inProgress" || status === "streaming") return "running";
    if (status === "failed") return "failed";
    if (status === "declined") return "declined";
    return "completed";
};

const toolIcon = (toolType?: string): string => {
    switch (toolType) {
        case "command":
            return ">_";
        case "file":
            return "Δ";
        case "mcp":
            return "M";
        case "dynamic":
            return "◆";
        case "collab":
            return "◎";
        case "web":
            return "⌕";
        case "image":
            return "▧";
        case "wait":
            return "◷";
        case "context":
            return "≋";
        default:
            return "•";
    }
};

const createDisclosureIcon = (): HTMLElement => {
    const icon = document.createElement("span");
    icon.className = "disclosure-icon";
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m9 6 6 6-6 6");
    svg.append(path);
    icon.append(svg);
    return icon;
};

const createPlanIcon = (): HTMLElement => {
    const icon = document.createElement("span");
    icon.className = "plan-icon";
    icon.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("focusable", "false");
    for (const y of [6, 12, 18]) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", "5");
        circle.setAttribute("cy", String(y));
        circle.setAttribute("r", "1.25");
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line.setAttribute("d", `M9 ${y}h10`);
        svg.append(circle, line);
    }
    icon.append(svg);
    return icon;
};

const renderConversationMessage = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "message") {
        article.replaceChildren();
        const label = document.createElement("div");
        label.className = "message-label";
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        article.append(label, bubble);
        article.dataset.layout = "message";
    }
    article.className = `message ${message.role}`;
    const label = article.querySelector<HTMLElement>(".message-label")!;
    label.textContent = message.role === "user" ? "你" : "Codex";
    const bubble = article.querySelector<HTMLElement>(".message-bubble")!;
    const text = message.text || (message.status === "streaming" ? "…" : "");
    if (bubble.textContent !== text) bubble.textContent = text;
};

const renderReasoningItem = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "reasoning") {
        article.replaceChildren();
        const details = document.createElement("details");
        details.className = "reasoning-card";
        const summary = document.createElement("summary");
        const mark = document.createElement("span");
        mark.className = "reasoning-mark";
        mark.textContent = "✦";
        const copy = document.createElement("span");
        copy.className = "reasoning-summary-copy";
        const title = document.createElement("span");
        title.className = "reasoning-title";
        const preview = document.createElement("span");
        preview.className = "reasoning-preview";
        copy.append(title, preview);
        const state = document.createElement("span");
        state.className = "tool-state";
        summary.append(mark, copy, state, createDisclosureIcon());
        const body = document.createElement("div");
        body.className = "reasoning-detail";
        const content = document.createElement("div");
        content.className = "reasoning-content";
        const truncated = document.createElement("div");
        truncated.className = "tool-truncated";
        truncated.textContent = "思考摘要过长，已保留开头和末尾。";
        body.append(content, truncated);
        details.append(summary, body);
        summary.addEventListener("click", (event) => {
            if (details.classList.contains("no-details")) event.preventDefault();
        });
        article.append(details);
        article.dataset.layout = "reasoning";
    }
    article.className = "timeline-item reasoning";
    const details = article.querySelector<HTMLDetailsElement>(".reasoning-card")!;
    details.className = `reasoning-card ${activityStatusClass(message.status)}`;
    details.querySelector<HTMLElement>(".reasoning-title")!.textContent = message.title || "思考";
    const preview = message.text.replace(/\s+/g, " ").trim();
    details.querySelector<HTMLElement>(".reasoning-preview")!.textContent =
        preview || (message.status === "inProgress" || message.status === "streaming" ? "正在思考…" : "没有思考摘要");
    const state = details.querySelector<HTMLElement>(".tool-state")!;
    state.className = `tool-state ${activityStatusClass(message.status)}`;
    state.textContent = activityStatusLabel(message.status);
    details.querySelector<HTMLElement>(".reasoning-content")!.textContent = message.text;
    const truncated = details.querySelector<HTMLElement>(".tool-truncated")!;
    truncated.hidden = !message.truncated;
    const hasDetails = Boolean(message.text || message.truncated);
    details.classList.toggle("no-details", !hasDetails);
    if (!hasDetails) details.open = false;
};

type PlanView = {
    explanation: string;
    steps: PlanStep[];
};

const planView = (message: ChatMessage): PlanView => {
    if (Array.isArray(message.plan) && message.plan.length > 0) {
        return {
            explanation: message.text.trim(),
            steps: message.plan.filter((step) => step.step.trim() !== ""),
        };
    }
    const explanation: string[] = [];
    const steps: PlanStep[] = [];
    for (const rawLine of message.text.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^(?:[-*•]|\d+[.)])\s+(?:\[([xX ])\]\s*)?(.*)$/);
        if (!match || !match[2].trim()) {
            explanation.push(line);
            continue;
        }
        steps.push({
            step: match[2].trim(),
            status: match[1]?.toLowerCase() === "x" ? "completed" : "pending",
        });
    }
    return { explanation: explanation.join("\n"), steps };
};

const planStepLabel = (status: PlanStep["status"]): string => {
    if (status === "completed") return "已完成";
    if (status === "inProgress") return "进行中";
    return "待处理";
};

const renderPlanItem = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "plan") {
        article.replaceChildren();
        const card = document.createElement("section");
        card.className = "plan-card";
        const header = document.createElement("header");
        header.className = "plan-header";
        const heading = document.createElement("div");
        heading.className = "plan-heading";
        const headingCopy = document.createElement("div");
        headingCopy.className = "plan-heading-copy";
        const title = document.createElement("div");
        title.className = "plan-title";
        const summary = document.createElement("div");
        summary.className = "plan-summary";
        headingCopy.append(title, summary);
        heading.append(createPlanIcon(), headingCopy);
        const progress = document.createElement("span");
        progress.className = "plan-progress";
        header.append(heading, progress);
        const explanation = document.createElement("div");
        explanation.className = "plan-explanation";
        const steps = document.createElement("ol");
        steps.className = "plan-steps";
        const truncated = document.createElement("div");
        truncated.className = "tool-truncated";
        truncated.textContent = "计划内容过长，已保留开头和末尾。";
        card.append(header, explanation, steps, truncated);
        article.append(card);
        article.dataset.layout = "plan";
    }

    article.className = `timeline-item plan ${activityStatusClass(message.status)}`;
    const card = article.querySelector<HTMLElement>(".plan-card")!;
    card.className = `plan-card ${activityStatusClass(message.status)}`;
    const view = planView(message);
    const completed = view.steps.filter((step) => step.status === "completed").length;
    const activeStep = view.steps.find((step) => step.status === "inProgress");
    card.querySelector<HTMLElement>(".plan-title")!.textContent = message.title || "计划";
    card.querySelector<HTMLElement>(".plan-summary")!.textContent = activeStep
        ? `当前：${activeStep.step}`
        : view.steps.length > 0 && completed === view.steps.length
          ? "全部步骤已完成"
          : view.steps.length > 0
            ? `${view.steps.length - completed} 项待处理`
            : message.status === "streaming"
              ? "正在整理计划…"
              : "计划内容";

    const progress = card.querySelector<HTMLElement>(".plan-progress")!;
    progress.hidden = view.steps.length === 0;
    progress.textContent = `${completed} / ${view.steps.length}`;
    const explanation = card.querySelector<HTMLElement>(".plan-explanation")!;
    explanation.hidden = view.explanation === "";
    explanation.classList.toggle("standalone", view.steps.length === 0);
    explanation.textContent = view.explanation;

    const list = card.querySelector<HTMLOListElement>(".plan-steps")!;
    list.hidden = view.steps.length === 0;
    list.replaceChildren();
    for (const step of view.steps) {
        const item = document.createElement("li");
        item.className = `plan-step ${step.status}`;
        const marker = document.createElement("span");
        marker.className = "plan-step-marker";
        marker.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.className = "plan-step-text";
        text.textContent = step.step;
        const state = document.createElement("span");
        state.className = "plan-step-state";
        state.textContent = planStepLabel(step.status);
        item.append(marker, text, state);
        list.append(item);
    }

    const truncated = card.querySelector<HTMLElement>(".tool-truncated")!;
    truncated.hidden = !message.truncated;
};

const createToolSection = (name: string, label: string): HTMLElement => {
    const section = document.createElement("section");
    section.className = "tool-detail-section";
    section.dataset.toolSection = name;
    const heading = document.createElement("div");
    heading.className = "tool-detail-label";
    heading.textContent = label;
    const content = document.createElement("pre");
    section.append(heading, content);
    return section;
};

const renderToolItem = (article: HTMLElement, message: ChatMessage) => {
    if (article.dataset.layout !== "tool") {
        article.replaceChildren();
        const details = document.createElement("details");
        details.className = "tool-card";
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "tool-icon";
        const copy = document.createElement("span");
        copy.className = "tool-summary-copy";
        const title = document.createElement("span");
        title.className = "tool-title";
        const preview = document.createElement("span");
        preview.className = "tool-preview";
        copy.append(title, preview);
        const state = document.createElement("span");
        state.className = "tool-state";
        summary.append(icon, copy, state, createDisclosureIcon());
        const body = document.createElement("div");
        body.className = "tool-detail-body";
        body.append(createToolSection("input", "调用信息"), createToolSection("output", "结果与输出"));
        const truncated = document.createElement("div");
        truncated.className = "tool-truncated";
        truncated.textContent = "内容过长，已保留开头和末尾。";
        body.append(truncated);
        details.append(summary, body);
        summary.addEventListener("click", (event) => {
            if (details.classList.contains("no-details")) event.preventDefault();
        });
        article.append(details);
        article.dataset.layout = "tool";
    }
    article.className = "timeline-item tool";
    const details = article.querySelector<HTMLDetailsElement>(".tool-card")!;
    details.className = `tool-card ${message.toolType ?? "generic"} ${activityStatusClass(message.status)}`;
    details.querySelector<HTMLElement>(".tool-icon")!.textContent = toolIcon(message.toolType);
    details.querySelector<HTMLElement>(".tool-title")!.textContent = message.title || "工具调用";
    details.querySelector<HTMLElement>(".tool-preview")!.textContent =
        message.text || (message.status === "inProgress" ? "等待结果…" : "查看详情");
    const state = details.querySelector<HTMLElement>(".tool-state")!;
    state.className = `tool-state ${activityStatusClass(message.status)}`;
    state.textContent = activityStatusLabel(message.status);

    const inputSection = details.querySelector<HTMLElement>('[data-tool-section="input"]')!;
    const outputSection = details.querySelector<HTMLElement>('[data-tool-section="output"]')!;
    inputSection.hidden = !message.input;
    outputSection.hidden = !message.output;
    inputSection.querySelector("pre")!.textContent = message.input ?? "";
    outputSection.querySelector("pre")!.textContent = message.output ?? "";
    const truncated = details.querySelector<HTMLElement>(".tool-truncated")!;
    truncated.hidden = !message.truncated;
    const hasDetails = Boolean(message.input || message.output || message.truncated);
    details.classList.toggle("no-details", !hasDetails);
    if (!hasDetails) details.open = false;
};

const renderMessages = (session?: CodexSession) => {
    const nextBlockId = session?.blockId ?? "";
    const sessionChanged = renderedBlockId !== nextBlockId;
    if (sessionChanged) {
        messageList.replaceChildren();
        renderedBlockId = nextBlockId;
    }
    const wasNearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
    const messages = session?.messages ?? [];
    if (!session || messages.length === 0) {
        messageList.replaceChildren();
        messageList.hidden = true;
        emptyState.hidden = false;
        const title = emptyState.querySelector("h1");
        const text = emptyState.querySelector("p");
        if (session) {
            if (title) title.textContent = session.threadId ? "这段对话还没有消息" : "Codex 正在建立会话";
            if (text) {
                text.textContent = session.threadId
                    ? "你可以从这里发送第一条消息，桌面端 Codex TUI 会同步显示。"
                    : "完成 Codex 的会话选择后，这里会自动载入历史消息。";
            }
        } else {
            if (title) title.textContent = "从终端继续你的 Codex 对话";
            if (text)
                text.textContent = "在任意 Wave 终端运行 codex、codex resume 或 codex fork，对应会话会自动出现在这里。";
        }
        return;
    }
    emptyState.hidden = true;
    messageList.hidden = false;
    const existing = new Map<string, HTMLElement>();
    for (const child of Array.from(messageList.children)) {
        const article = child as HTMLElement;
        if (article.dataset.messageId) existing.set(article.dataset.messageId, article);
    }
    const retained = new Set<string>();
    messages.forEach((message, index) => {
        let article = existing.get(message.id);
        if (!article) {
            article = document.createElement("article");
        }
        retained.add(message.id);
        article.dataset.messageId = message.id;
        const kind = message.kind ?? "message";
        if (kind === "tool") {
            renderToolItem(article, message);
        } else if (kind === "reasoning") {
            renderReasoningItem(article, message);
        } else if (kind === "plan") {
            renderPlanItem(article, message);
        } else {
            renderConversationMessage(article, message);
        }
        const currentAtIndex = messageList.children.item(index);
        if (currentAtIndex !== article) messageList.insertBefore(article, currentAtIndex);
    });
    for (const [messageId, article] of existing) {
        if (!retained.has(messageId)) article.remove();
    }
    requestAnimationFrame(() => {
        if (sessionChanged || wasNearBottom) {
            chatScroll.scrollTop = chatScroll.scrollHeight;
        }
    });
};

const updateComposer = (session?: CodexSession) => {
    const ready = Boolean(session?.threadId);
    messageInput.disabled = !ready || sending;
    sendButton.disabled = !ready || sending || messageInput.value.trim() === "";
    messageInput.placeholder = ready ? "给 Codex 发送消息…" : "选择一个已就绪的 Codex 会话";
    interruptButton.hidden = !session?.activeTurnId;
    sessionError.hidden = !session?.error;
    sessionError.textContent = session?.error ?? "";
};

const render = () => {
    if (sessions.length > 0 && !selectedSession()) {
        selectedBlockId = sessions[0].blockId;
        localStorage.setItem("wave-codex-selected", selectedBlockId);
    }
    const selected = selectedSession();
    renderSessionList();
    if (selected) {
        conversationTitle.textContent = selected.title;
        const connection = selected.connection && selected.connection !== "local" ? selected.connection : "本机";
        conversationMeta.textContent = [connection, compactPath(selected.cwd)].filter(Boolean).join(" · ");
    } else {
        conversationTitle.textContent = "等待 Codex 会话";
        conversationMeta.textContent = "请先在 Wave 终端中运行 codex";
    }
    renderMessages(selected);
    updateComposer(selected);
};

const applySessions = (nextSessions?: RawCodexSession[] | null) => {
    sessions = (Array.isArray(nextSessions) ? nextSessions : []).map((session) => ({
        ...session,
        messages: (Array.isArray(session.messages) ? session.messages : []).map((message) => ({
            ...message,
            plan: Array.isArray(message.plan) ? message.plan : [],
        })),
    }));
    render();
};

const connectEvents = () => {
    eventSource?.close();
    connectionState.dataset.state = "connecting";
    connectionLabel.textContent = "连接中";
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("sessions", (event) => {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { sessions?: RawCodexSession[] | null };
        applySessions(payload.sessions);
        connectionState.dataset.state = "online";
        connectionLabel.textContent = "已同步";
    });
    eventSource.onerror = async () => {
        connectionState.dataset.state = "offline";
        connectionLabel.textContent = "重连中";
        if (checkingAuth) return;
        checkingAuth = true;
        try {
            const response = await api("/api/session");
            if (response.status === 401) showLogin();
        } catch {
            // EventSource will retry automatically while the service is unreachable.
        } finally {
            checkingAuth = false;
        }
    };
};

const showApp = () => {
    loginScreen.hidden = true;
    appShell.hidden = false;
    connectEvents();
};

const showLogin = () => {
    eventSource?.close();
    eventSource = null;
    appShell.hidden = true;
    loginScreen.hidden = false;
    requestAnimationFrame(() => accessToken.focus());
};

const autoSizeComposer = () => {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
    updateComposer(selectedSession());
};

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginError.textContent = "";
    let response: Response;
    try {
        response = await api("/api/login", {
            method: "POST",
            body: JSON.stringify({ token: accessToken.value }),
        });
    } catch {
        loginError.textContent = "无法连接到 Wave Codex 服务";
        return;
    }
    if (!response.ok) {
        loginError.textContent = await parseError(response);
        accessToken.select();
        return;
    }
    accessToken.value = "";
    showApp();
});

composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const session = selectedSession();
    const text = messageInput.value.trim();
    if (!session?.threadId || !text || sending) return;
    sending = true;
    updateComposer(session);
    let response: Response;
    try {
        response = await api(`/api/sessions/${encodeURIComponent(session.blockId)}/messages`, {
            method: "POST",
            body: JSON.stringify({ text }),
        });
    } catch {
        sending = false;
        updateComposer(selectedSession());
        sessionError.hidden = false;
        sessionError.textContent = "消息发送失败，请检查连接后重试";
        return;
    }
    sending = false;
    if (!response.ok) {
        updateComposer(selectedSession());
        sessionError.hidden = false;
        sessionError.textContent = await parseError(response);
        return;
    }
    messageInput.value = "";
    autoSizeComposer();
    messageInput.focus();
});

messageInput.addEventListener("input", autoSizeComposer);
messageInput.addEventListener("compositionstart", () => {
    composing = true;
});
messageInput.addEventListener("compositionend", () => {
    composing = false;
});
messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing) {
        event.preventDefault();
        composer.requestSubmit();
    }
});

interruptButton.addEventListener("click", async () => {
    const session = selectedSession();
    if (!session?.activeTurnId) return;
    let response: Response;
    try {
        response = await api(`/api/sessions/${encodeURIComponent(session.blockId)}/interrupt`, { method: "POST" });
    } catch {
        sessionError.hidden = false;
        sessionError.textContent = "停止请求发送失败，请检查连接后重试";
        return;
    }
    if (!response.ok) {
        sessionError.hidden = false;
        sessionError.textContent = await parseError(response);
    }
});

sessionSearch.addEventListener("input", renderSessionList);
getElement<HTMLButtonElement>("sidebar-open").addEventListener("click", openSidebar);
getElement<HTMLButtonElement>("sidebar-close").addEventListener("click", closeSidebar);
sidebarBackdrop.addEventListener("click", closeSidebar);
getElement<HTMLButtonElement>("logout").addEventListener("click", async () => {
    try {
        await api("/api/logout", { method: "POST" });
    } catch {
        // Clear local UI even if the server became unavailable.
    }
    sessions = [];
    showLogin();
});

const syncVisualViewport = () => {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    document.documentElement.style.setProperty("--visual-height", `${Math.round(height)}px`);
    document.documentElement.style.setProperty("--visual-top", `${Math.round(offsetTop)}px`);
};

window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
window.addEventListener("resize", syncVisualViewport);
window.addEventListener("pageshow", syncVisualViewport);
syncVisualViewport();

void (async () => {
    try {
        const response = await api("/api/session");
        if (response.ok) {
            showApp();
        } else {
            showLogin();
        }
    } catch {
        showLogin();
        loginError.textContent = "无法连接到 Wave Codex 服务";
    }
})();
