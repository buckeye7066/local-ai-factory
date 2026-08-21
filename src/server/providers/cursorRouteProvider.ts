/**
 * cursorRouteProvider.ts — Cursor as a rotation POOL.
 *
 * TypeScript sibling of `C:\Users\firer\flexfactor\providers\cursor_provider.py`.
 * Cursor's subscription is its own quota ledger, so treating it as a distinct
 * pool spreads real load even though the transport is an ordinary
 * OpenAI-compatible HTTP endpoint — which this repo's rotatingProvider already
 * speaks. So this module is deliberately thin: it decides WHETHER a `cursor`
 * route is serviceable and WHERE it points, and hands the wire work back.
 *
 * MODES (same as the Python twin)
 * -------------------------------
 * 1. HTTP mode: `FACTORY_CURSOR_BASE_URL` points at a local Cursor daemon
 *    exposing an OpenAI-compatible endpoint (e.g. http://127.0.0.1:3000/v1).
 * 2. Pass-through mode: the catalog route carries its own `base_url`; Cursor
 *    is still a separate POOL even when the upstream host is shared.
 * 3. Fail-closed: with neither, {@link makeCursorRoute} throws and the catalog
 *    filter EXCLUDES the route with a named reason. It never falls back to
 *    "some other endpoint that happened to be handy" — a rotated call that
 *    silently lands somewhere else is the misreporting class this codebase
 *    keeps re-learning.
 *
 * SECRETS: `FACTORY_CURSOR_API_KEY` is read from the environment at call time
 * and never logged or written into any catalog or state file. A local daemon
 * usually needs no token at all.
 */
import { extensionsEnabled } from "./extensionSwitch.js";

/** Cursor cannot serve this route. The catalog filter turns this into a reason. */
export class CursorUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorUnavailable";
  }
}

export const CURSOR_API = "cursor";

export function cursorBaseUrl(): string {
  return (process.env.FACTORY_CURSOR_BASE_URL || "").trim();
}

export function cursorApiKey(): string {
  return (process.env.FACTORY_CURSOR_API_KEY || "").trim();
}

export interface CursorRouteTarget {
  /** The OpenAI-compatible endpoint this route must be called on. */
  baseUrl: string;
  /** Bearer token, or "" when the local daemon needs none. */
  apiKey: string;
  /** Flat-rate: a rotated Cursor call bills $0 against the subscription. */
  meter: string;
}

/**
 * Resolve one `cursor` catalog route to a concrete endpoint, or throw.
 *
 * This is the CONSTRUCTIBILITY probe the catalog filter relies on: if it
 * throws, the route must never reach the rotator, because a route that is
 * selected and then fails at call time burns a cooldown on a pool that was
 * never broken.
 */
export function makeCursorRoute(route: {
  api?: string;
  base_url?: string;
}): CursorRouteTarget {
  if (!extensionsEnabled()) {
    throw new CursorUnavailable(
      "extended providers are off (set FACTORY_ROTATION_EXTENSIONS=1)",
    );
  }
  if (
    String(route.api || "")
      .trim()
      .toLowerCase() !== CURSOR_API
  ) {
    throw new CursorUnavailable(`'${route.api}' is not a Cursor route`);
  }
  const baseUrl = cursorBaseUrl() || String(route.base_url || "").trim();
  if (!baseUrl) {
    throw new CursorUnavailable(
      "Cursor HTTP endpoint is not configured (set FACTORY_CURSOR_BASE_URL)",
    );
  }
  return { baseUrl, apiKey: cursorApiKey(), meter: "cursor:subscription" };
}
