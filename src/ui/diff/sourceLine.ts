import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import type { WorkspaceLeaf } from "obsidian";
import { MarkdownView, TFile } from "obsidian";
import type ObsidianGit from "src/main";

/**
 * The diff config used for line mappings, which are computed on demand
 * outside of a merge view.
 */
const LINE_MAPPING_DIFF_CONFIG = {
    scanLimit: 1000,
    timeout: 200,
};

/**
 * A line range of one side of a chunk. `start` is inclusive and `end` is
 * exclusive, both are 1-based line numbers.
 */
interface ChunkLineRange {
    start: number;
    end: number;
}

/**
 * Converts a position range of a chunk side to a line range.
 *
 * @param doc The document of that chunk side.
 * @param from The start position of the chunk side.
 * @param to The end position of the chunk side, which may point one past the document end.
 * @returns The 1-based line range, where `end` is exclusive.
 */
function chunkLineRange(doc: Text, from: number, to: number): ChunkLineRange {
    // The chunk starts at the start of its first line
    const start = doc.lineAt(Math.min(from, doc.length)).number;
    // An empty chunk side covers no lines
    if (from == to) {
        return { start, end: start };
    }
    // `to` points to the start of the line after the chunk or past the document end
    const end = to > doc.length ? doc.lines + 1 : doc.lineAt(to).number;
    return { start, end };
}

/**
 * Clamps a line number to the existing lines of a document.
 *
 * @param doc The document whose lines are the valid range.
 * @param line The 1-based line number to clamp.
 * @returns A 1-based line number, which exists in the document.
 */
function clampLine(doc: Text, line: number): number {
    return Math.min(Math.max(line, 1), doc.lines);
}

/**
 * Maps a line of one document to the matching line of the other document by
 * using the diff chunks between them. Unchanged lines are mapped exactly,
 * changed lines are mapped to the same offset inside the changed block and
 * deleted lines are mapped to the line following the deletion.
 *
 * @param chunks The diff chunks between document a and b.
 * @param aDoc Document a of the chunks.
 * @param bDoc Document b of the chunks.
 * @param line The 1-based line number in the source document.
 * @param fromSide The side of `line`. The result is a line of the other side.
 * @returns The 1-based line number in the other document.
 */
export function mapLineThroughChunks(
    chunks: readonly Chunk[],
    aDoc: Text,
    bDoc: Text,
    line: number,
    fromSide: "a" | "b"
): number {
    const sourceDoc = fromSide == "a" ? aDoc : bDoc;
    const targetDoc = fromSide == "a" ? bDoc : aDoc;
    // Lines before the first chunk are unchanged
    let offset = 0;
    for (const chunk of chunks) {
        const aRange = chunkLineRange(aDoc, chunk.fromA, chunk.toA);
        const bRange = chunkLineRange(bDoc, chunk.fromB, chunk.toB);
        const source = fromSide == "a" ? aRange : bRange;
        const target = fromSide == "a" ? bRange : aRange;

        // The line lies in the unchanged region before this chunk
        if (line < source.start) {
            break;
        }
        // The line lies inside this changed chunk
        if (line < source.end) {
            if (target.end > target.start) {
                // Keep the offset inside the changed block, but stay inside it
                const mapped = Math.min(
                    target.start + (line - source.start),
                    target.end - 1
                );
                return clampLine(targetDoc, mapped);
            }
            // The lines got removed, so use the line following the removal
            return clampLine(targetDoc, target.start);
        }
        // The line lies after this chunk, so the offset of its end applies
        offset = target.end - source.end;
    }
    return clampLine(targetDoc, Math.min(line, sourceDoc.lines) + offset);
}

/**
 * Maps a line of one text to the matching line of another text by computing
 * the diff between them.
 *
 * @param fromText The text containing `line`.
 * @param toText The text the line should be mapped to.
 * @param line The 1-based line number in `fromText`.
 * @returns The 1-based line number in `toText`.
 */
export function mapLineBetweenTexts(
    fromText: string,
    toText: string,
    line: number
): number {
    // Split the same way as the hunk computation of the signs feature
    const fromDoc = Text.of(fromText.split("\n"));
    const toDoc = Text.of(toText.split("\n"));
    // Identical texts don't need a diff
    if (fromText == toText) {
        return clampLine(toDoc, line);
    }
    const chunks = Chunk.build(fromDoc, toDoc, LINE_MAPPING_DIFF_CONFIG);
    return mapLineThroughChunks(chunks, fromDoc, toDoc, line, "a");
}

/**
 * Returns the working tree file of a diff, if Obsidian can open it in a
 * normal editor.
 *
 * @param plugin The plugin instance.
 * @param repoRelativePath The repository relative path of the diff file.
 * @returns The vault file or `undefined` for dot files and deleted files.
 */
export function getSourceFile(
    plugin: ObsidianGit,
    repoRelativePath: string | undefined
): TFile | undefined {
    // The git manager is not ready yet or the diff has no file
    if (!repoRelativePath || !plugin.gitManager) {
        return undefined;
    }
    const vaultPath = plugin.gitManager.getRelativeVaultPath(repoRelativePath);
    const file = plugin.app.vault.getAbstractFileByPath(vaultPath);
    // Only files tracked by Obsidian can be opened in a normal editor
    return file instanceof TFile ? file : undefined;
}

/**
 * Opens a file at the given line. A tab already showing that file is reused,
 * otherwise a new tab is opened, so the diff view stays open.
 *
 * @param plugin The plugin instance.
 * @param file The file to open.
 * @param line The 1-based line number to place the cursor on.
 */
export async function openFileAtLine(
    plugin: ObsidianGit,
    file: TFile,
    line: number
): Promise<void> {
    const workspace = plugin.app.workspace;
    // Find the tabs in the main area, which already show the file
    const openLeaves: WorkspaceLeaf[] = [];
    workspace.iterateRootLeaves((leaf) => {
        const viewState = leaf.getViewState();
        if (
            viewState.type == "markdown" &&
            viewState.state?.file == file.path
        ) {
            openLeaves.push(leaf);
        }
    });
    // Fall back to a new tab to keep the diff view open
    const leaf = openLeaves.first() ?? workspace.getLeaf("tab");

    // The ephemeral line state scrolls the view, also in reading mode
    await leaf.openFile(file, { active: true, eState: { line: line - 1 } });
    await workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });

    const view = leaf.view;
    // Place the cursor on the line, which is only possible in the editor mode
    if (view instanceof MarkdownView && view.getMode() == "source") {
        const editor = view.editor;
        const editorLine = Math.min(Math.max(line - 1, 0), editor.lastLine());
        const position = { line: editorLine, ch: 0 };
        editor.setCursor(position);
        editor.scrollIntoView({ from: position, to: position }, true);
        editor.focus();
    }
}
