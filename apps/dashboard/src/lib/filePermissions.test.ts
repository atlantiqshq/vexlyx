import { describe, expect, it } from "vitest";
import {
  commonParentDir,
  parentDir,
  describeMode,
  gridToOctal,
  isExtractableArchive,
  isValidOctalMode,
  octalToGrid,
  toggleBit,
} from "@/lib/filePermissions";

describe("octal ↔ checkbox grid", () => {
  it.each(["000", "644", "755", "600", "640", "777", "421"])("round-trips %s", (mode) => {
    expect(gridToOctal(octalToGrid(mode))).toBe(mode);
  });

  it("maps 644 to owner rw, group r, other r", () => {
    expect(octalToGrid("644")).toEqual({
      owner: { read: true, write: true, execute: false },
      group: { read: true, write: false, execute: false },
      other: { read: true, write: false, execute: false },
    });
  });

  it("toggling a checkbox updates the octal value", () => {
    const grid = toggleBit(octalToGrid("644"), "owner", "execute", true);
    expect(gridToOctal(grid)).toBe("744");
    expect(gridToOctal(toggleBit(grid, "other", "read", false))).toBe("740");
  });

  it("treats an invalid mode as no permissions instead of throwing", () => {
    expect(gridToOctal(octalToGrid("9x"))).toBe("000");
  });
});

describe("isValidOctalMode", () => {
  it.each(["644", "000", "777"])("accepts %s", (mode) => expect(isValidOctalMode(mode)).toBe(true));
  it.each(["", "64", "6444", "888", "abc", "4755", "-44"])("rejects %j", (mode) =>
    expect(isValidOctalMode(mode)).toBe(false),
  );
});

describe("describeMode", () => {
  it("renders the ls -l style string", () => {
    expect(describeMode("644")).toBe("rw-r--r--");
    expect(describeMode("755")).toBe("rwxr-xr-x");
  });
});

describe("path helpers", () => {
  it("parentDir returns the containing folder", () => {
    expect(parentDir("site/assets/app.css")).toBe("site/assets");
    expect(parentDir("index.html")).toBe("");
  });

  it("commonParentDir finds the shared folder of a selection", () => {
    expect(commonParentDir(["site/a.txt", "site/b.txt"])).toBe("site");
    expect(commonParentDir(["site/assets", "site/notes.txt"])).toBe("site");
    expect(commonParentDir(["a/x.txt", "b/y.txt"])).toBe("");
    expect(commonParentDir(["a/b/x.txt", "a/c/y.txt"])).toBe("a");
    expect(commonParentDir([])).toBe("");
  });
});

describe("isExtractableArchive", () => {
  it.each(["site.zip", "BACKUP.ZIP", "a.tar", "a.tar.gz", "a.tgz", "a.tar.bz2"])("accepts %s", (name) =>
    expect(isExtractableArchive(name)).toBe(true),
  );
  it.each(["notes.txt", "gz", "archive.rar", "zip"])("rejects %s", (name) =>
    expect(isExtractableArchive(name)).toBe(false),
  );
});
