import type { AstNode, StaticAnalysisResult } from "@gcd/shared";

type TokenKind =
  | "identifier"
  | "integer"
  | "new"
  | "Object"
  | "null"
  | "gc"
  | "="
  | "."
  | ";"
  | "("
  | ")"
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

interface Expression {
  kind: string;
  label: string;
}

interface Statement {
  kind: string;
  label: string;
  start: number;
  end: number;
  expression?: Expression;
}

class AnalysisError extends Error {
  constructor(readonly code: "LEX_ERROR" | "PARSE_ERROR", message: string) {
    super(message);
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset]!;
    if (/[ \t\n\r\v\f]/.test(char)) {
      offset++;
      continue;
    }
    if ("=.;()".includes(char)) {
      tokens.push({ kind: char as TokenKind, text: char, start: offset, end: offset + 1 });
      offset++;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = offset++;
      while (offset < source.length && /[0-9]/.test(source[offset]!)) offset++;
      tokens.push({ kind: "integer", text: source.slice(start, offset), start, end: offset });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = offset++;
      while (offset < source.length && /[A-Za-z0-9_]/.test(source[offset]!)) offset++;
      const text = source.slice(start, offset);
      const kind: TokenKind =
        text === "new" || text === "Object" || text === "null" || text === "gc"
          ? text
          : "identifier";
      tokens.push({ kind, text, start, end: offset });
      continue;
    }
    throw new AnalysisError("LEX_ERROR", `Lexer: unexpected character '${char}'`);
  }
  tokens.push({ kind: "eof", text: "", start: source.length, end: source.length });
  return tokens;
}

function parse(source: string, tokens: Token[]): Statement[] {
  const statements: Statement[] = [];
  let cursor = 0;
  const peek = (): Token => tokens[cursor]!;
  const advance = (): Token => tokens[cursor++]!;
  const expect = (kind: TokenKind, label: string): Token => {
    const token = peek();
    if (token.kind !== kind) {
      throw new AnalysisError("PARSE_ERROR", `Parser: expected ${label} but got '${token.text}'`);
    }
    return advance();
  };
  const expression = (): Expression => {
    const token = peek();
    if (token.kind === "integer") {
      advance();
      const value = Number(token.text);
      if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
        throw new AnalysisError("PARSE_ERROR", `integer literal is out of range: ${token.text}`);
      }
      return { kind: "IntLiteral", label: token.text };
    }
    if (token.kind === "null") {
      advance();
      return { kind: "NullLiteral", label: "null" };
    }
    if (token.kind === "new") {
      advance();
      expect("Object", "'Object'");
      expect("(", "'('");
      expect(")", "')'");
      return { kind: "NewObject", label: "Object" };
    }
    if (token.kind === "identifier") {
      const base = advance();
      if (peek().kind === ".") {
        advance();
        const field = expect("identifier", "field name");
        return { kind: "FieldAccess", label: `${base.text}.${field.text}` };
      }
      return { kind: "Identifier", label: base.text };
    }
    throw new AnalysisError("PARSE_ERROR", `Parser: expected an expression but got '${token.text}'`);
  };

  while (peek().kind !== "eof") {
    const start = peek().start;
    if (peek().kind === "gc") {
      advance();
      expect("(", "'('");
      expect(")", "')'");
      const end = expect(";", "';'").end;
      statements.push({ kind: "GcCall", label: "gc", start, end });
      continue;
    }
    const target = expect("identifier", "identifier");
    if (peek().kind === ".") {
      advance();
      const field = expect("identifier", "field name");
      expect("=", "'='");
      const value = expression();
      const end = expect(";", "';'").end;
      statements.push({
        kind: "FieldAssign",
        label: `${target.text}.${field.text}`,
        start,
        end,
        expression: value
      });
      continue;
    }
    expect("=", "'='");
    const value = expression();
    const end = expect(";", "';'").end;
    statements.push({
      kind: "Assign",
      label: target.text,
      start,
      end,
      expression: value
    });
  }
  return statements;
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index++) {
    if (source[index] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function createAst(source: string, statements: Statement[]): {
  ast: AstNode;
  nodeCount: number;
  truncated: boolean;
} {
  const ast: AstNode = { id: 0, kind: "Program", children: [] };
  let nextId = 1;
  let remainingExpressions = 4_999 - Math.min(statements.length, 4_999);
  let truncated = statements.length > 4_999;
  const shorten = (label: string) => label.length > 80 ? label.slice(0, 80) : label;
  for (const statement of statements.slice(0, 4_999)) {
    const startPosition = lineColumn(source, statement.start);
    const endPosition = lineColumn(source, statement.end);
    const node: AstNode = {
      id: nextId++,
      kind: statement.kind,
      label: shorten(statement.label),
      span: {
        start: Buffer.byteLength(source.slice(0, statement.start), "utf8"),
        end: Buffer.byteLength(source.slice(0, statement.end), "utf8"),
        ...startPosition,
        endLine: endPosition.line,
        endColumn: endPosition.column,
        provenance: "derived"
      },
      children: []
    };
    if (statement.expression) {
      if (remainingExpressions > 0) {
        node.children.push({
          id: nextId++,
          kind: statement.expression.kind,
          label: shorten(statement.expression.label),
          children: []
        });
        remainingExpressions--;
      } else {
        truncated = true;
      }
    }
    ast.children.push(node);
  }
  return { ast, nodeCount: nextId, truncated };
}

export function analyzeToy(source: string): StaticAnalysisResult {
  try {
    const statements = parse(source, tokenize(source));
    const { ast, nodeCount, truncated } = createAst(source, statements);
    return {
      schema: "gcd.static-analysis/1",
      language: "gcd-toy",
      ast,
      nodeCount,
      truncated,
      diagnostics: []
    };
  } catch (error) {
    if (!(error instanceof AnalysisError)) throw error;
    return {
      schema: "gcd.static-analysis/1",
      language: "gcd-toy",
      ast: null,
      nodeCount: 0,
      truncated: false,
      diagnostics: [{
        severity: "error",
        code: error.code,
        message: error.message
      }]
    };
  }
}
