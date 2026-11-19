// Public API of the sources module: its routes, the global calendar table (the system seed writes id-default) and the
// source tables the ingest module reads (a source, its published version, connection and shares) under withSpace.
export { sourcesController } from "./controller";
export { calendars, sourceConnections, sources, sourceShares, sourceVersions } from "./schema";
