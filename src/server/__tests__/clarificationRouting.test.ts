import { describe, expect, it } from "vitest";
import {
  createSession,
  getSession,
  updateSession,
} from "../storage/clarificationStore.js";

describe("clarification economic tier", () => {
  it.each(["free", "paid"] as const)(
    "pins a %s tier for the entire session",
    (routingMode) => {
      const session = createSession("Clarify this change", routingMode);
      updateSession(session.id, {
        currentQuestion: "Should it be private?",
        history: [{ question: "Should it be private?", answer: "yes" }],
      });

      expect(getSession(session.id)?.routingMode).toBe(routingMode);
    },
  );
});
