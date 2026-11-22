/**
 * Whether the screen holds an edit the server doesn't have yet: `body` (what would be saved now) differs from the last
 * body saved, or from the draft as loaded when nothing was saved yet. Sending for approval waits until it doesn't, so
 * the version reviewed is the one on screen.
 */
export const unsaved = (body: string, savedBody: string | null, loadedBody: string): boolean => body !== (savedBody ?? loadedBody);
