import { randomUUID } from "node:crypto";
import type { ClarificationHistoryItem } from "../agents/clarificationAgent.js";

/**
 * clarificationStore.ts — in-memory session state for the yes/no clarification
 * loop. Server-process lifetime only (not persisted to disk): a clarification
 * conversation is short-lived scaffolding toward a run, not durable history
 * the way completed runs are, so this trades restart-survival for simplicity.
 */

const MAX_QUESTIONS = 8;

export interface ClarificationSession {
  id: string;
  initialRequest: string;
  history: ClarificationHistoryItem[];
  status: "active" | "confident" | "abandoned";
  currentQuestion: string | null;
  refinedGoals: string[];
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, ClarificationSession>();

export function createSession(initialRequest: string): ClarificationSession {
  const now = Date.now();
  const session: ClarificationSession = {
    id: randomUUID(),
    initialRequest,
    history: [],
    status: "active",
    currentQuestion: null,
    refinedGoals: [],
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(session.id, session);
  return session;
}

export function getSession(id: string): ClarificationSession | null {
  return sessions.get(id) ?? null;
}

export function updateSession(
  id: string,
  patch: Partial<Omit<ClarificationSession, "id" | "createdAt">>,
): ClarificationSession | null {
  const s = sessions.get(id);
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: Date.now() });
  return s;
}

export function questionCap(): number {
  return MAX_QUESTIONS;
}
