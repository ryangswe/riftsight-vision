// SPDX-License-Identifier: Apache-2.0
// A card's optional `extra` object: the game's own data, which the runtime never reads but
// keeps with the card, and accepts and refuses exactly as the Python package does. The cases
// and the answers come from the "extra" section of fixtures/contract.json, written by
// tests/test_browser_fixtures.py at the top of the repository.

import { describe, expect, it } from "vitest";

import { parseCatalog } from "../src/release.js";
import { contract } from "./support.js";

interface Accepted { what: string; doc: unknown; cards: Record<string, unknown> }
interface Refused { what: string; doc: unknown; mentions: string[] }

const fixture = contract.extra as { accepted: Accepted[]; refused: Refused[] };

describe("the extra object of a card", () => {
  it("accepts the catalogs the Python package accepts, and keeps each card's extra as given", () => {
    expect(fixture.accepted.length).toBeGreaterThan(0);
    for (const accepted of fixture.accepted) {
      const parsed = parseCatalog(accepted.doc);
      if (typeof parsed === "string") throw new Error(`${accepted.what}: ${parsed}`);
      const given = Object.fromEntries(parsed.cards.filter((c) => c.extra !== undefined).map((c) => [c.id, c.extra]));
      expect(given, accepted.what).toEqual(accepted.cards);
    }
  });

  it("refuses the catalogs the Python package refuses, naming the same place", () => {
    expect(fixture.refused.length).toBeGreaterThan(0);
    for (const refused of fixture.refused) {
      const reason = parseCatalog(refused.doc);
      expect(typeof reason, refused.what).toBe("string");
      for (const fragment of refused.mentions) expect(reason, refused.what).toContain(fragment);
    }
  });
});
