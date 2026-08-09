import { StubProvider } from "./stubProvider.js";

/**
 * mockProvider.ts — first-class zero-credit provider for Factory Deck.
 *
 * Same deterministic offline behavior as the legacy stub, but named `mock`
 * so control-plane health and UI journeys are explicit about "no paid credits".
 */
export class MockProvider extends StubProvider {
  constructor() {
    super("mock");
  }
}
