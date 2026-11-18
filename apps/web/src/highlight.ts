import type { HighlighterCore } from "shiki/core";

let highlighter: Promise<HighlighterCore> | undefined;

// Loaded on the first finished code block. The JS regex engine needs no WebAssembly.
function load() {
  highlighter ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [
          import("shiki/langs/typescript.mjs"),
          import("shiki/langs/tsx.mjs"),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/shellscript.mjs"),
          import("shiki/langs/python.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/yaml.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/diff.mjs"),
        ],
        engine: createJavaScriptRegexEngine(),
      }),
  );
  return highlighter;
}

// The `<code>` element's tree, colored by CSS variables for both themes. Undefined for a language
// it doesn't know, which stays plain text.
export async function highlight(code: string, language: string) {
  const shiki = await load();
  if (!shiki.getLoadedLanguages().includes(language)) {
    return undefined;
  }
  const root = shiki.codeToHast(code, {
    lang: language,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
  const pre = root.children[0];
  const element = pre?.type === "element" ? pre.children[0] : undefined;
  return element?.type === "element" ? element : undefined;
}
