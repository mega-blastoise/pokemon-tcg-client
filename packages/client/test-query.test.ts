/** @module query_tests Checks shared text/collector ordering and query input limits. */
import { expect, test } from "bun:test";
import {
  collectorNumberKey,
  compareText,
  normalizeCardQuery,
  normalizeSearchText,
} from "./src/query.js";

test("natural collector ordering preserves alphanumeric and padded numbers", () => {
  const numbers = ["R", "182a", "10", "002", "2", "182", "?", "!"];
  numbers.sort(
    (a, b) =>
      compareText(collectorNumberKey(a), collectorNumberKey(b)) ||
      compareText(a, b),
  );
  expect(numbers).toEqual(["!", "002", "2", "10", "182", "182a", "?", "R"]);
  expect(collectorNumberKey("002")).toBe(collectorNumberKey("2"));
  expect(normalizeSearchText("  PokÉmon’s\n cards  ")).toBe("pokemon's cards");
});
test("queries reject unsupported syntax fields and unbounded page sizes", () => {
  expect(() => normalizeCardQuery({ limit: 251 })).toThrow();
  expect(() => normalizeCardQuery({ offset: -1 })).toThrow();
  expect(() => normalizeCardQuery({ unsupported: true } as never)).toThrow();
  // Expanded and Gym Leader Challenge are not modelled yet.
  expect(() => normalizeCardQuery({ format: "expanded" } as never)).toThrow();
});
