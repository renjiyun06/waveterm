// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import DOMPurify from "dompurify";
import { marked } from "marked";

const allowedTags = [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "input",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];

const allowedAttributes = ["aria-label", "checked", "class", "disabled", "href", "title", "type"];

marked.setOptions({
    async: false,
    breaks: false,
    gfm: true,
});

const isSafeLink = (href: string): boolean => {
    if (href.trim() === "") return false;
    if (href.startsWith("#")) return true;
    try {
        const url = new URL(href, window.location.href);
        return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
    } catch {
        return false;
    }
};

export const renderMarkdown = (text: string): string => {
    const parsed = marked.parse(text) as string;
    return DOMPurify.sanitize(parsed, {
        ALLOWED_ATTR: allowedAttributes,
        ALLOWED_TAGS: allowedTags,
        FORBID_ATTR: ["style"],
        FORBID_TAGS: ["audio", "iframe", "img", "object", "script", "source", "style", "svg", "video"],
    });
};

export const renderMarkdownInto = (container: HTMLElement, text: string): void => {
    container.innerHTML = renderMarkdown(text);
    for (const link of container.querySelectorAll<HTMLAnchorElement>("a")) {
        const href = link.getAttribute("href") ?? "";
        if (!isSafeLink(href)) {
            link.removeAttribute("href");
            link.removeAttribute("rel");
            link.removeAttribute("target");
            continue;
        }
        if (!href.startsWith("#")) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        }
    }
    for (const input of container.querySelectorAll<HTMLInputElement>("input")) {
        if (input.type !== "checkbox") {
            input.remove();
            continue;
        }
        input.disabled = true;
        input.tabIndex = -1;
    }
};
