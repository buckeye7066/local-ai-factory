/**
 * exitCodes.ts — the contract between the backend and its launcher supervisor.
 *
 * The supervisor in scripts/start-factory.ps1 restarts the backend when it dies
 * unexpectedly. That is only correct for TRANSIENT deaths. A permanent,
 * operator-fixable condition — a refused LAN bind, a port held by a foreign
 * service — can never succeed on a retry, so restarting it just respawns a
 * console that dies instantly, over and over, until the attempt budget runs
 * out. That is the "flashing black window" failure class.
 *
 * A distinct exit code lets the supervisor tell the two apart and STOP on the
 * first fatal exit, printing the reason instead of churning.
 */

/**
 * Permanent, operator-fixable failure. The supervisor must NOT restart this.
 *
 * 78 is BSD sysexits' EX_CONFIG ("configuration error"), chosen because it
 * cannot collide with a generic crash (1) or a clean shutdown (0).
 */
export const FATAL_EXIT_CODE = 78;
