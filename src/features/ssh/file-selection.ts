export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const rectangle = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): Box => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
export const intersect = (a: Box, b: Box) =>
  a.x <= b.x + b.width &&
  a.x + a.width >= b.x &&
  a.y <= b.y + b.height &&
  a.y + a.height >= b.y;
export function clickSelection(
  ids: string[],
  id: string,
  current: string[],
  anchor: string | null,
  shift: boolean,
  toggle: boolean,
): { selected: string[]; anchor: string } {
  if (!ids.includes(id)) return { selected: current, anchor: anchor ?? id };
  if (shift && anchor && ids.includes(anchor)) {
    const start = ids.indexOf(anchor),
      end = ids.indexOf(id);
    const range = ids.slice(Math.min(start, end), Math.max(start, end) + 1);
    return {
      selected: toggle ? [...new Set([...current, ...range])] : range,
      anchor,
    };
  }
  return {
    selected: toggle
      ? current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id]
      : [id],
    anchor: id,
  };
}
