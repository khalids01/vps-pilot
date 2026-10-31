export interface ContainerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  project: string;
  service: string;
}
export function uniqueContainers(rows: ContainerRow[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}
export function stateGroup(state: string) {
  if (state === "running") return "running";
  return ["exited", "created", "dead"].includes(state) ? "stopped" : "other";
}
export function imageLabel(image: string) {
  return image.startsWith("sha256:")
    ? `Image ${image.slice(7, 19)}`
    : image.split("@sha256:")[0];
}
export function portLabels(ports: string) {
  const published = new Set<string>(),
    internal = new Set<string>();
  for (const entry of ports.split(/,\s*/).filter(Boolean)) {
    const [binding, target] = entry.split("->");
    if (target)
      published.add(
        `${binding.slice(binding.lastIndexOf(":") + 1)} → ${target}`,
      );
    else internal.add(binding);
  }
  return { published: [...published], internal: [...internal] };
}
