// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const AllowedWebviewNavigationProtocols = new Set(["http:", "https:", "file:", "about:", "blob:", "data:"]);

export function isAllowedWebviewNavigationUrl(url: string): boolean {
    if (!url) {
        return false;
    }
    try {
        return AllowedWebviewNavigationProtocols.has(new URL(url).protocol.toLowerCase());
    } catch {
        return false;
    }
}

export function blockExternalWebviewNavigation(
    event: Pick<Electron.Event, "preventDefault">,
    url: string,
    source: string
): boolean {
    if (isAllowedWebviewNavigationUrl(url)) {
        return false;
    }
    console.warn(`blocked external webview navigation (${source})`, url);
    event.preventDefault();
    return true;
}
