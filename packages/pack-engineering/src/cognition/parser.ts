/** Bounded lexical analysis, not a TypeScript compiler or a type checker. */
export const COGNITION_PARSER_VERSION = "lexical-ts-js@1";

export interface CognitionSymbol {
  readonly name: string;
  readonly kind: "function" | "class" | "interface" | "type" | "variable";
  readonly line: number;
  readonly exported: boolean;
}
export interface CognitionImport {
  readonly specifier: string;
  readonly kind: "static" | "reexport" | "require" | "dynamic";
  readonly line: number;
  readonly importedNames: readonly string[];
  readonly typeOnly: boolean;
}
export interface CognitionExport {
  readonly name: string;
  readonly localName: string;
  readonly line: number;
}
export interface CognitionLimitation {
  readonly path?: string;
  readonly code: string;
  readonly detail: string;
}
export interface ParsedSourceUnit {
  readonly symbols: readonly CognitionSymbol[];
  readonly imports: readonly CognitionImport[];
  readonly exports: readonly CognitionExport[];
  readonly limitations: readonly CognitionLimitation[];
}
interface Token {
  readonly value: string;
  readonly kind: "word" | "string" | "punct";
  readonly line: number;
}

function lex(text: string): { tokens: Token[]; limitations: CognitionLimitation[] } {
  const tokens: Token[] = [];
  const limitations: CognitionLimitation[] = [];
  let index = 0;
  let line = 1;
  const advance = (): string => {
    const char = text[index++] ?? "";
    if (char === "\n") line += 1;
    return char;
  };
  const warn = (code: string, detail: string): void => { limitations.push({ code, detail }); };
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (/\s/.test(char)) { advance(); continue; }
    if ((index === 0 && char === "#" && next === "!") || (char === "/" && next === "/")) {
      while (index < text.length && advance() !== "\n") { /* comment */ }
      continue;
    }
    if (char === "/" && next === "*") {
      advance(); advance();
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) advance();
      if (index === text.length) warn("unterminated_comment", "Unterminated block comment; trailing analysis unavailable.");
      else { advance(); advance(); }
      continue;
    }
    if (char === '"' || char === "'") {
      const startLine = line;
      const quote = advance();
      let value = "";
      let escaped = false;
      let closed = false;
      while (index < text.length) {
        const current = advance();
        if (current === quote) { closed = true; break; }
        if (current === "\\") {
          escaped = true;
          if (index < text.length) advance();
        } else value += current;
      }
      // Escaped specifiers require JS literal decoding; don't guess resolution.
      if (escaped) warn("escaped_literal", `Escaped string at line ${startLine} is not used as a module specifier.`);
      if (!closed) warn("unterminated_string", `Unterminated string at line ${startLine}.`);
      tokens.push({ value: escaped ? "" : value, kind: "string", line: startLine });
      continue;
    }
    if (char === "`") {
      const startLine = line;
      advance();
      let interpolation = false;
      let closed = false;
      const stack: Array<{ mode: "template" | "expression"; depth: number }> = [{ mode: "template", depth: 0 }];
      while (index < text.length && stack.length > 0) {
        const frame = stack.at(-1)!;
        const current = advance();
        if (current === "\\") { advance(); continue; }
        if (frame.mode === "template") {
          if (current === "$" && text[index] === "{") {
            interpolation = true; advance(); stack.push({ mode: "expression", depth: 1 });
          } else if (current === "`") stack.pop();
        } else {
          if (current === "`") stack.push({ mode: "template", depth: 0 });
          else if (current === "{") frame.depth += 1;
          else if (current === "}") { frame.depth -= 1; if (frame.depth === 0) stack.pop(); }
          else if (current === '"' || current === "'") {
            while (index < text.length) {
              const quoted = advance();
              if (quoted === "\\") { advance(); continue; }
              if (quoted === current) break;
            }
          } else if (current === "/" && text[index] === "/") {
            while (index < text.length && advance() !== "\n") { /* interpolation comment */ }
          } else if (current === "/" && text[index] === "*") {
            advance();
            while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) advance();
            if (index < text.length) { advance(); advance(); }
          }
        }
      }
      closed = stack.length === 0;
      if (interpolation) warn("template_interpolation", `Template expressions at line ${startLine} are not analyzed.`);
      if (!closed) warn("unterminated_template", `Unterminated template at line ${startLine}.`);
      tokens.push({ value: "", kind: "string", line: startLine });
      continue;
    }
    // A slash at expression-start is a regex, not source containing declarations.
    const previous = tokens.at(-1);
    if (char === "/" && (previous === undefined ||
        ["=", "(", "[", "{", ",", ":", ";", "!", "?", "return", "=>"].includes(previous.value))) {
      const startLine = line;
      advance();
      let inClass = false;
      let closed = false;
      while (index < text.length) {
        const current = advance();
        if (current === "\\") { advance(); continue; }
        if (current === "[") inClass = true;
        if (current === "]") inClass = false;
        if (current === "/" && !inClass) { closed = true; break; }
        if (current === "\n") break;
      }
      while (/[a-z]/i.test(text[index] ?? "") && index < text.length) advance();
      if (!closed) warn("ambiguous_regex", `Unterminated or ambiguous regex at line ${startLine}.`);
      tokens.push({ value: "", kind: "string", line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      const startLine = line;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index]!)) advance();
      tokens.push({ value: text.slice(start, index), kind: "word", line: startLine });
      continue;
    }
    if (char.charCodeAt(0) > 127) warn("non_ascii_identifier", `Non-ASCII identifiers at line ${line} are not indexed.`);
    const startLine = line;
    const pair = text.slice(index, index + 2);
    if (["=>", "?.", "==", "!=", "++", "--", "&&", "||", "**"].includes(pair)) {
      advance(); advance();
      tokens.push({ value: pair, kind: "punct", line: startLine });
    } else tokens.push({ value: advance(), kind: "punct", line: startLine });
  }
  return { tokens, limitations };
}

