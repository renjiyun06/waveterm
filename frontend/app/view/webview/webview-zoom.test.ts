// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { checkKeyPressed } from "@/util/keyutil";
import { describe, expect, test } from "vitest";
import { getAdjacentWebViewZoomFactor, getWebViewZoomAction, WebViewZoomKeyDescriptions } from "./webview-zoom";

function makeKeyEvent(overrides: Partial<WaveKeyboardEvent>): WaveKeyboardEvent {
    return {
        type: "keydown",
        key: "",
        code: "",
        ...overrides,
    };
}

describe("webview zoom shortcuts", () => {
    test("recognizes Ctrl plus, minus, and zero variants", () => {
        const plusEvent = makeKeyEvent({ control: true, shift: true, key: "+", code: "Equal" });
        expect(getWebViewZoomAction(plusEvent)).toBe("in");
        expect(WebViewZoomKeyDescriptions.some((description) => checkKeyPressed(plusEvent, description))).toBe(true);
        expect(getWebViewZoomAction(makeKeyEvent({ control: true, key: "-", code: "Minus" }))).toBe("out");
        expect(getWebViewZoomAction(makeKeyEvent({ control: true, key: "+", code: "NumpadAdd" }))).toBe("in");
        expect(getWebViewZoomAction(makeKeyEvent({ control: true, key: "0", code: "Numpad0" }))).toBe("reset");
    });

    test("ignores shortcuts without Ctrl or with an application modifier", () => {
        expect(getWebViewZoomAction(makeKeyEvent({ key: "+", code: "Equal" }))).toBeNull();
        expect(getWebViewZoomAction(makeKeyEvent({ control: true, alt: true, key: "+", code: "Equal" }))).toBeNull();
        expect(getWebViewZoomAction(makeKeyEvent({ control: true, meta: true, key: "-", code: "Minus" }))).toBeNull();
    });

    test("moves through browser-style zoom levels and clamps at the ends", () => {
        expect(getAdjacentWebViewZoomFactor(1, "in")).toBe(1.1);
        expect(getAdjacentWebViewZoomFactor(1, "out")).toBe(0.9);
        expect(getAdjacentWebViewZoomFactor(1.13, "in")).toBe(1.25);
        expect(getAdjacentWebViewZoomFactor(5, "in")).toBe(5);
        expect(getAdjacentWebViewZoomFactor(0.25, "out")).toBe(0.25);
    });
});
