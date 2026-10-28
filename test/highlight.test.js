import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import "../public/highlight.js";

const H = globalThis.RavnirHighlight;
const CANONICAL = [
  "javascript", "typescript", "python", "bash", "json", "sql", "html",
  "css", "yaml", "go", "rust", "diff", "markdown", "dockerfile", "toml",
];
const TYPES = new Set([
  "keyword", "string", "comment", "number", "function", "type", "property",
  "operator", "punctuation", "variable", "tag", "attr", "builtin", "meta",
  "inserted", "deleted", "heading", "text",
]);

const SNIPPETS = {
  javascript: [
    "const greet = (name) => {",
    "  // say hello",
    "  const msg = `Hello, ${name}!`;",
    "  return msg.length > 0 ? msg : \"nobody\";",
    "};",
  ].join("\n"),
  typescript: [
    "interface User { id: number; name: string }",
    "export function find(id: number): User | null {",
    "  return users.find((u) => u.id === id) ?? null;",
    "}",
  ].join("\n"),
  python: [
    "# a comment",
    "def greet(name: str, times: int = 3) -> str:",
    '    """doc"""',
    '    return f"hi {name}" * times',
  ].join("\n"),
  bash: [
    "#!/bin/bash",
    "set -euo pipefail",
    "for f in *.txt; do",
    '  echo "reading $f" >&2',
    "done",
  ].join("\n"),
  json: '{"name": "ravnir", "count": 3, "ok": true, "list": [1, 2.5, -3e4], "x": null}',
  sql: [
    "-- report",
    "SELECT u.id, COUNT(*) AS n",
    "FROM users u LEFT JOIN orders o ON o.user_id = u.id",
    "WHERE u.name LIKE '%ana%' GROUP BY u.id ORDER BY n DESC;",
  ].join("\n"),
  html: [
    "<!DOCTYPE html>",
    '<div class="card" data-id=\'7\'>',
    "  <!-- note -->",
    '  <a href="/x">link</a>',
    "</div>",
  ].join("\n"),
  css: [
    "/* card */",
    ".card, .card > a {",
    "  color: #fff;",
    "  padding: 8px 1.5rem;",
    "  background: rgba(0, 0, 0, 0.4) !important;",
    "}",
  ].join("\n"),
  yaml: [
    "---",
    "name: ravnir",
    "count: 3",
    "tags:",
    "  - one",
    '  - "two"',
    "nested:",
    "  key: null",
  ].join("\n"),
  go: [
    "package main",
    "",
    'import "fmt"',
    "",
    "func add(a int, b int) int {",
    "    // sum",
    "    return a + b",
    "}",
  ].join("\n"),
  rust: [
    "use std::fmt;",
    "",
    "fn main() {",
    "    let x: u32 = 42;",
    "    // greet",
    '    println!("{}", x);',
    "}",
  ].join("\n"),
  diff: [
    "diff --git a/x b/x",
    "index 123..456 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -1,3 +1,3 @@",
    " same",
    "-removed",
    "+added",
  ].join("\n"),
  markdown: [
    "# Title",
    "",
    "Some *text* with `code` here.",
    "",
    "> quote",
    "- item",
  ].join("\n"),
  dockerfile: [
    "# build",
    "FROM node:22 AS build",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm ci --omit=dev",
    "ENV NODE_ENV=production",
    'CMD ["node", "server/index.js"]',
  ].join("\n"),
  toml: [
    "# config",
    "[server]",
    "port = 3847",
    'name = "ravnir"',
    "debug = false",
    "[[items]]",
    "id = 1",
  ].join("\n"),
};

function join(tokens) {
  return tokens.map((token) => token.text).join("");
}

