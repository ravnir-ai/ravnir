( () => {
  const MAX_LENGTH = 200000;

  const JS_KEYWORDS = "break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield|async|await";
  const JS_BUILTINS = "true|false|null|undefined|NaN|Infinity|console|window|document|globalThis|process|require|module|exports|Promise|Array|Object|String|Number|Boolean|Math|JSON|Date|RegExp|Map|Set|WeakMap|WeakSet|Error|Symbol|BigInt";

  const jsRules = [
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "comment", re: /\/\/[^\n]*/ },
    { type: "string", re: /`(?:\\[\s\S]|[^\\`])*`/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:\\[\s\S]|[^\\'\n])*'/ },
    { type: "string", re: /`(?:\\[\s\S]|[^\\`])*/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*/ },
    { type: "string", re: /'(?:\\[\s\S]|[^\\'\n])*/ },
    { type: "number", re: /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?/ },
    { type: "function", re: /[A-Za-z_$][\w$]*(?=\s*\()/ },
    { type: "builtin", re: new RegExp("\\b(?:" + JS_BUILTINS + ")\\b") },
    { type: "keyword", re: new RegExp("\\b(?:" + JS_KEYWORDS + ")\\b") },
    { type: "operator", re: /[+\-*/%=<>!&|^~?:]+/ },
    { type: "punctuation", re: /[{}()[\];,.]/ },
  ];

  const tsRules = [
    ...jsRules.slice(0, 12),
    { type: "type", re: /\b[A-Z][A-Za-z0-9_$]*\b/ },
    { type: "keyword", re: /\b(?:interface|type|enum|implements|declare|namespace|module|abstract|readonly|public|private|protected|satisfies|keyof|infer|is|asserts|override)\b/ },
    ...jsRules.slice(12),
  ];

  const pyRules = [
    { type: "comment", re: /#[^\n]*/ },
    { type: "string", re: /[rRbBuUfF]{0,2}"""[\s\S]*?"""/ },
    { type: "string", re: /[rRbBuUfF]{0,2}'''[\s\S]*?'''/ },
    { type: "string", re: /[rRbBuUfF]{0,2}"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /[rRbBuUfF]{0,2}'(?:\\[\s\S]|[^\\'\n])*'/ },
    { type: "string", re: /[rRbBuUfF]{0,2}"(?:\\[\s\S]|[^\\"\n])*/ },
    { type: "string", re: /[rRbBuUfF]{0,2}'(?:\\[\s\S]|[^\\'\n])*/ },
    { type: "number", re: /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)/ },
    { type: "function", re: /[A-Za-z_]\w*(?=\s*\()/ },
    { type: "builtin", re: /\b(?:True|False|None|NotImplemented|Ellipsis|len|print|range|str|int|float|list|dict|set|tuple|open)\b/ },
    { type: "keyword", re: /\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/ },
    { type: "variable", re: /\b(?:self|cls)\b/ },
    { type: "operator", re: /[+\-*/%=<>!&|^~:@]+/ },
    { type: "punctuation", re: /[{}()[\];,.]/ },
  ];

  const shRules = [
    { type: "comment", re: /#[^\n]*/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"$\n])*"/ },
    { type: "string", re: /'(?:[^'\n])*'/ },
    { type: "variable", re: /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"$\n])*/ },
    { type: "string", re: /'(?:[^'\n])*/ },
    { type: "keyword", re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|time|return|break|continue|local|export|declare|readonly)\b/ },
    { type: "builtin", re: /\b(?:echo|printf|cd|pwd|source|alias|unset|set|read|exit|test|sudo|apt|npm|npx|node|git|curl|wget|grep|sed|awk|cat|ls|mkdir|rm|cp|mv|chmod|chown|tar|ssh|scp|jq|docker|systemctl)\b/ },
    { type: "number", re: /\b\d+(?:\.\d+)?\b/ },
    { type: "operator", re: /[|&;<>!=+\-*/%]+/ },
    { type: "punctuation", re: /[{}()[\]]/ },
  ];

  const jsonRules = [
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "comment", re: /\/\/[^\n]*/ },
    { type: "property", re: /"(?:\\[\s\S]|[^\\"\n])*"(?=\s*:)/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*/ },
    { type: "number", re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
    { type: "builtin", re: /\b(?:true|false|null)\b/ },
    { type: "punctuation", re: /[{}[\],:]/ },
  ];

  const sqlRules = [
    { type: "comment", re: /--[^\n]*/ },
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "string", re: /'(?:''|[^'])*'/ },
    { type: "string", re: /"(?:""|[^"])*"/ },
    { type: "number", re: /\b\d+(?:\.\d+)?\b/ },
    { type: "builtin", re: /\b(?:true|false|null)\b/ },
    { type: "keyword", re: /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|join|left|right|inner|outer|full|on|group|by|order|having|limit|offset|union|all|distinct|as|and|or|not|is|in|like|between|case|when|then|else|end|exists|primary|key|foreign|references|unique|default|index|view|begin|commit|rollback|transaction|with|asc|desc|count|sum|avg|min|max|constraint|trigger|procedure|function|return|returns|declare)\b/ },
    { type: "operator", re: /[+\-*/%=<>!|]+/ },
    { type: "punctuation", re: /[{}()[\];,.]/ },
  ];

  const htmlRules = [
    { type: "comment", re: /<!--[\s\S]*?-->/ },
    { type: "meta", re: /<![A-Za-z][^>]*>/ },
    { type: "tag", re: /<\/?[A-Za-z][\w:-]*/ },
    { type: "attr", re: /[A-Za-z_:][-\w:.]*(?=\s*=)/ },
    { type: "string", re: /"[^"\n]*"/ },
    { type: "string", re: /'[^'\n]*'/ },
    { type: "punctuation", re: /[<>/=]/ },
  ];

  const cssRules = [
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:\\[\s\S]|[^\\'\n])*'/ },
    { type: "meta", re: /![A-Za-z-]+/ },
    { type: "keyword", re: /@[A-Za-z-]+/ },
    { type: "number", re: /#[0-9a-fA-F]{3,8}\b/ },
    { type: "tag", re: /[.#][A-Za-z_-][\w-]*/ },
    { type: "tag", re: /[A-Za-z-]+(?=[\s,{])/ },
    { type: "property", re: /[A-Za-z-]+(?=\s*:)/ },
    { type: "number", re: /#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr|pt)?/ },
    { type: "builtin", re: /\b(?:important|inherit|initial|unset|none|auto|block|inline|flex|grid|absolute|relative|fixed|sticky|center|bold|italic|solid|dashed|transparent|hidden|visible)\b/ },
    { type: "operator", re: /[>+~*=]/ },
    { type: "punctuation", re: /[{}();:,]/ },
  ];

  const yamlRules = [
    { type: "comment", re: /#[^\n]*/ },
    { type: "meta", re: /^(?:---|\.\.\.)\s*$/ },
    { type: "property", re: /[A-Za-z_][\w.-]*(?=\s*:(?:\s|$))/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:''|[^'\n])*'/ },
    { type: "number", re: /-?\b\d+(?:\.\d+)?\b/ },
    { type: "builtin", re: /\b(?:true|false|null|yes|no|on|off)\b/ },
    { type: "variable", re: /\$\{[^}\n]*\}|\$[A-Za-z_]\w*/ },
    { type: "punctuation", re: /[-:[\]{},]/ },
  ];

  const goRules = [
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "comment", re: /\/\/[^\n]*/ },
    { type: "string", re: /`[^`]*`/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:\\[\s\S]|[^\\'\n])*'/ },
    { type: "number", re: /\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)\b/ },
    { type: "function", re: /[A-Za-z_]\w*(?=\s*\()/ },
    { type: "type", re: /\b[A-Z]\w*\b/ },
    { type: "builtin", re: /\b(?:true|false|nil|iota)\b/ },
    { type: "keyword", re: /\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b/ },
    { type: "operator", re: /[+\-*/%=<>!&|^~:]+/ },
    { type: "punctuation", re: /[{}()[\];,.]/ },
  ];

  const rustRules = [
    { type: "comment", re: /\/\*[\s\S]*?\*\// },
    { type: "comment", re: /\/\/[^\n]*/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:\\.|[^\\'\n])'/ },
    { type: "number", re: /\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)(?:[iu](?:8|16|32|64|128|size)|f(?:32|64))?\b/ },
    { type: "function", re: /[A-Za-z_]\w*(?=\s*\()/ },
    { type: "type", re: /\b[A-Z]\w*\b/ },
    { type: "builtin", re: /\b(?:true|false|None|Some|Ok|Err)\b/ },
    { type: "keyword", re: /\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|type|unsafe|use|where|while)\b/ },
    { type: "operator", re: /[+\-*/%=<>!&|^~?:]+/ },
    { type: "punctuation", re: /[{}()[\];,.#]/ },
  ];

  const diffRules = [
    { type: "meta", re: /^(?:diff |index |new file |deleted file |similarity |rename |old mode |new mode )/ },
    { type: "meta", re: /^\+\+\+ [^\n]*/ },
    { type: "meta", re: /^--- [^\n]*/ },
    { type: "meta", re: /^@@[^\n]*/ },
    { type: "inserted", re: /^\+[^\n]*/ },
    { type: "deleted", re: /^-[^\n]*/ },
    { type: "text", re: /[^\n]+/ },
    { type: "text", re: /\n/ },
  ];

  const mdRules = [
    { type: "meta", re: /^```[^\n]*/ },
    { type: "heading", re: /^#{1,6}[^\n]*/ },
    { type: "heading", re: /^[^\n]+\n(?:===+|---+)\s*$/ },
    { type: "comment", re: /^>[^\n]*/ },
    { type: "string", re: /`[^`\n]*`/ },
    { type: "meta", re: /^---\s*$/ },
    { type: "punctuation", re: /^[ \t]*(?:[-*+]|\d+\.)(?=\s)/ },
    { type: "text", re: /\n/ },
  ];

  const dockerRules = [
    { type: "comment", re: /#[^\n]*/ },
    { type: "keyword", re: /^[ \t]*(?:FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/ },
    { type: "variable", re: /\$\{[^}\n]*\}|\$[A-Za-z_]\w*/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:[^'\n])*'/ },
    { type: "number", re: /\b\d+(?:\.\d+)?\b/ },
    { type: "operator", re: /[=<>!&|]+/ },
    { type: "punctuation", re: /[{}()[\],:]/ },
  ];

  const tomlRules = [
    { type: "comment", re: /#[^\n]*/ },
    { type: "tag", re: /\[\[?[^\]\n]*\]\]?/ },
    { type: "property", re: /[A-Za-z_][\w.-]*(?=\s*=)/ },
    { type: "string", re: /"""[\s\S]*?"""/ },
    { type: "string", re: /'''[\s\S]*?'''/ },
    { type: "string", re: /"(?:\\[\s\S]|[^\\"\n])*"/ },
    { type: "string", re: /'(?:[^'\n])*'/ },
    { type: "number", re: /\b\d[\d_]*(?:\.\d+)?\b/ },
    { type: "builtin", re: /\b(?:true|false)\b/ },
    { type: "punctuation", re: /[{}[\],=.]/ },
  ];

  function compile(rules, flags) {
    const types = rules.map((rule) => rule.type);
    const source = rules.map((rule) => "(" + rule.re.source + ")").join("|");
    return { re: new RegExp(source, "y" + (flags || "")), types };
  }

  const LANGS = {
    javascript: compile(jsRules, ""),
    typescript: compile(tsRules, ""),
    python: compile(pyRules, ""),
    bash: compile(shRules, ""),
    json: compile(jsonRules, ""),
    sql: compile(sqlRules, "i"),
    html: compile(htmlRules, ""),
    css: compile(cssRules, "i"),
    yaml: compile(yamlRules, "mi"),
    go: compile(goRules, ""),
    rust: compile(rustRules, ""),
    diff: compile(diffRules, "m"),
    markdown: compile(mdRules, "m"),
    dockerfile: compile(dockerRules, "m"),
    toml: compile(tomlRules, "m"),
  };

  const ALIASES = {
    javascript: ["js", "jsx", "mjs", "cjs", "javascript"],
    typescript: ["ts", "tsx", "typescript"],
    python: ["py", "python3", "python"],
    bash: ["sh", "shell", "zsh", "console", "bash"],
    json: ["json", "jsonc", "json5"],
    sql: ["sql"],
    html: ["html", "xml", "svg", "vue"],
    css: ["css", "scss", "less"],
    yaml: ["yaml", "yml"],
    go: ["go", "golang"],
    rust: ["rust", "rs"],
    diff: ["diff", "patch"],
    markdown: ["markdown", "md"],
    dockerfile: ["dockerfile", "docker"],
    toml: ["toml", "ini"],
  };

  const languages = Object.keys(LANGS);

  const BY_ALIAS = {};
  for (const name of languages) {
    for (const alias of ALIASES[name]) BY_ALIAS[alias] = name;
  }

  function canonical(lang) {
    if (typeof lang !== "string") return "";
    const key = lang.trim().toLowerCase();
    return BY_ALIAS[key] || "";
  }

  function pushToken(tokens, type, text) {
    if (!text) return;
    const last = tokens.length ? tokens[tokens.length - 1] : null;
    if (last && last.type === "text" && type === "text") {
      last.text += text;
      return;
    }
    tokens.push({ type, text });
  }

  function tokenize(code, lang) {
    if (typeof code !== "string" || code.length === 0) return [];
    const name = canonical(lang);
    const lang_ = name ? LANGS[name] : null;
    if (!lang_ || code.length > MAX_LENGTH) return [{ type: "text", text: code }];

    const { re, types } = lang_;
    const tokens = [];
    const length = code.length;
    let pos = 0;

    while (pos < length) {
      re.lastIndex = pos;
      const match = re.exec(code);
      if (match && match.index === pos && match[0].length > 0) {
        let group = 1;
        while (group < match.length && match[group] === undefined) group++;
        const type = group < match.length ? types[group - 1] : "text";
        pushToken(tokens, type, match[0]);
        pos = re.lastIndex;
      } else {
        pushToken(tokens, "text", code[pos]);
        pos += 1;
      }
    }

    return tokens;
  }

  function render(code, lang) {
    if (typeof document === "undefined") return null;
    const fragment = document.createDocumentFragment();
    for (const token of tokenize(code, lang)) {
      if (token.type === "text") {
        fragment.append(document.createTextNode(token.text));
      } else {
        const span = document.createElement("span");
        span.className = "hl-" + token.type;
        span.textContent = token.text;
        fragment.append(span);
      }
    }
    return fragment;
  }

  const api = { languages, tokenize, render };

  if (typeof globalThis !== "undefined") globalThis.RavnirHighlight = api;
  if (typeof window !== "undefined") window.RavnirHighlight = api;
})();
