import { expect, test } from "bun:test";
import { clickSelection, intersect, rectangle } from "./file-selection";

test("range selection respects visible ordering, modifiers and stale anchors", () => {
  const ids = ["a", "b", "c", "d"];
  expect(clickSelection(ids, "b", ["a"], "d", true, false).selected).toEqual([
    "b",
    "c",
    "d",
  ]);
  expect(clickSelection(ids, "b", ["a"], "d", true, true).selected).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(
    clickSelection(ids, "b", ["b", "d"], "b", false, true).selected,
  ).toEqual(["d"]);
  expect(
    clickSelection(ids, "b", ["a"], "missing", true, false).selected,
  ).toEqual(["b"]);
});
test("rectangle selection normalizes reverse drags and intersects item bounds", () => {
  const box = rectangle({ x: 100, y: 80 }, { x: 10, y: 20 });
  expect(box).toEqual({ x: 10, y: 20, width: 90, height: 60 });
  expect(intersect(box, { x: 30, y: 35, width: 20, height: 10 })).toBe(true);
  expect(intersect(box, { x: 101, y: 35, width: 20, height: 10 })).toBe(false);
});
