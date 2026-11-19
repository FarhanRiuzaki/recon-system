import { createHash } from "node:crypto";
import type { VersionStatus } from "@starterkit/shared/sources";

/** `v` with every object's keys sorted, at any depth; arrays keep their order (field order means something). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/** SHA-256 (hex) of the spec as canonical JSON: the same spec gives the same hash whatever order its keys came in. */
export const specHash = (spec: unknown): string => createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex");

/** The status a version must be in for each step: edit and submit a draft; approve or reject one in review. */
const FROM = { edit: "draft", submit: "draft", approve: "in_review", reject: "in_review" } as const satisfies Record<string, VersionStatus>;
export type VersionStep = keyof typeof FROM;
export const canStep = (step: VersionStep, status: VersionStatus): boolean => FROM[step] === status;
