import { expect, test } from "bun:test";
import {
  type ContainerRow,
  imageLabel,
  portLabels,
  stateGroup,
  uniqueContainers,
} from "./docker-view";

test("container totals count unique IDs and distinguish stopped from other states", () => {
  const a = { id: "a", name: "web" } as ContainerRow,
    b = { id: "b", name: "worker" } as ContainerRow;
  expect(uniqueContainers([a, b, a]).map((c) => c.id)).toEqual(["a", "b"]);
  expect(stateGroup("exited")).toBe("stopped");
  expect(stateGroup("running")).toBe("running");
  expect(stateGroup("paused")).toBe("other");
});
test("published port summaries deduplicate IPv4/IPv6 while internal ports stay separate", () => {
  expect(
    portLabels("0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 5432/tcp"),
  ).toEqual({ published: ["8080 → 80/tcp"], internal: ["5432/tcp"] });
  expect(portLabels("3000/tcp")).toEqual({
    published: [],
    internal: ["3000/tcp"],
  });
  expect(imageLabel("app:latest@sha256:0123456789")).toBe("app:latest");
});
