import test from "node:test";
import assert from "node:assert/strict";
import "../public/markdown.js";

const MD = globalThis.RavnirMarkdown;

// ---- a tiny DOM, enough for render()
class Node_ {
  constructor(tag, doc) { this.tag = tag; this.ownerDocument = doc; this.attrs = {}; this.children = []; this.parentNode = null; this.listeners = {}; this._text = null; this.classes = new Set(); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  get classList() { const s = this; return { add: (c) => { s.classes.add(c); s.attrs.class = [...s.classes].join(" "); } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  addEventListener(t, f) { this.listeners[t] = f; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text ?? this.children.map((c) => c.textContent).join(""); }
  has(c) { return this.classes.has(c); }
}
class Text_ { constructor(v) { this.v = v; this.tag = "#text"; } get textContent() { return this.v; } }
const doc = {
  createElement: (t) => new Node_(t, doc),
  createElementNS: (ns, t) => new Node_(t, doc),
  createTextNode: (v) => new Text_(v),
};
const all = (n, f, out = []) => { if (n.tag && n.tag !== "#text") { if (f(n)) out.push(n); (n.children || []).forEach((c) => all(c, f, out)); } return out; };
const byTag = (n, t) => all(n, (x) => x.tag === t);
const byClass = (n, c) => all(n, (x) => x.has && x.has(c));
function mount(text, opts) {
  const root = doc.createElement("div");
  const res = MD.render(root, text, opts);
  return { root, res };
}

const inl = (s) => JSON.stringify(MD.inline(s));

test("headings, hr and no setext", () => {
  const b = MD.parse("# One\n\ntext\n---\n\n### Three ###\n#hashtag");
  assert.deepEqual(b.map((x) => x.t), ["heading", "para", "hr", "heading", "para"]);
  assert.equal(b[0].level, 1);
  assert.equal(b[3].text, "Three");
  assert.equal(b[1].text, "text");
});

test("single newline is a line break", () => {
  const { root } = mount("a\nb");
  assert.equal(byTag(root, "br").length, 1);
});

test("nested lists with 2 and 4 space indents", () => {
  for (const ind of ["  ", "    "]) {
    const b = MD.parse(`- a\n${ind}- b\n${ind}${ind}- c\n- d`);
    assert.equal(b.length, 1);
    const l = b[0];
    assert.equal(l.items.length, 2);
    const sub = l.items[0].children.find((x) => x.t === "list");
    assert.ok(sub, "nested list under a");
    assert.equal(sub.items.length, 1);
    const sub2 = sub.items[0].children.find((x) => x.t === "list");
    assert.ok(sub2, "third level");
    assert.equal(sub2.items[0].children[0].text, "c");
  }
});

test("nested bullets under ordered item with 2 and 3 spaces", () => {
  for (const ind of ["  ", "   ", "    "]) {
    const b = MD.parse(`1. one\n${ind}- x\n${ind}- y\n2. two`);
    assert.equal(b.length, 1);
    assert.equal(b[0].items.length, 2);
    assert.equal(b[0].items[0].children.find((x) => x.t === "list").items.length, 2);
  }
});

test("ordered list keeps its start number and ) markers", () => {
  const b = MD.parse("3. c\n4. d");
  assert.equal(b[0].ordered, true);
  assert.equal(b[0].start, 3);
  const c = MD.parse("2) x\n3) y");
  assert.equal(c[0].start, 2);
  assert.equal(c[0].items.length, 2);
  const { root } = mount("5. a\n6. b");
  assert.equal(byTag(root, "ol")[0].attrs.start, "5");
});

test("list item holds a code block and a second paragraph", () => {
  const b = MD.parse("- step\n\n  more text\n\n  ```sh\n  ls\n  ```\n- next");
  assert.equal(b[0].items.length, 2);
  const kids = b[0].items[0].children;
  assert.deepEqual(kids.map((x) => x.t), ["para", "para", "code"]);
  assert.equal(kids[2].code, "ls");
});

test("task items", () => {
  const b = MD.parse("- [ ] todo\n- [x] done\n- plain");
  assert.deepEqual(b[0].items.map((i) => i.task), [false, true, null]);
  const { root } = mount("- [x] done");
  const cb = byTag(root, "input")[0];
  assert.equal(cb.attrs.type, "checkbox");
  assert.ok("disabled" in cb.attrs && "checked" in cb.attrs);
});

test("table alignment and padding", () => {
  const b = MD.parse("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 |\n| x | y | z | w | extra |");
  const t = b[0];
  assert.equal(t.t, "table");
  assert.deepEqual(t.align, ["left", "center", "right", null]);
  assert.deepEqual(t.rows[0], ["1", "2", "3", ""]);
  assert.equal(t.rows[1].length, 4);
});

test("table without outer pipes, and right after a paragraph line", () => {
  const b = MD.parse("Here is data\nName | Qty\n--- | ---\nfoo | 2");
  assert.deepEqual(b.map((x) => x.t), ["para", "table"]);
  assert.deepEqual(b[1].header, ["Name", "Qty"]);
  assert.equal(b[0].text, "Here is data");
});

test("pipe inside code span and escaped pipe do not split cells", () => {
  const b = MD.parse("| cmd | note |\n|---|---|\n| `a | b` | x \\| y |");
  assert.deepEqual(b[0].rows[0], ["`a | b`", "x | y"]);
});

test("numeric column detection", () => {
  const b = MD.parse("| item | cost | share | name |\n|---|---|---|---|\n| a | $1,200.50 | 12% | foo |\n| b | (3.5) | 8% | bar |\n| c | 4k | n/a | baz |\n| d | text | 9% | qux |");
  const t = b[0];
  assert.deepEqual(t.numeric, [false, true, true, false]);
  const e = MD.parse("| a | b |\n|---|--:|\n| 1 | 2 |")[0];
  assert.deepEqual(e.numeric, [true, false]);
  const { root } = mount("| a | b |\n|---|---|\n| 1 | x |\n| 2 | y |");
  const tds = byTag(root, "td");
  assert.ok(tds[0].has("md-al-right") && tds[0].has("md-num"));
  assert.ok(!tds[1].has("md-al-right"));
});

test("table wrapper, copy and Show all", () => {
  const rows = Array.from({ length: 35 }, (_, i) => `| ${i} | r${i} |`).join("\n");
  const { root, res } = mount(`| n | s |\n|---|---|\n${rows}`);
  assert.equal(res.rich, true);
  assert.equal(byClass(root, "md-table-wrap").length, 1);
  assert.equal(byTag(root, "table")[0].has("md-table"), true);
  const hidden = byTag(root, "tr").filter((r) => "hidden" in r.attrs);
  assert.equal(hidden.length, 15);
  const more = byClass(root, "md-more")[0];
  assert.equal(more.textContent, "Show all 35 rows");
  more.listeners.click();
  assert.equal(byTag(root, "tr").filter((r) => "hidden" in r.attrs).length, 0);
});

test("unterminated fence still yields a code block", () => {
  const b = MD.parse("text\n```js\nconst a = 1;\nmore");
  assert.equal(b[1].t, "code");
  assert.equal(b[1].lang, "js");
  assert.equal(b[1].closed, false);
  assert.equal(b[1].code, "const a = 1;\nmore");
  const c = MD.parse("~~~\nx\n~~~\nafter");
  assert.equal(c[0].closed, true);
  assert.equal(c[1].t, "para");
});

test("no indented code blocks", () => {
  const b = MD.parse("para\n\n    indented words");
  assert.deepEqual(b.map((x) => x.t), ["para", "para"]);
});

test("callouts and quotes", () => {
  const b = MD.parse("> [!WARNING]\n> careful **now**\n\n> [!tip] short\n\n> plain\n> > nested");
  assert.equal(b[0].t, "callout");
  assert.equal(b[0].kind, "warning");
  assert.equal(b[0].children[0].text, "careful **now**");
  assert.equal(b[1].kind, "tip");
  assert.equal(b[1].children[0].text, "short");
  assert.equal(b[2].t, "quote");
  assert.equal(b[2].children[1].t, "quote");
  const { root } = mount("> [!NOTE]\n> hi");
  const title = byClass(root, "md-callout-title")[0];
  assert.equal(title.textContent, "Note");
  assert.equal(byTag(root, "svg").length, 1);
});

test("unsafe links render as plain text", () => {
  for (const url of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", "//evil.com", " javascript:alert(1)", "vbscript:x", "java\tscript:alert(1)", "&#106;avascript:alert(1)", "/\\evil.com", "ftp://x.com"]) {
    const { root } = mount(`[click](${url.replace(/ /g, "%20").startsWith("%20") ? "<" + url + ">" : url.includes(" ") ? "<" + url + ">" : url})`);
    assert.equal(byTag(root, "a").length, 0, `anchor for ${JSON.stringify(url)}`);
    assert.ok(root.textContent.includes("click"));
  }
  const { root } = mount("[x](< javascript:alert(1)>)");
  assert.equal(byTag(root, "a").length, 0);
});

test("safe links keep attributes", () => {
  const { root } = mount('[a](https://example.com/p "T") [b](mailto:a@example.com) [c](/docs) [d](#top)');
  const as = byTag(root, "a");
  assert.equal(as.length, 4);
  assert.equal(as[0].attrs.target, "_blank");
  assert.equal(as[0].attrs.rel, "noopener noreferrer");
  assert.equal(as[0].attrs.title, "T");
  assert.equal(as[2].attrs.target, undefined);
});

test("images: only safe sources are drawn", () => {
  let { root } = mount("![cat](https://example.com/c.png)");
  let img = byTag(root, "img")[0];
  assert.equal(img.attrs.loading, "lazy");
  assert.equal(img.attrs.decoding, "async");
  assert.equal(byTag(root, "a")[0].attrs.target, "_blank");
  ({ root } = mount("![x](/api/files/a.png)"));
  assert.equal(byTag(root, "img").length, 1);
  ({ root } = mount("![x](data:image/png;base64,iVBORw0KGgo=)"));
  assert.equal(byTag(root, "img").length, 1);
  for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "data:image/svg+xml;base64,AAAA", "//evil.com/a.png", "/other/a.png", "data:text/html;base64,AAAA"]) {
    ({ root } = mount(`![alt text](${bad})`));
    assert.equal(byTag(root, "img").length, 0, bad);
    assert.ok(root.textContent.includes("alt text"), bad);
  }
  ({ root } = mount("![pic](http://example.com/a.png)"));
  assert.equal(byTag(root, "a").length, 1, "http image falls back to a link");
});

test("raw html stays text", () => {
  const { root } = mount("<script>alert(1)</script> and <b>bold</b>");
  assert.equal(byTag(root, "script").length, 0);
  assert.equal(byTag(root, "b").length, 0);
  assert.ok(root.textContent.includes("<script>alert(1)</script>"));
});

test("snake_case is not emphasised, real emphasis works", () => {
  assert.equal(inl("my_var_name here"), JSON.stringify([{ t: "text", v: "my_var_name here" }]));
  assert.equal(inl("a_b_c"), JSON.stringify([{ t: "text", v: "a_b_c" }]));
  assert.equal(MD.inline("_em_")[0].t, "em");
  assert.equal(MD.inline("__strong__")[0].t, "strong");
  assert.equal(MD.inline("*em*")[0].t, "em");
  assert.equal(MD.inline("**s**")[0].t, "strong");
  const both = MD.inline("***both***")[0];
  assert.equal(both.t, "em");
  assert.equal(both.c[0].t, "strong");
  assert.equal(MD.inline("~~gone~~")[0].t, "del");
  assert.equal(MD.inline("2 * 3 * 4")[0].t, "text");
});

test("code spans with one or two backticks", () => {
  assert.equal(MD.inline("`a*b*`")[0].v, "a*b*");
  assert.equal(MD.inline("`` a`b ``")[0].v, "a`b");
});

test("bare URLs drop trailing punctuation and unbalanced paren", () => {
  const flat = (ns) => ns.flatMap((n) => (n.t === "link" ? [n] : n.c ? flat(n.c) : []));
  const href = (s) => flat(MD.inline(s))[0].href;
  assert.equal(href("see https://example.com/a."), "https://example.com/a");
  assert.equal(href("(https://example.com/a)"), "https://example.com/a");
  assert.equal(href("https://en.wikipedia.org/wiki/X_(y)."), "https://en.wikipedia.org/wiki/X_(y)");
  assert.equal(href("go to https://example.com/a?b=1, then"), "https://example.com/a?b=1");
  assert.equal(href("**https://example.com/x**"), "https://example.com/x");
  assert.equal(href("<https://example.com/z>"), "https://example.com/z");
});

test("backslash escapes", () => {
  assert.equal(MD.inline("\\*not em\\*")[0].v, "*not em*");
});

test("csv fence is a block with language csv", () => {
  const b = MD.parse('```csv\nname,qty\n"Smith, J",5\n"say ""hi""",7\n```');
  assert.equal(b[0].lang, "csv");
  const { root, res } = mount('```csv\nname,qty\n"Smith, J",5\n"say ""hi""",7\n```');
  assert.equal(res.rich, true);
  assert.equal(byClass(root, "md-block").length, 1);
  assert.equal(byTag(root, "figure").length, 0);
  const tds = byTag(root, "td").map((t) => t.textContent);
  assert.deepEqual(tds, ["Smith, J", "5", 'say "hi"', "7"]);
  assert.ok(byTag(root, "td")[1].has("md-al-right"));
});

test("block handlers: closed uses handler, failure falls back, streaming partial stays code", () => {
  globalThis.RavnirBlocks.demo = (code, box) => { box.textContent = "drawn:" + code; return true; };
  globalThis.RavnirBlocks.broken = () => { throw new Error("no"); };
  let r = mount("```demo\nhi\n```");
  assert.equal(byClass(r.root, "md-block")[0].textContent, "drawn:hi");
  r = mount("```broken\nx\n```");
  assert.equal(byClass(r.root, "md-block").length, 0);
  assert.equal(byTag(r.root, "figure").length, 1);
  r = mount("```demo\nhi", { streaming: true });
  assert.equal(byClass(r.root, "md-block").length, 0);
  assert.equal(byTag(r.root, "figure").length, 1);
  delete globalThis.RavnirBlocks.demo;
  delete globalThis.RavnirBlocks.broken;
});

test("code block gets header, copy button and uses RavnirHighlight when present", () => {
  let r = mount("```python\nprint(1)\n```");
  assert.equal(byClass(r.root, "md-code-lang")[0].textContent, "python");
  assert.equal(byClass(r.root, "md-copy")[0].textContent, "Copy");
  assert.equal(byTag(r.root, "code")[0].textContent, "print(1)");
  globalThis.RavnirHighlight = { render: (code) => { const f = doc.createElement("span"); f.textContent = "HL:" + code; return f; } };
  r = mount("```python\nx\n```");
  assert.equal(byTag(r.root, "code")[0].textContent, "HL:x");
  globalThis.RavnirHighlight = { render: () => { throw new Error("x"); } };
  r = mount("```python\ny\n```");
  assert.equal(byTag(r.root, "code")[0].textContent, "y");
  delete globalThis.RavnirHighlight;
});

test("rich flag is false for plain prose", () => {
  assert.equal(mount("hello **there**\n\n- a\n- b").res.rich, false);
  assert.equal(mount("```\nx\n```").res.rich, true);
});

test("snake_case in a bare paragraph and list stays literal in DOM", () => {
  const { root } = mount("use snake_case_names and file_name.txt");
  assert.equal(byTag(root, "em").length, 0);
});

test("--- is always a break, even under a paragraph line", () => {
  const b = MD.parse("Title\n---\nBody");
  assert.deepEqual(b.map((x) => x.t), ["para", "hr", "para"]);
});

test("plain() strips markers", () => {
  assert.equal(MD.plain("# Head\n\n**bold** and `code` [link](https://x.co)\n\n- one\n- two\n\n```js\nlet a;\n```"), "Head bold and code link one two let a;");
  assert.equal(MD.plain("| a | b |\n|---|---|\n| 1 | 2 |"), "a b 1 2");
  assert.equal(MD.plain("![pic](https://x.co/a.png) after"), "pic after");
  assert.equal(MD.plain(""), "");
});

test("parse is cached and JSON-serialisable", () => {
  const a = MD.parse("# x\n\n- a");
  assert.equal(MD.parse("# x\n\n- a"), a);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test("hostile link and emphasis runs stay fast", () => {
  const M = globalThis.RavnirMarkdown;
  // Catches runaway parsing on slow CI machines too (an Ubuntu amd64 run took about 3 s for one unit).
  // Strikethrough runs grow faster than linearly (about 0.3 s here); replies over 80,000 characters render as plain text.
  for (const unit of ["[x](", "![a](", "a[b](", "~~a", "[[[[a"]) {
    const text = unit.repeat(20000);
    const started = Date.now();
    M.plain(text);
    M.parse(text);
    assert.ok(Date.now() - started < 8000, `${unit} took ${Date.now() - started} ms`);
  }
});
