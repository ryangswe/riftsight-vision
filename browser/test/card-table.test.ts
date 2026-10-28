// SPDX-License-Identifier: Apache-2.0
// The card table a tooltip reads, built from a release catalog (src/remote/card-table.ts).
import { describe, expect, it } from "vitest";

import { buildCardTable } from "../src/remote/card-table.js";

describe("buildCardTable", () => {
  const catalog = {
    cards: [
      { id: "TOY-001", name: "Toy Dragon", art: "TOY-001.jpg", facets: { set: "TOY" } },
      { id: "TOY-002", name: "Toy Knight", art: "TOY-002.jpg", facets: { set: "TOY" } },
      { id: "122", name: "No Art Yet", art: null, facets: {} },
    ],
  };

  it("writes name, set and art per card", () => {
    const table = buildCardTable(catalog);
    expect(table["TOY-001"]).toEqual(["Toy Dragon", "TOY", "TOY-001.jpg"]);
    expect(table["122"]).toEqual(["No Art Yet", null, null]);
    expect(table["ZZ-1"]).toBeUndefined();
    expect(table["__proto__"]).toBeUndefined();
  });

  it("carries each card's printed number with the 'catalog' rule", () => {
    const table = buildCardTable({ cards: [{ id: "a", name: "A", art: null, printed: "TOY-001" }, { id: "b", name: "B", art: null }] }, { printed: true });
    expect(table.a).toEqual(["A", null, null, "TOY-001"]);
    expect(table.b).toEqual(["B", null, null, null]);
  });

  it("gives an empty table for a catalog that is not an object with a list of cards, and skips malformed rows", () => {
    for (const bad of [null, undefined, 3, "x", {}, { cards: "no" }]) expect(buildCardTable(bad)).toEqual({});
    expect(buildCardTable({ cards: [null, { id: 1, name: "A" }, { id: "b" }, { id: "c", name: "C", facets: null }] })).toEqual({ c: ["C", null, null] });
  });
});