/** Module-level declarations; function locals, methods and types are not resolved. */
export function parseSourceUnit(text: string): ParsedSourceUnit {
  const { tokens, limitations } = lex(text);
  const symbols: CognitionSymbol[] = [];
  const imports: CognitionImport[] = [];
  const exports: CognitionExport[] = [];
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  const depths: Array<[number, number, number]> = [];
  for (const token of tokens) {
    depths.push([braces, parens, brackets]);
    if (token.kind !== "punct") continue;
    if (token.value === "{") braces += 1;
    if (token.value === "}") braces -= 1;
    if (token.value === "(") parens += 1;
    if (token.value === ")") parens -= 1;
    if (token.value === "[") brackets += 1;
    if (token.value === "]") brackets -= 1;
    if (braces < 0 || parens < 0 || brackets < 0) {
      limitations.push({ code: "unbalanced_syntax", detail: "Unbalanced delimiters; index is partial." });
      braces = Math.max(0, braces); parens = Math.max(0, parens); brackets = Math.max(0, brackets);
    }
  }
  if (braces || parens || brackets) limitations.push({ code: "unbalanced_syntax", detail: "Unclosed delimiters; index is partial." });
  const top = (index: number): boolean => depths[index]?.every((depth) => depth === 0) ?? false;
  const value = (index: number): string => tokens[index]?.value ?? "";
  const word = (index: number): boolean => tokens[index]?.kind === "word";
  const isWord = (index: number, text: string): boolean => word(index) && value(index) === text;
  const exported = (index: number): boolean => {
    let cursor = index - 1;
    while (["async", "default", "declare", "abstract"].includes(value(cursor)) && word(cursor)) cursor -= 1;
    return isWord(cursor, "export");
  };
  const importNames = (start: number, end: number): string[] => {
    const names: string[] = [];
    for (let cursor = start; cursor < end; cursor += 1) {
      if (!word(cursor) || ["type", "as", "from"].includes(value(cursor)) || isWord(cursor - 1, "as")) continue;
      names.push(value(cursor));
    }
    return [...new Set(names)];
  };
  const addImport = (specifierIndex: number, kind: CognitionImport["kind"], start: number, typeOnly = false): void => {
    const token = tokens[specifierIndex];
    if (token?.kind !== "string" || token.value === "") {
      limitations.push({ code: "nonliteral_import", detail: `Nonliteral ${kind} import at line ${tokens[start]?.line ?? 1} is unresolved.` });
      return;
    }
    let names = kind === "static" || kind === "reexport" ? importNames(start + 1, specifierIndex - 1) : [];
    if (kind === "require" && value(start - 1) === "=" && value(start - 2) === "}") {
      let cursor = start - 3;
      while (cursor >= 0 && value(cursor) !== "{") cursor -= 1;
      names = [];
      for (cursor += 1; cursor < start - 2; cursor += 1) {
        if (word(cursor) && ["{", ","].includes(value(cursor - 1))) names.push(value(cursor));
      }
    }
    imports.push({
      specifier: token.value, kind, line: tokens[start]?.line ?? 1, typeOnly,
      importedNames: names,
    });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "word") continue;
    if ((token.value === "require" || token.value === "import") && value(index + 1) === "(" &&
        ![".", "?."].includes(value(index - 1))) {
      if (tokens[index + 2]?.kind === "string" && [")", ","].includes(value(index + 3))) {
        addImport(index + 2, token.value === "require" ? "require" : "dynamic", index);
      } else limitations.push({ code: "nonliteral_import", detail: `Nonliteral ${token.value} at line ${token.line} is unresolved.` });
      continue;
    }
    if (!top(index) || [".", "?."].includes(value(index - 1))) continue;
    if (token.value === "import" || token.value === "export") {
      if (token.value === "import" && tokens[index + 1]?.kind === "string") addImport(index + 1, "static", index);
      let cursor = index + 1;
      while (cursor < tokens.length) {
        if (value(cursor) === ";" && top(cursor)) break;
        if (cursor > index + 1 && top(cursor) && tokens[cursor]!.line > token.line &&
            ["import", "export", "const", "let", "var", "function", "class"].includes(value(cursor))) break;
        if (isWord(cursor, "from") && tokens[cursor + 1]?.kind === "string") {
          addImport(cursor + 1, token.value === "import" ? "static" : "reexport", index, isWord(index + 1, "type"));
          break;
        }
        if (top(cursor) && value(cursor) === "=") break;
        cursor += 1;
      }
      if (token.value === "export" && value(index + 1) === "{") {
        for (let cursor = index + 2; cursor < tokens.length && value(cursor) !== "}"; cursor += 1) {
          if (word(cursor) && !["as", "type"].includes(value(cursor)) && !isWord(cursor - 1, "as")) {
            exports.push({ localName: value(cursor), name: isWord(cursor + 1, "as") ? value(cursor + 2) : value(cursor), line: token.line });
          }
        }
      }
    }
    if (["namespace", "enum"].includes(token.value)) {
      limitations.push({ code: "unsupported_declaration", detail: `${token.value} at line ${token.line} is not indexed.` });
    }
    const kinds: Record<string, CognitionSymbol["kind"]> = {
      function: "function", class: "class", interface: "interface", type: "type",
      const: "variable", let: "variable", var: "variable",
    };
    const kind = kinds[token.value];
    if (kind === undefined || (token.value === "type" && isWord(index - 1, "import"))) continue;
    let previous = index - 1;
    if (isWord(previous, "async")) previous -= 1;
    if ((kind === "function" || kind === "class") &&
        ["=", ":", ",", "return", "=>"].includes(value(previous))) continue;
    let nameIndex = index + 1;
    if (token.value === "function" && value(nameIndex) === "*") nameIndex += 1;
    if (!word(nameIndex)) {
      if (kind === "variable") limitations.push({ code: "destructured_declaration", detail: `Destructured declarations at line ${token.line} are not indexed.` });
      continue;
    }
    if (kind === "type" && value(nameIndex + 1) !== "=" && value(nameIndex + 1) !== "<") continue;
    symbols.push({ name: value(nameIndex), kind, line: token.line, exported: exported(index) });
    if (exported(index)) exports.push({ name: value(nameIndex), localName: value(nameIndex), line: token.line });
    if (kind === "variable") {
      for (let cursor = nameIndex + 1; cursor < tokens.length; cursor += 1) {
        if (top(cursor) && (value(cursor) === ";" ||
          (tokens[cursor]!.line > token.line && ["export", "const", "let", "var", "function"].includes(value(cursor))))) break;
        if (top(cursor) && value(cursor) === "," && word(cursor + 1)) {
          symbols.push({ name: value(cursor + 1), kind, line: tokens[cursor + 1]!.line, exported: exported(index) });
        }
      }
    }
  }
  // CommonJS names are recognized without executing module initialization.
  for (let index = 0; index < tokens.length; index += 1) {
    if (!top(index)) continue;
    let cursor = index;
    if (isWord(cursor, "module") && value(cursor + 1) === "." && isWord(cursor + 2, "exports")) cursor += 2;
    else if (!isWord(cursor, "exports")) continue;
    if (value(cursor + 1) === "." && word(cursor + 2) && value(cursor + 3) === "=") {
      exports.push({ name: value(cursor + 2), localName: value(cursor + 4), line: tokens[index]!.line });
    } else if (value(cursor + 1) === "=" && value(cursor + 2) === "{") {
      for (let end = cursor + 3; end < tokens.length && value(end) !== "}"; end += 1) {
        if (!word(end) || (value(end - 1) !== "{" && value(end - 1) !== ",")) continue;
        exports.push({ name: value(end), localName: value(end + 1) === ":" ? value(end + 2) : value(end), line: tokens[end]!.line });
      }
    }
  }
  const exportedNames = new Set(exports.map((entry) => entry.localName));
  return {
    symbols: symbols.map((symbol) => ({ ...symbol, exported: symbol.exported || exportedNames.has(symbol.name) })),
    imports, exports,
    limitations: [...new Map(limitations.map((item) => [JSON.stringify(item), item])).values()],
  };
}
