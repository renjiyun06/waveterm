// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { blockExternalWebviewNavigation, isAllowedWebviewNavigationUrl } from "./emain-webview-navigation";

describe("webview navigation policy", () => {
    it.each([
        "https://www.douyin.com/",
        "http://localhost:3000/",
        "file:///C:/Users/test/index.html",
        "about:blank",
        "blob:https://www.douyin.com/01234567-89ab-cdef-0123-456789abcdef",
        "data:text/plain,hello",
    ])("allows browser-renderable URL %s", (url) => {
        expect(isAllowedWebviewNavigationUrl(url)).toBe(true);
    });

    it.each([
        "bytedance://aweme/detail/123",
        "snssdk1128://aweme/detail/123",
        "intent://aweme/detail/123",
        "itms-apps://itunes.apple.com/app/id123",
        "ms-windows-store://pdp/?productid=123",
        "javascript:alert(1)",
        "",
        "not a url",
    ])("blocks external application URL %s", (url) => {
        expect(isAllowedWebviewNavigationUrl(url)).toBe(false);
    });

    it("cancels external application navigation", () => {
        const preventDefault = vi.fn();

        expect(
            blockExternalWebviewNavigation({ preventDefault }, "bytedance://aweme/detail/123", "will-frame-navigate")
        ).toBe(true);
        expect(preventDefault).toHaveBeenCalledOnce();
    });
});
