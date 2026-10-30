import { expect, test } from "bun:test";
import {
  emptyOrganization,
  matchesServer,
  sanitizeFleet,
  sortFleet,
} from "./fleet-data";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const profile = {
  id: first,
  revision: "a",
  name: "API Alpha",
  host: "alpha.invalid",
  port: 22,
  username: "deploy",
};
test("fleet metadata retains organization and drops foreign fields", () => {
  const metadata = {
    ...emptyOrganization(),
    project: " Portal ",
    tags: [" api ", "api"],
    environment: "production",
    password: "must not persist",
    command: "do not run",
  };
  const result = sanitizeFleet({ version: 1, servers: { [first]: metadata } });
  expect(result?.servers[first]).toEqual({
    ...emptyOrganization(),
    project: "Portal",
    tags: ["api"],
    environment: "production",
  });
  expect(JSON.stringify(result)).not.toContain("must not persist");
});
test("fleet metadata rejects malformed IDs, unbounded text and invalid fields", () => {
  const metadata = emptyOrganization();
  for (const patch of [
    { tags: Array(13).fill("tag") },
    { project: "x".repeat(81) },
    { project: "a\nb" },
    { environment: "live" },
    { order: -1 },
    { order: 1.5 },
    { favorite: "yes" },
  ])
    expect(
      sanitizeFleet({
        version: 1,
        servers: { [first]: { ...metadata, ...patch } },
      }),
    ).toBeNull();
  expect(
    sanitizeFleet({ version: 1, servers: { "ssh user@host": metadata } }),
  ).toBeNull();
  expect(sanitizeFleet({ version: 2, servers: {} })).toBeNull();
});
test("fleet search spans all organization terms and ordering keeps favorites first", () => {
  const metadata = {
    ...emptyOrganization(),
    project: "Portal",
    tags: ["eu-west"],
    environment: "production" as const,
  };
  expect(
    matchesServer(profile, metadata, "portal production eu-west api"),
  ).toBe(true);
  expect(matchesServer(profile, metadata, "portal staging")).toBe(false);
  const profiles = [profile, { ...profile, id: second, name: "Beta" }];
  expect(
    sortFleet(profiles, {
      [second]: { ...metadata, favorite: true, order: 9 },
    }).map((item) => item.id),
  ).toEqual([second, first]);
  expect(
    sortFleet(profiles, {
      [first]: { ...metadata, order: 1 },
      [second]: { ...metadata, order: 0 },
    }).map((item) => item.id),
  ).toEqual([second, first]);
  expect(profiles[0].id).toBe(first);
});
