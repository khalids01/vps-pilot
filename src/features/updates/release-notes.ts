export type ReleaseNoteCategory = "bugFixes" | "performance" | "features";

export interface ReleaseNoteSection {
  category: ReleaseNoteCategory;
  title: string;
  items: string[];
}

const CATEGORY_META: Record<
  ReleaseNoteCategory,
  { title: string; aliases: string[] }
> = {
  bugFixes: { title: "Bug fixes", aliases: ["bug fix", "bug fixes", "fixes"] },
  performance: {
    title: "Performance improvements",
    aliases: [
      "performance",
      "performance improvement",
      "performance improvements",
    ],
  },
  features: {
    title: "Feature improvements",
    aliases: ["features", "feature improvements", "improvements"],
  },
};

export function parseReleaseNotes(notes: string | null): ReleaseNoteSection[] {
  if (!notes?.trim()) return [];
  const sections = new Map<ReleaseNoteCategory, string[]>();
  let active: ReleaseNoteCategory | null = null;

  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line
      .replace(/^#{1,6}\s*/, "")
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
    const matched = (
      Object.entries(CATEGORY_META) as [
        ReleaseNoteCategory,
        (typeof CATEGORY_META)[ReleaseNoteCategory],
      ][]
    ).find(([, meta]) => meta.aliases.includes(heading));
    if (matched) {
      active = matched[0];
      if (!sections.has(active)) sections.set(active, []);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)/)?.[1]?.trim();
    if (active && item) sections.get(active)?.push(item);
  }

  return (Object.keys(CATEGORY_META) as ReleaseNoteCategory[])
    .map((category) => ({
      category,
      title: CATEGORY_META[category].title,
      items: sections.get(category) ?? [],
    }))
    .filter((section) => section.items.length > 0);
}
