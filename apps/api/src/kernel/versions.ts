// Maker-checker versions of a spec (sources, recon): its hash, the step a status allows, and why the contract refused
// a spec, in words for a person. Pure.
import { createHash } from "node:crypto";
import { $ZodError } from "zod/v4/core";
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

/**
 * Why the contract refused a spec, naming the field ("Check mapping.amount_minor: The amount needs …."), when the reason
 * was written for a person (a refine or a pattern with its own message); null for any other schema miss (the fixed 400).
 * `root` is where the spec sits in the body. The same shape as a CEL error ("Check the expression at derive.x: …").
 * `place` names the spot in words instead (the recon builder's "Pass 2, condition 1"), the sentence then reads "<place>: <why>".
 */
export function specIssue(e: unknown, root = "spec", place?: (path: PropertyKey[]) => string): string | null {
  if (!(e instanceof $ZodError)) return null;
  // a union (the preview body) holds each option's issues, with paths relative to the union's
  type Issue = (typeof e.issues)[number];
  // a record's refused key (an attrs name) holds its own issues, at the key's path
  const flat = (xs: Issue[], at: PropertyKey[] = []): Issue[] => xs.flatMap((x) => x.code === "invalid_union"
    ? flat(x.errors.flat(), [...at, ...x.path])
    : x.code === "invalid_key" ? flat(x.issues as Issue[], [...at, ...x.path]) : [{ ...x, path: [...at, ...x.path] }]);
  const i = flat(e.issues).find((x) => x.path[0] === root && (x.code === "custom" || (x.code === "invalid_format" && !x.message.startsWith("Invalid"))));
  if (!i) return null;
  const why = i.message.charAt(0).toUpperCase() + i.message.slice(1);
  const end = /[.?]$/.test(why) ? "" : ".";
  return place ? `${place(i.path.slice(1))}: ${why}${end}` : `Check ${i.path.slice(1).join(".")}: ${why}${end}`;
}
