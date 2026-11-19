"use client";

import dynamic from "next/dynamic";

/**
 * The space switcher as its own chunk: server-rendered (filled on first paint), its code loaded beside the shell
 * rather than inside every route's first-load JS (AGENTS §9: next/dynamic when a route nears the budget).
 */
export const LazySpaceSwitcher = dynamic(() => import("./space-switcher").then((m) => m.SpaceSwitcher));
