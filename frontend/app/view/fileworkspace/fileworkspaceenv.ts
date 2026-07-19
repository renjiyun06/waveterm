// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { MetaKeyAtomFnType, SettingsKeyAtomFnType, WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";

export type FileWorkspaceEnv = WaveEnvSubset<{
    electron: {
        onQuicklook: WaveEnv["electron"]["onQuicklook"];
    };
    rpc: {
        ConnEnsureCommand: WaveEnv["rpc"]["ConnEnsureCommand"];
        FileInfoCommand: WaveEnv["rpc"]["FileInfoCommand"];
        FileReadCommand: WaveEnv["rpc"]["FileReadCommand"];
        FileListCommand: WaveEnv["rpc"]["FileListCommand"];
        FileListStreamCommand: WaveEnv["rpc"]["FileListStreamCommand"];
        FileWriteCommand: WaveEnv["rpc"]["FileWriteCommand"];
        FileMoveCommand: WaveEnv["rpc"]["FileMoveCommand"];
        FileDeleteCommand: WaveEnv["rpc"]["FileDeleteCommand"];
        FileCopyCommand: WaveEnv["rpc"]["FileCopyCommand"];
        FileCreateCommand: WaveEnv["rpc"]["FileCreateCommand"];
        FileMkdirCommand: WaveEnv["rpc"]["FileMkdirCommand"];
        SetConfigCommand: WaveEnv["rpc"]["SetConfigCommand"];
        SetMetaCommand: WaveEnv["rpc"]["SetMetaCommand"];
        FetchSuggestionsCommand: WaveEnv["rpc"]["FetchSuggestionsCommand"];
        DisposeSuggestionsCommand: WaveEnv["rpc"]["DisposeSuggestionsCommand"];
        RemoteGitStatusCommand: WaveEnv["rpc"]["RemoteGitStatusCommand"];
        RemoteGitFileDiffCommand: WaveEnv["rpc"]["RemoteGitFileDiffCommand"];
    };
    atoms: {
        workspace: WaveEnv["atoms"]["workspace"];
        fullConfigAtom: WaveEnv["atoms"]["fullConfigAtom"];
    };
    services: {
        object: WaveEnv["services"]["object"];
    };
    wos: WaveEnv["wos"];
    getBlockMetaKeyAtom: MetaKeyAtomFnType<"connection">;
    getSettingsKeyAtom: SettingsKeyAtomFnType<
        "preview:showhiddenfiles" | "editor:fontsize" | "preview:defaultsort" | "window:magnifiedblockopacity"
    >;
    getConnStatusAtom: WaveEnv["getConnStatusAtom"];
}>;
