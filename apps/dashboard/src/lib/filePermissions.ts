export type PermissionClass = "owner" | "group" | "other";
export type PermissionBit = "read" | "write" | "execute";

export type PermissionGrid = Record<PermissionClass, Record<PermissionBit, boolean>>;

export const PERMISSION_CLASSES: PermissionClass[] = ["owner", "group", "other"];
export const PERMISSION_BITS: PermissionBit[] = ["read", "write", "execute"];

const BIT_VALUES: Record<PermissionBit, number> = { read: 4, write: 2, execute: 1 };

export const OCTAL_MODE_PATTERN = /^[0-7]{3}$/;

export function isValidOctalMode(value: string): boolean {
  return OCTAL_MODE_PATTERN.test(value);
}

export function octalToGrid(mode: string): PermissionGrid {
  const digits = isValidOctalMode(mode) ? mode.split("").map(Number) : [0, 0, 0];
  const [owner = 0, group = 0, other = 0] = digits;
  const toBits = (digit: number): Record<PermissionBit, boolean> => ({
    read: (digit & BIT_VALUES.read) !== 0,
    write: (digit & BIT_VALUES.write) !== 0,
    execute: (digit & BIT_VALUES.execute) !== 0,
  });
  return { owner: toBits(owner), group: toBits(group), other: toBits(other) };
}

export function gridToOctal(grid: PermissionGrid): string {
  return PERMISSION_CLASSES.map((cls) =>
    PERMISSION_BITS.reduce((sum, bit) => sum + (grid[cls][bit] ? BIT_VALUES[bit] : 0), 0),
  ).join("");
}

export function toggleBit(
  grid: PermissionGrid,
  cls: PermissionClass,
  bit: PermissionBit,
  value: boolean,
): PermissionGrid {
  return { ...grid, [cls]: { ...grid[cls], [bit]: value } };
}

export function describeMode(mode: string): string {
  const grid = octalToGrid(mode);
  return PERMISSION_CLASSES.map((cls) =>
    PERMISSION_BITS.map((bit) => (grid[cls][bit] ? { read: "r", write: "w", execute: "x" }[bit] : "-")).join(""),
  ).join("");
}

export function parentDir(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function commonParentDir(paths: string[]): string {
  const parents = paths.map((p) => parentDir(p).split("/").filter(Boolean));
  const first = parents[0] ?? [];
  let length = first.length;
  for (const parts of parents) {
    let i = 0;
    while (i < length && parts[i] === first[i]) i += 1;
    length = i;
  }
  return first.slice(0, length).join("/");
}

export const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2"];

export function isExtractableArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
