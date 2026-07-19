// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { tryReinjectKey } from "@/app/store/keymodel";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { adaptFromReactOrNativeKeyEvent, checkKeyPressed } from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import * as monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { SpecializedViewProps } from "./preview";

export const shellFileMap: Record<string, string> = {
    ".bashrc": "shell",
    ".bash_profile": "shell",
    ".bash_login": "shell",
    ".bash_logout": "shell",
    ".profile": "shell",
    ".zshrc": "shell",
    ".zprofile": "shell",
    ".zshenv": "shell",
    ".zlogin": "shell",
    ".zlogout": "shell",
    ".kshrc": "shell",
    ".cshrc": "shell",
    ".tcshrc": "shell",
    ".xonshrc": "python",
    ".shrc": "shell",
    ".aliases": "shell",
    ".functions": "shell",
    ".exports": "shell",
    ".direnvrc": "shell",
    ".vimrc": "shell",
    ".gvimrc": "shell",
};

function getGitDiffDecorations(
    hunks: GitDiffHunk[],
    monacoApi: typeof monaco
): MonacoTypes.editor.IModelDeltaDecoration[] {
    return hunks.map((hunk) => {
        let changeType = "modified";
        let color = "#58a6ff";
        if (hunk.oldlines == 0) {
            changeType = "added";
            color = "#3fb950";
        } else if (hunk.newlines == 0) {
            changeType = "deleted";
            color = "#f85149";
        }
        const startLine = Math.max(1, hunk.newstart);
        const endLine = Math.max(startLine, startLine + Math.max(1, hunk.newlines) - 1);
        return {
            range: new monacoApi.Range(startLine, 1, endLine, 1),
            options: {
                isWholeLine: true,
                linesDecorationsClassName: `git-change-${changeType}`,
                overviewRuler: {
                    color,
                    position: monacoApi.editor.OverviewRulerLane.Full,
                },
                minimap: {
                    color,
                    position: monacoApi.editor.MinimapPosition.Gutter,
                },
            },
        };
    });
}

function CodeEditPreview({ model }: SpecializedViewProps) {
    const fileContent = useAtomValue(model.fileContent);
    const setNewFileContent = useSetAtom(model.newFileContent);
    const fileInfo = useAtomValue(model.statFile);
    const gitDiffHunks = useAtomValue(model.gitDiffHunksAtom);
    const gitDecorationsRef = useRef<MonacoTypes.editor.IEditorDecorationsCollection>(null);
    const fileName = fileInfo?.path || fileInfo?.name;

    const baseName = fileName ? fileName.split("/").pop() : null;
    const language = baseName && shellFileMap[baseName] ? shellFileMap[baseName] : undefined;

    function codeEditKeyDownHandler(e: WaveKeyboardEvent): boolean {
        if (checkKeyPressed(e, "Cmd:e")) {
            fireAndForget(() => model.setEditMode(false));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:s") || checkKeyPressed(e, "Ctrl:s")) {
            fireAndForget(model.handleFileSave.bind(model));
            return true;
        }
        if (checkKeyPressed(e, "Cmd:r")) {
            fireAndForget(model.handleFileRevert.bind(model));
            return true;
        }
        return false;
    }

    useEffect(() => {
        model.codeEditKeyDownHandler = codeEditKeyDownHandler;
        model.refreshCallback = () => {
            globalStore.set(model.refreshVersion, (v) => v + 1);
        };
        return () => {
            model.codeEditKeyDownHandler = null;
            model.monacoRef.current = null;
            model.refreshCallback = null;
        };
    }, []);

    useEffect(() => {
        gitDecorationsRef.current?.set(getGitDiffDecorations(gitDiffHunks, monaco));
    }, [gitDiffHunks]);

    function onMount(editor: MonacoTypes.editor.IStandaloneCodeEditor, monacoApi: typeof monaco): () => void {
        model.monacoRef.current = editor;
        gitDecorationsRef.current = editor.createDecorationsCollection(
            getGitDiffDecorations(globalStore.get(model.gitDiffHunksAtom), monacoApi)
        );

        const keyDownDisposer = editor.onKeyDown((e: MonacoTypes.IKeyboardEvent) => {
            const waveEvent = adaptFromReactOrNativeKeyEvent(e.browserEvent);
            const handled = tryReinjectKey(waveEvent);
            if (handled) {
                e.stopPropagation();
                e.preventDefault();
            }
        });

        const isFocused = globalStore.get(model.nodeModel.isFocused);
        if (isFocused) {
            editor.focus();
        }

        return () => {
            keyDownDisposer.dispose();
            gitDecorationsRef.current?.clear();
            gitDecorationsRef.current = null;
        };
    }

    return (
        <CodeEditor
            blockId={model.blockId}
            text={fileContent}
            fileName={fileName}
            language={language}
            readonly={fileInfo.readonly}
            onChange={(text) => setNewFileContent(text)}
            onMount={onMount}
        />
    );
}

export { CodeEditPreview };
