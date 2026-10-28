// SPDX-License-Identifier: Apache-2.0
// The tooltip's card table, from a release catalog: one rule, used in two places.
//
//   - A product's build writes it from the bundled release's catalog: the table for bundled and
//     fallback pages.
//   - The compute frame builds it from the catalog of a remote release it is about to load
//     (choose.ts), so that a card new in that release shows its facts.
//
//   { "<card id>": [name, set, art path or null] } (with `printed`, the card's printed number as a
//   fourth value: the "catalog" printed-number rule)
//
// Names come from the release's own catalog only; no third-party card source is read.

export type CardTable = Record<string, [string, string | null, string | null] | [string, string | null, string | null, string | null]>;

/** The card table for a catalog. A catalog that is not an object with a list of cards gives {}. */
export function buildCardTable(catalog: unknown, { printed = false }: { printed?: boolean } = {}): CardTable {
  const table: CardTable = Object.create(null);
  const c = catalog as { cards?: unknown } | null | undefined;
  const cards: unknown[] = c && Array.isArray(c.cards) ? c.cards : [];
  for (const raw of cards) {
    const card = raw as { id?: unknown; name?: unknown; art?: unknown; printed?: unknown; facets?: { set?: unknown } | null } | null;
    if (!card || typeof card.id !== "string" || typeof card.name !== "string") continue;
    const set = card.facets && typeof card.facets.set === "string" ? card.facets.set : null;
    const row: [string, string | null, string | null] | [string, string | null, string | null, string | null] = [card.name, set, typeof card.art === "string" ? card.art : null];
    if (printed) row.push(typeof card.printed === "string" && card.printed ? card.printed : null);
    table[card.id] = row;
  }
  return table;
}
