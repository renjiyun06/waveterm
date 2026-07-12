// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { shouldShowWorkspaceTopBar } from "./fullscreen";

describe("workspace full screen chrome", () => {
    it("shows the top bar in a normal window", () => {
        expect(shouldShowWorkspaceTopBar(false)).toBe(true);
    });

    it("hides the top bar in full screen", () => {
        expect(shouldShowWorkspaceTopBar(true)).toBe(false);
    });
});
