// Public API of the ingest module: the pure parts the sources module calls (parse, type, map, derive, profile), the
// preview of a sample, the source database connectors and the file inbox check; the pipeline's job handlers and a
// source's schedule; its routes; the one source health rule; and the seams later plans fill (ingestHooks).
export { compileDerive, runDerive } from "./cel";
export { type Column, type Connector, ConnectorError, connectorFor, type From, type Row, type Secret, within } from "./connectors";
export { ingestController } from "./controller";
export { type HealthSource, type SourceHealth, sourceHealth } from "./health";
export { inboxProbe } from "./inbox";
export { type Calendar, type CalendarData, type CoreRecord, fileDateOf, makeCalendar, toRecord, specCelError } from "./map";
export { type ParsedLine, parseDelimited, parseText } from "./parse";
export { type ColumnProfile, profile } from "./profile";
export { previewRows, previewSample } from "./preview";
export { records, sourceCursors, sourceFiles, sourceSnapshots } from "./schema";
export { currentRecord, ingestHandlers, ingestHooks, scheduleSource } from "./service";
