// Public API of the ingest module: the pure parts the sources module calls (parse, type, map, derive, profile), the
// preview of a sample, the source database connectors and the file inbox check; the pipeline's job handlers and a
// source's schedule; the signed amount the engine reads (signedAmount); its routes; the one source health rule and the
// read model the sources screens show (sourceStates); and the seams later plans fill (ingestHooks).
export { compileDerive, runDerive } from "./cel";
export {
  CATALOG_COUNT_CAP, CATALOG_DATABASES_MAX, CATALOG_TABLES_PAGE, type CatalogTable, type Column, type Connector, ConnectorError, type ConnectorErrorKind, connectorFor, DEFAULT_DATABASE, type From,
  HOSTNAME_MISMATCH_CODES, NO_TLS_CODES, type Row, type Secret, within,
} from "./connectors";
export { ingestController } from "./controller";
export { rawHashOf } from "./copy";
export { type HealthSource, type SourceHealth, sourceHealth } from "./health";
export { inboxProbe } from "./inbox";
export { type Calendar, type CalendarData, type CoreRecord, fileDateOf, makeCalendar, signedAmount, toRecord, specCelError } from "./map";
export { type ParsedLine, parseDelimited, parseText } from "./parse";
export { type ColumnProfile, profile } from "./profile";
export { previewRows, previewSample } from "./preview";
export { quarantineRows, records, sourceCursors, sourceFiles, sourceSnapshots } from "./schema";
export { deadlineOn, endOfDay, previousBusinessDay, todayIn } from "./rules";
export { currentRecord, type HealthInputs, ingestHandlers, ingestHooks, recountDays, scheduleSource, type SourceState, sourceDays, sourceStates } from "./service";
