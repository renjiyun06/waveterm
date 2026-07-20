// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite";

export default defineConfig({
    root: import.meta.dirname,
    base: "/",
    build: {
        target: "es2022",
        outDir: "../../dist/webremote",
        emptyOutDir: true,
        sourcemap: true,
    },
});
