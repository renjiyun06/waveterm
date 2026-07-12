// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

function shouldShowWorkspaceTopBar(isFullScreen: boolean): boolean {
    return !isFullScreen;
}

export { shouldShowWorkspaceTopBar };
