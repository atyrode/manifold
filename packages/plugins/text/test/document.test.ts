import { describe, expect, test } from "bun:test";
import {
  decodeTextDocument,
  decodeTextDocumentRoute,
  encodeTextDocument,
  textDocumentPath,
} from "../src/document.ts";

describe("document addresses", () => {
  test("opaque ids remain one route segment, including slashes, escapes and Unicode", () => {
    const homeContainerId = '../home/%2F/雪:"\\';
    const documentId = "../doc/a:b?c#d/%/😀/\ud800";
    const reference = encodeTextDocument(homeContainerId, documentId);
    const path = textDocumentPath(reference);
    const segment = path.slice("/text/".length);
    expect(segment.includes("/")).toBe(false);
    expect(decodeTextDocumentRoute(segment)).toEqual({ homeContainerId, documentId });
    expect(decodeTextDocument(reference)).toEqual({ homeContainerId, documentId });
  });

  test("malformed or widened tuples do not resolve to a different home", () => {
    expect(decodeTextDocumentRoute("%ZZ")).toBeNull();
    expect(decodeTextDocumentRoute('x/["home","doc"]')).toBeNull();
    expect(decodeTextDocument('["home","doc","extra"]')).toBeNull();
    expect(decodeTextDocument('{"homeContainerId":"home","documentId":"doc"}')).toBeNull();
    expect(decodeTextDocument('["","doc"]')).toBeNull();
    expect(decodeTextDocument(JSON.stringify(["home", "x".repeat(129)]))).toBeNull();
  });
});
