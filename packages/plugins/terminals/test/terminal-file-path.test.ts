import { describe, expect, test } from "bun:test";
import { insertTerminalFilePath } from "../src/terminal-file-path.ts";

describe("deliberate terminal file path insertion", () => {
  test("preserves the literal path without quoting, Enter or bracketed paste", () => {
    const sent: string[] = [];
    const path = "/private/a b 'quoted' $(not-a-command);[file]\\name";
    expect(insertTerminalFilePath(path, (text) => { sent.push(text); return true; })).toBe(true);
    expect(sent).toEqual([path]);
  });

  test("rejects every C0, DEL and C1 character before reaching the input boundary", () => {
    const sent: string[] = [];
    const controls = [...Array.from({ length: 32 }, (_, value) => value), ...Array.from({ length: 33 }, (_, value) => 127 + value)];
    for (const control of controls) {
      expect(insertTerminalFilePath(`/private/a${String.fromCharCode(control)}b`, (text) => { sent.push(text); return true; })).toBe(false);
    }
    expect(insertTerminalFilePath("", (text) => { sent.push(text); return true; })).toBe(false);
    expect(sent).toEqual([]);
  });
});
