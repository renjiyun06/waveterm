// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type BlockTitleMetaKey = "frame:text" | "frame:title";

function getBlockTitleMetaKey(useTermHeader: boolean): BlockTitleMetaKey {
    return useTermHeader ? "frame:text" : "frame:title";
}

function buildBlockTitleMeta(titleKey: BlockTitleMetaKey, title: string): MetaType {
    const normalizedTitle = title.trim();
    return {
        [titleKey]: normalizedTitle === "" ? null : normalizedTitle,
    } as MetaType;
}

export { buildBlockTitleMeta, getBlockTitleMetaKey };
export type { BlockTitleMetaKey };
