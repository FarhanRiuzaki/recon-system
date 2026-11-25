import { bigint, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { spaces } from "../spaces/schema";
import { users } from "../users/schema";

/**
 * Who uploaded which file into a space's inbox through the app (Inbox files). The folder on disk is the truth for which
 * files exist; a file without a row arrived another way (FTP, copied by IT). Space-owned under row level security.
 */
export const inboxUploads = pgTable("inbox_uploads", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  folder: text("folder").notNull(),
  name: text("name").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  /** null once that user is deleted (the activity log keeps who it was). */
  uploadedBy: uuid("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "inbox_uploads_space_id_fkey", columns: [t.spaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
  foreignKey({ name: "inbox_uploads_uploaded_by_fkey", columns: [t.uploadedBy], foreignColumns: [users.id] }).onDelete("set null"),
  uniqueIndex("inbox_uploads_file_key").on(t.spaceId, t.folder, t.name, t.sha256),
  index("inbox_uploads_folder").on(t.spaceId, t.folder),
]);
