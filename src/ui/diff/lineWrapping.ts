import type { App, MenuItem } from "obsidian";
import { DIFF_VIEW_CONFIG, SPLIT_DIFF_VIEW_CONFIG } from "src/constants";
import type ObsidianGit from "src/main";

/**
 * A diff view, which can switch between wrapped and horizontally scrolling
 * lines.
 */
interface LineWrappingView {
    applyLineWrapping(): void;
}

/**
 * Whether the given view supports switching the line wrapping.
 *
 * @param view The view of a workspace leaf.
 * @returns `true` for the diff views.
 */
function isLineWrappingView(view: unknown): view is LineWrappingView {
    return (
        typeof view == "object" &&
        view !== null &&
        "applyLineWrapping" in view &&
        typeof view.applyLineWrapping == "function"
    );
}

/**
 * Applies the line wrapping setting to all opened diff views.
 *
 * @param app The Obsidian app.
 */
export function refreshDiffLineWrapping(app: App): void {
    for (const type of [DIFF_VIEW_CONFIG.type, SPLIT_DIFF_VIEW_CONFIG.type]) {
        for (const leaf of app.workspace.getLeavesOfType(type)) {
            // Deferred views apply the setting, when they get loaded
            if (leaf.isDeferred ?? false) continue;
            if (isLineWrappingView(leaf.view)) {
                leaf.view.applyLineWrapping();
            }
        }
    }
}

/**
 * Configures a context menu item, which toggles the global line wrapping
 * setting and applies it to all opened diff views.
 *
 * @param plugin The plugin instance.
 * @param item The context menu item to configure.
 */
export function lineWrappingMenuItem(
    plugin: ObsidianGit,
    item: MenuItem
): void {
    item.setTitle("Wrap lines")
        .setIcon("wrap-text")
        .setChecked(plugin.settings.diffLineWrapping)
        .onClick(async () => {
            // Persist the toggled value as the global setting
            plugin.settings.diffLineWrapping =
                !plugin.settings.diffLineWrapping;
            await plugin.saveSettings();
            refreshDiffLineWrapping(plugin.app);
        });
}
