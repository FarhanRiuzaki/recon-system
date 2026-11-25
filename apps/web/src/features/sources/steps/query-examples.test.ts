import { describe, expect, it } from "vitest";
import { DB_ENGINES } from "@starterkit/shared/sources";
import { noteParts, queryExample } from "./query-examples";

describe("query examples per engine", () => {
  it("every engine has a snapshot and a watermark example the connector would take", () => {
    for (const engine of DB_ENGINES) {
      const snap = queryExample(engine, "db_snapshot");
      const pull = queryExample(engine, "db_watermark");
      for (const ex of [snap, pull]) {
        // checkSelect: one SELECT, no `;`, no comments; SQL Server reads it as a subquery (no WITH, no ORDER BY)
        expect(ex.sql).toMatch(/^SELECT\b/);
        expect(ex.sql).not.toMatch(/;|--|\/\*/);
        if (engine === "mssql") expect(ex.sql).not.toMatch(/\bWITH\b|\bORDER BY\b/i);
        expect(ex.notes.length).toBeGreaterThan(2);
      }
      // the contract refuses a snapshot query without :business_date; a watermark query has no business date
      expect(snap.sql).toContain(":business_date");
      expect(pull.sql).not.toContain(":business_date");
      // the business date column stays a date: never formatted to text in the example itself
      expect(snap.sql).not.toMatch(/to_char|date_format|convert\(/i);
    }
  });

  it("Oracle says :business_date is already a DATE, the day before, and that names come back in capitals", () => {
    const { sql, notes } = queryExample("oracle", "db_snapshot");
    expect(sql).toContain(":business_date + 1");
    const text = notes.join(" ");
    expect(text).toContain("TO_DATE('2026-11-24', 'YYYY-MM-DD')");
    expect(text).toContain(":business_date - 1");
    expect(text).toContain("VARCHAR2, which only a String field can read");
    expect(text).toContain("capitals");
    expect(queryExample("mssql", "db_snapshot").notes.join(" ")).toContain("DATEADD(day, -1, :business_date)");
    expect(queryExample("mysql", "db_snapshot").notes.join(" ")).toContain(":business_date - INTERVAL 1 DAY");
  });

  it("each note's code parts are closed, and the copy keeps the guide's words out", () => {
    for (const engine of DB_ENGINES) {
      for (const kind of ["db_snapshot", "db_watermark"] as const) {
        for (const n of queryExample(engine, kind).notes) {
          expect(noteParts(n).length % 2).toBe(1);
          expect(n).not.toMatch(/\b(just|simply|easily|successfully|utilize|sorry|oops)\b|in order to|N\/A|!/i);
        }
      }
    }
    expect(noteParts("Use `a` then `b`.")).toEqual(["Use ", "a", " then ", "b", "."]);
  });
});