function assertWellFormed(tokens, code, lang) {
  assert.equal(join(tokens), code, "join invariant for " + lang);
  for (const token of tokens) {
    assert.ok(TYPES.has(token.type), "bad token type " + token.type + " in " + lang);
    assert.ok(typeof token.text === "string");
    assert.notEqual(token.text, "", "empty token in " + lang);
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("exposes the expected API and canonical languages", () => {
  assert.ok(H);
  assert.deepEqual(H.languages, CANONICAL);
  assert.equal(typeof H.tokenize, "function");
  assert.equal(typeof H.render, "function");
});

test("join invariant holds for a realistic snippet in every language", () => {
  for (const lang of CANONICAL) {
    const code = SNIPPETS[lang];
    assert.ok(typeof code === "string" && code.length > 0, "missing snippet for " + lang);
    assertWellFormed(H.tokenize(code, lang), code, lang);
  }
});

test("join invariant holds for random input in every language", () => {
  const alphabet = "abzAZ019 \n\t\"'`\\/*#<>{}[]()$@%&+-.=_!?;,:\u00f1\u00e9";
  const rand = mulberry32(20261024);
  for (const lang of CANONICAL) {
    for (let round = 0; round < 40; round += 1) {
      let code = "";
      const length = Math.floor(rand() * 160);
      for (let i = 0; i < length; i += 1) {
        code += alphabet[Math.floor(rand() * alphabet.length)];
      }
      assertWellFormed(H.tokenize(code, lang), code, lang);
    }
  }
});

test("join invariant holds for unterminated strings and comments", () => {
  const cases = [
    ["javascript", 'const a = "never ends'],
    ["javascript", "/* never ends"],
    ["typescript", "const a = `tick"],
    ["python", 'x = """open'],
    ["python", "# open"],
    ["bash", 'echo "open'],
    ["json", '{"a": "open'],
    ["sql", "SELECT 'open"],
    ["html", '<!-- open'],
    ["css", "/* open"],
    ["yaml", 'a: "open'],
    ["go", 's := `open'],
    ["rust", '/* open'],
    ["dockerfile", 'RUN "open'],
    ["toml", 'a = """open'],
  ];
  for (const [lang, code] of cases) {
    assertWellFormed(H.tokenize(code, lang), code, lang + " unterminated");
  }
});

test("aliases resolve to the canonical languages", () => {
  const pairs = [
    ["js", "javascript"], ["jsx", "javascript"], ["mjs", "javascript"],
    ["ts", "typescript"], ["tsx", "typescript"],
    ["py", "python"], ["python3", "python"],
    ["sh", "bash"], ["shell", "bash"], ["console", "bash"], ["zsh", "bash"],
    ["jsonc", "json"], ["json5", "json"],
    ["xml", "html"], ["svg", "html"], ["vue", "html"],
    ["scss", "css"], ["less", "css"],
    ["yml", "yaml"], ["golang", "go"], ["rs", "rust"], ["patch", "diff"],
    ["md", "markdown"], ["docker", "dockerfile"], ["ini", "toml"],
  ];
  for (const [alias, canonical] of pairs) {
    const fromAlias = H.tokenize("const x = 1 // c", alias);
    const fromCanonical = H.tokenize("const x = 1 // c", canonical);
    assert.deepEqual(fromAlias, fromCanonical, alias + " -> " + canonical);
  }
});

test("unknown or empty languages give a single text token", () => {
  const code = "anything at all";
  for (const lang of ["", "   ", "nope", undefined, null, 42]) {
    assert.deepEqual(H.tokenize(code, lang), [{ type: "text", text: code }]);
  }
});

test("javascript basics", () => {
  const tokens = H.tokenize('const answer = compute("x", 42); // done', "js");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.deepEqual(byType("keyword"), ["const"]);
  assert.ok(byType("function").includes("compute"));
  assert.ok(byType("string").includes('"x"'));
  assert.ok(byType("number").includes("42"));
  assert.ok(byType("comment").includes("// done"));
});

test("typescript, go and rust mark capitalised words as type", () => {
  for (const lang of ["ts", "go", "rust"]) {
    const tokens = H.tokenize("Foo Bar baz", lang);
    const types = tokens.filter((t) => t.type === "type").map((t) => t.text);
    assert.ok(types.includes("Foo"), lang + " should type Foo");
    assert.ok(types.includes("Bar"), lang + " should type Bar");
    assert.ok(!types.includes("baz"), lang + " should not type baz");
  }
});

test("python comments, strings and keywords", () => {
  const tokens = H.tokenize("# x\nreturn 1", "python");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.deepEqual(byType("comment"), ["# x"]);
  assert.ok(byType("keyword").includes("return"));
  assert.ok(byType("number").includes("1"));
});

test("bash variables, including inside double quotes", () => {
  for (const code of ["echo $HOME", 'echo "$HOME"', "cd ${DIR}"]) {
    const tokens = H.tokenize(code, "bash");
    const vars = tokens.filter((t) => t.type === "variable").map((t) => t.text);
    assert.ok(vars.length === 1, code + " should expose one variable, got " + JSON.stringify(vars));
    assert.match(vars[0], /DIR|HOME/);
  }
});

test("json keys are property tokens", () => {
  const tokens = H.tokenize('{"key": 1}', "json");
  const props = tokens.filter((t) => t.type === "property").map((t) => t.text);
  assert.deepEqual(props, ['"key"']);
});

test("sql keywords are case insensitive and comments recognised", () => {
  const tokens = H.tokenize("select a -- note", "sql");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.ok(byType("keyword").some((t) => t.toLowerCase() === "select"));
  assert.deepEqual(byType("comment"), ["-- note"]);
});

test("html tags, attributes and values", () => {
  const tokens = H.tokenize('<div class="box">hi</div>', "html");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.ok(byType("tag").includes("<div"));
  assert.deepEqual(byType("attr"), ["class"]);
  assert.ok(byType("string").includes('"box"'));
});

test("css properties and values", () => {
  const tokens = H.tokenize("body { color: #fff; }", "css");
  const props = tokens.filter((t) => t.type === "property").map((t) => t.text);
  assert.deepEqual(props, ["color"]);
  const numbers = tokens.filter((t) => t.type === "number").map((t) => t.text);
  assert.ok(numbers.includes("#fff"));
});

test("yaml keys are property tokens and scalars highlighted", () => {
  const tokens = H.tokenize("name: true", "yaml");
  const props = tokens.filter((t) => t.type === "property").map((t) => t.text);
  assert.deepEqual(props, ["name"]);
  assert.ok(tokens.some((t) => t.type === "builtin" && t.text === "true"));
});

test("diff lines are inserted, deleted and meta", () => {
  const tokens = H.tokenize("+added\n-removed\n@@ -1 +1 @@", "diff");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.deepEqual(byType("inserted"), ["+added"]);
  assert.deepEqual(byType("deleted"), ["-removed"]);
  assert.deepEqual(byType("meta"), ["@@ -1 +1 @@"]);
});

test("markdown headings and inline code", () => {
  const tokens = H.tokenize("# Title\n\nsome `code`", "markdown");
  const byType = (type) => tokens.filter((t) => t.type === type).map((t) => t.text);
  assert.deepEqual(byType("heading"), ["# Title"]);
  assert.deepEqual(byType("string"), ["`code`"]);
});

test("dockerfile instructions and toml keys", () => {
  const docker = H.tokenize("FROM node:22", "dockerfile");
  assert.ok(docker.some((t) => t.type === "keyword" && t.text.trim() === "FROM"));
  const toml = H.tokenize('name = "v"', "toml");
  assert.deepEqual(toml.filter((t) => t.type === "property").map((t) => t.text), ["name"]);
});

test("a 300000 character input returns one token quickly", () => {
  const code = "a".repeat(300000);
  const started = Date.now();
  const tokens = H.tokenize(code, "javascript");
  const elapsed = Date.now() - started;
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, "text");
  assert.equal(tokens[0].text.length, 300000);
  assert.ok(elapsed < 1000, "took " + elapsed + "ms");
});

test("every colour in highlight.css has at least 4.5:1 against #1d1d1f", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "highlight.css");
  const css = readFileSync(file, "utf8");
  const hexes = [...css.matchAll(/(?<![\w-])color\s*:\s*#([0-9a-fA-F]{3,8})\b/g)].map((m) => m[1]);
  assert.ok(hexes.length >= 10, "expected token colours, found " + hexes.length);

  const channel = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const background = luminance(0x1d, 0x1d, 0x1f);

  for (const hex of hexes) {
    let value = hex;
    if (value.length === 3) value = value.split("").map((c) => c + c).join("");
    if (value.length === 8) value = value.slice(0, 6);
    assert.equal(value.length, 6, "unexpected colour #" + hex);
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    const ratio = (Math.max(luminance(r, g, b), background) + 0.05) / (Math.min(luminance(r, g, b), background) + 0.05);
    assert.ok(ratio >= 4.5, "#" + hex + " has contrast " + ratio.toFixed(2));
  }
});
