// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type WebViewZoomAction = "in" | "out" | "reset";

const WebViewZoomKeyDescriptions = [
    "Ctrl:=",
    "Ctrl:Shift:=",
    "Ctrl:+",
    "Ctrl:Shift:+",
    "Ctrl:c{Equal}",
    "Ctrl:Shift:c{Equal}",
    "Ctrl:c{NumpadAdd}",
    "Ctrl:-",
    "Ctrl:Shift:-",
    "Ctrl:c{Minus}",
    "Ctrl:Shift:c{Minus}",
    "Ctrl:c{NumpadSubtract}",
    "Ctrl:0",
    "Ctrl:c{Digit0}",
    "Ctrl:c{Numpad0}",
];

const BrowserZoomFactors = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function getWebViewZoomAction(event: WaveKeyboardEvent): WebViewZoomAction | null {
    if (!event.control || event.alt || event.meta) {
        return null;
    }

    if (event.code === "Equal" || event.code === "NumpadAdd" || event.key === "+" || event.key === "=") {
        return "in";
    }
    if (event.code === "Minus" || event.code === "NumpadSubtract" || event.key === "-" || event.key === "_") {
        return "out";
    }
    if (!event.shift && (event.code === "Digit0" || event.code === "Numpad0" || event.key === "0")) {
        return "reset";
    }
    return null;
}

function getAdjacentWebViewZoomFactor(currentFactor: number, direction: "in" | "out"): number {
    const epsilon = 0.001;
    if (direction === "in") {
        return (
            BrowserZoomFactors.find((factor) => factor > currentFactor + epsilon) ??
            BrowserZoomFactors[BrowserZoomFactors.length - 1]
        );
    }
    for (let index = BrowserZoomFactors.length - 1; index >= 0; index--) {
        if (BrowserZoomFactors[index] < currentFactor - epsilon) {
            return BrowserZoomFactors[index];
        }
    }
    return BrowserZoomFactors[0];
}

export { BrowserZoomFactors, WebViewZoomKeyDescriptions, getAdjacentWebViewZoomFactor, getWebViewZoomAction };
export type { WebViewZoomAction };
