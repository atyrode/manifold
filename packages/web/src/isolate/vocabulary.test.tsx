import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VocabularyRenderer } from "./vocabulary.tsx";

test("text reaches the DOM as text, never as markup", () => {
  const hostile = renderToStaticMarkup(
    <VocabularyRenderer
      tree={{ type: "text", text: '<img src=x onerror="alert(1)">' }}
      onEvent={() => {}}
    />,
  );
  expect(hostile).not.toContain("<img");
  expect(hostile).toContain("&lt;img");
});
