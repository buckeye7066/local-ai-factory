/**
 * extensionSwitch.ts — the one switch that governs every extended rotation
 * transport (the local CLIs and Cursor alike), so an operator turns the whole
 * class on or off in one place.
 *
 * It lives in its own module ON PURPOSE. Each extended adapter must be able to
 * fail to load WITHOUT taking its siblings with it — that is the whole point
 * of the buildability gate in extendedTransports.ts. If the shared switch lived
 * inside one adapter, breaking that adapter would break the other one too, and
 * "one broken adapter cannot take the catalog filter down" would be false in
 * exactly the case it is supposed to hold.
 *
 * OFF by default: spawning local agents and reaching a Cursor daemon are real
 * behaviour changes, not a silent upgrade.
 */
export function extensionsEnabled(): boolean {
  const raw = (process.env.FACTORY_ROTATION_EXTENSIONS || "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}
