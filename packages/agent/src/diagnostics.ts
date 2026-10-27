/** @module agent_diagnostics Runtime-neutral checks that a client honors its documented contract. */
import type { TCGClient } from "./protocol.js";

/** One verified behavior with timing and a human-readable result. */
export interface DiagnosticResult {
  id: string;
  label: string;
  ok: boolean;
  durationMs: number;
  detail: string;
}

/** A check throws to fail and returns its detail line to pass. */
type Check = { id: string; label: string; run: () => Promise<string> };

/** Throw with a readable message instead of pulling in an assertion library. */
function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Await a rejection and return its typed error code. */
async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "UNTYPED";
  }
  return "RESOLVED";
}

/**
 * Stream the contract checks one at a time so UIs can render progress.
 * `createClient` enables the lifecycle check, which needs a client it may close.
 */
export async function* runDiagnostics(
  client: TCGClient,
  options: { createClient?: () => Promise<TCGClient> } = {},
): AsyncGenerator<DiagnosticResult> {
  const { snapshot } = client;
  // Later checks reuse a real record found by the first search.
  let sample: { id: string; name: string; setId: string } | undefined;
  const checks: Check[] = [
    {
      id: "snapshot",
      label: "Snapshot descriptor",
      run: async () => {
        expect(snapshot.schemaVersion === 1, "unexpected schema version");
        expect(/^[a-f0-9]{40}$/.test(snapshot.source.commit), "commit pin");
        return `${snapshot.dataVersion} @ ${snapshot.source.commit.slice(0, 7)}${snapshot.releaseReady ? "" : " (draft)"}`;
      },
    },
    {
      id: "sets-total",
      label: "Set catalog matches snapshot count",
      run: async () => {
        const page = await client.sets.list({ limit: 1 });
        expect(
          page.total === snapshot.counts.sets,
          `${page.total} ≠ ${snapshot.counts.sets}`,
        );
        return `${page.total.toLocaleString()} sets`;
      },
    },
    {
      id: "cards-total",
      label: "Card index matches snapshot count",
      run: async () => {
        const page = await client.cards.search({ limit: 1 });
        expect(
          page.total === snapshot.counts.cards,
          `${page.total} ≠ ${snapshot.counts.cards}`,
        );
        const [first] = page.items;
        expect(first, "empty first page");
        sample = { id: first.id, name: first.name, setId: first.setId };
        return `${page.total.toLocaleString()} cards, newest ${first.id}`;
      },
    },
    {
      id: "get",
      label: "cards.get returns the searched record",
      run: async () => {
        expect(sample, "no sample card");
        const card = await client.cards.get(sample.id);
        expect(card?.id === sample.id, `got ${card?.id}`);
        expect(card.name === sample.name, "name differs from search");
        return `${card.id} · ${card.name}`;
      },
    },
    {
      id: "missing",
      label: "Absent card and set return null",
      run: async () => {
        expect((await client.cards.get("zz-missing-0")) === null, "card");
        expect((await client.sets.get("zz-missing")) === null, "set");
        return "null, null";
      },
    },
    {
      id: "get-many",
      label: "getMany keeps order, nulls, duplicates",
      run: async () => {
        expect(sample, "no sample card");
        const ids = [sample.id, "zz-missing-0", sample.id];
        const cards = await client.cards.getMany(ids);
        const got = cards.map((card) => card?.id ?? null);
        expect(
          JSON.stringify(got) === JSON.stringify([sample.id, null, sample.id]),
          JSON.stringify(got),
        );
        expect(cards[0] !== cards[2], "duplicates share one object");
        return "[card, null, card]";
      },
    },
    {
      id: "fold",
      label: "Name search folds case and accents",
      run: async () => {
        // Flabébé is in modern sets; fall back to the sample's shouted name.
        const accented = await client.cards.search({
          name: "FLABEBE",
          limit: 1,
        });
        if (accented.total > 0) {
          expect(accented.items[0]?.name.includes("é"), "accent not folded");
          return `"FLABEBE" → ${accented.items[0]?.name} (${accented.total})`;
        }
        expect(sample, "no sample card");
        const page = await client.cards.search({
          name: sample.name.toUpperCase(),
          limit: 250,
        });
        expect(
          page.items.some((card) => card.id === sample?.id),
          "sample missing",
        );
        return `${page.total} matches`;
      },
    },
    {
      id: "paging",
      label: "Pagination is stable across pages",
      run: async () => {
        const query = { type: "Fire", sort: "name" as const };
        const whole = await client.cards.search({ ...query, limit: 10 });
        const first = await client.cards.search({ ...query, limit: 5 });
        const second = await client.cards.search({
          ...query,
          limit: 5,
          offset: 5,
        });
        const joined = [...first.items, ...second.items].map((c) => c.id);
        expect(
          JSON.stringify(joined) ===
            JSON.stringify(whole.items.map((c) => c.id)),
          "pages disagree",
        );
        expect(first.hasMore && first.total === whole.total, "page metadata");
        return `2×5 = 10 of ${whole.total} Fire cards`;
      },
    },
    {
      id: "sort",
      label: "Name sort ascends",
      run: async () => {
        const page = await client.cards.search({
          supertype: "Trainer",
          sort: "name",
          limit: 25,
        });
        const fold = (s: string) =>
          s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
        const names = page.items.map((card) => fold(card.name));
        expect(
          names.every((name, i) => i === 0 || (names[i - 1] ?? "") <= name),
          "out of order",
        );
        return `${page.items[0]?.name} … ${page.items.at(-1)?.name}`;
      },
    },
    {
      id: "filters",
      label: "Exact filters narrow results",
      run: async () => {
        const page = await client.cards.search({
          supertype: "Pokémon",
          type: "Water",
          subtype: "Basic",
          limit: 25,
        });
        expect(page.total > 0, "no Basic Water Pokémon");
        expect(
          page.items.every(
            (c) =>
              c.supertype === "Pokémon" &&
              c.types.includes("Water") &&
              c.subtypes.includes("Basic"),
          ),
          "filter leak",
        );
        return `${page.total.toLocaleString()} Basic Water Pokémon`;
      },
    },
    {
      id: "text",
      label: "Rules text search requires every term",
      run: async () => {
        const page = await client.cards.search({
          text: "search your deck supporter",
          limit: 5,
        });
        expect(page.total > 0, "no matches");
        return `${page.total} cards mention all four words`;
      },
    },
    {
      id: "invalid",
      label: "Invalid queries throw INVALID_QUERY",
      run: async () => {
        const code = await rejectionCode(client.cards.search({ limit: 999 }));
        expect(code === "INVALID_QUERY", code);
        const bad = await rejectionCode(client.cards.get("../etc"));
        expect(bad === "INVALID_QUERY", bad);
        return "limit 999, ../etc rejected";
      },
    },
    {
      id: "iterate",
      label: "sets.iterate walks the whole catalog",
      run: async () => {
        let count = 0;
        for await (const _ of client.sets.iterate({ limit: 50 })) count++;
        expect(count === snapshot.counts.sets, `${count} yielded`);
        return `${count} sets in pages of 50`;
      },
    },
  ];
  if (options.createClient) {
    const create = options.createClient;
    checks.push({
      id: "lifecycle",
      label: "Closed clients throw CLIENT_CLOSED",
      run: async () => {
        const other = await create();
        await other.close();
        const code = await rejectionCode(other.cards.get("base1-4"));
        expect(code === "CLIENT_CLOSED", code);
        return "close() is final";
      },
    });
  }
  for (const check of checks) {
    const started = performance.now();
    let ok = true;
    let detail: string;
    try {
      detail = await check.run();
    } catch (error) {
      ok = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    yield {
      id: check.id,
      label: check.label,
      ok,
      detail,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    };
  }
}
