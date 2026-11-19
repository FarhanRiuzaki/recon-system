// Public API of the ingest module: the pure parts a pipeline and the sources module call (parse, type, map, derive,
// profile), the preview of a sample, the source database connectors and the file inbox check.
export { compileDerive, runDerive } from "./cel";
export { type Column, type Connector, ConnectorError, connectorFor, type From, type Row, type Secret, within } from "./connectors";
export { inboxProbe } from "./inbox";
export { type Calendar, type CalendarData, type CoreRecord, fileDateOf, makeCalendar, toRecord, specCelError } from "./map";
export { type ParsedLine, parseDelimited, parseText } from "./parse";
export { type ColumnProfile, profile } from "./profile";
export { previewRows, previewSample } from "./preview";
