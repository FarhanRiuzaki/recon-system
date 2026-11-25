// Public API of the inbox module (Inbox files): its routes, its table, and the rule that names the space and folder an
// inbox path sits in (the sources module refuses another space's folder with it).
export { inboxController } from "./controller";
export { folderOfPath } from "./rules";
export { inboxUploads } from "./schema";
