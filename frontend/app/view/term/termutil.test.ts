// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DefaultTermTheme } from "./termutil";

describe("terminal theme defaults", () => {
    it("uses Monokai when no theme override is configured", () => {
        expect(DefaultTermTheme).toBe("monokai");
    });
});
