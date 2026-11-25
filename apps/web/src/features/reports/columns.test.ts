import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReportFileDto } from "@starterkit/shared/contracts/reports";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { fileColumns } from "./report-columns";

const f = (o: Partial<ReportFileDto>): ReportFileDto => ({
  id: "F", templateId: "T", template: "Recap", version: 1, configId: "C", recon: "KSEI", from: "2026-11-02", to: "2026-11-02", format: "csv", status: "ready", progress: 100,
  final: true, dates: [], rows: 1, size: 10, masking: "masked", fileName: "a.csv", fileVersion: 1, madeBy: { kind: "run", runId: "R" }, error: null, madeAt: "2026-11-02T00:00:00Z", readyAt: null, ...o,
});
const cell = (file: ReportFileDto, can: { full: boolean; generate: boolean }) => renderToStaticMarkup(h(TooltipProvider, null, h(Fragment, null, fileColumns("S", () => {}, can).find((c) => c.key === "get")!.cell(file))));

describe("a file's download cell", () => {
  it("a file with full customer data offers Download only to who may; others see why", () => {
    expect(cell(f({ masking: "full" }), { full: true, generate: true })).toContain("download-full");
    const no = cell(f({ masking: "full" }), { full: false, generate: true });
    expect(no).not.toContain("download-full");
    expect(no).toContain("Only a space admin, a reviewer or a config checker downloads full customer data.");
  });
  it("Make again only for who may make reports", () => {
    expect(cell(f({ status: "failed", error: "x" }), { full: false, generate: false })).toContain("Only a space admin, config maker, operator or reviewer makes a report.");
  });
});
