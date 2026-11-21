import type { Cell } from "./table-model.ts";

const precedence = {
  "=": 1,
  "<>": 1,
  ">": 1,
  "<": 1,
  ">=": 1,
  "<=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
} as const;
type Operator = keyof typeof precedence;
type Name = "SUM" | "AVG" | "MIN" | "MAX" | "COUNT" | "ROUND" | "IF";
const names = new Set<string>([
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COUNT",
  "ROUND",
  "IF",
]);

type Token =
  | { type: "number"; text: string }
  | { type: "column"; text: string }
  | { type: "name"; text: Name }
  | { type: "operator"; text: Operator }
  | { type: "(" | ")" | "," | "end" };
type Expression =
  | { type: "number"; value: number }
  | { type: "column"; key: string }
  | { type: "unary"; negative: boolean; value: Expression }
  | { type: "binary"; operator: Operator; left: Expression; right: Expression }
  | { type: "call"; name: Name; args: Expression[] };

export class FormulaError extends Error {}

function tokensOf(source: string): Token[] {
  const input = source.replace(/^\s*=/, "");
  const tokens: Token[] = [];
  const number = /(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/y;
  const name = /[a-z]+/iy;
  for (let offset = 0; offset < input.length;) {
    const char = input[offset];
    if (/\s/.test(char)) {
      offset++;
      continue;
    }
    if (tokens.length >= 2000)
      throw new FormulaError("公式最多包含 2,000 个记号。");
    if (char === "[") {
      let column = "";
      let closed = false;
      for (offset++; offset < input.length; offset++) {
        if (input[offset] === "]") {
          if (input[offset + 1] !== "]") {
            offset++;
            closed = true;
            break;
          }
          offset++;
        }
        column += input[offset];
      }
      if (!closed || !column.trim())
        throw new FormulaError("请用方括号写出完整的列引用。");
      tokens.push({ type: "column", text: column });
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: char });
      offset++;
      continue;
    }
    const pair = input.slice(offset, offset + 2);
    if (Object.hasOwn(precedence, pair) || Object.hasOwn(precedence, char)) {
      const op = (Object.hasOwn(precedence, pair) ? pair : char) as Operator;
      tokens.push({ type: "operator", text: op });
      offset += op.length;
      continue;
    }
    number.lastIndex = offset;
    const numeric = number.exec(input);
    if (numeric) {
      if (!Number.isFinite(Number(numeric[0])))
        throw new FormulaError("公式中的数字超出了可表示范围。");
      tokens.push({ type: "number", text: numeric[0] });
      offset = number.lastIndex;
      continue;
    }
    name.lastIndex = offset;
    const word = name.exec(input);
    const upper = word?.[0].toUpperCase();
    if (upper && names.has(upper)) {
      tokens.push({ type: "name", text: upper as Name });
      offset = name.lastIndex;
      continue;
    }
    throw new FormulaError(`无法识别公式中的「${word?.[0] ?? char}」。`);
  }
  return [...tokens, { type: "end" }];
}

function sourceOf(token: Token) {
  if (token.type === "end") return "";
  if (token.type === "column")
    return "[" + token.text.replaceAll("]", "]]") + "]";
  return "text" in token ? token.text : token.type;
}

export type CompiledFormula = {
  source: string;
  dependencies: string[];
  run(read: (key: string) => Cell): Cell;
};

export function compileFormula(
  source: string,
  resolveColumn: (reference: string) => string = (reference) => reference,
): CompiledFormula {
  const tokens = tokensOf(source);
  const dependencies = new Set<string>();
  let cursor = 0;
  const peek = () => tokens[cursor];
  function expect(type: ")" | "(") {
    if (peek().type !== type) throw new FormulaError(`公式缺少「${type}」。`);
    cursor++;
  }
  function prefix(depth: number): Expression {
    if (depth > 32) throw new FormulaError("公式嵌套最多 32 层。");
    const token = tokens[cursor++];
    if (token.type === "number")
      return { type: "number", value: Number(token.text) };
    if (token.type === "column") {
      token.text = resolveColumn(token.text);
      dependencies.add(token.text);
      return { type: "column", key: token.text };
    }
    if (token.type === "operator" && (token.text === "+" || token.text === "-"))
      return {
        type: "unary",
        negative: token.text === "-",
        value: prefix(depth + 1),
      };
    if (token.type === "(") {
      const value = expression(1, depth + 1);
      expect(")");
      return value;
    }
    if (token.type === "name") {
      expect("(");
      const args: Expression[] = [];
      if (peek().type !== ")") {
        while (true) {
          args.push(expression(1, depth + 1));
          if (peek().type !== ",") break;
          cursor++;
        }
      }
      expect(")");
      if (token.text === "IF" && args.length !== 3)
        throw new FormulaError("IF 需要条件、成立时的值和不成立时的值。");
      if (token.text === "ROUND" && (args.length < 1 || args.length > 2))
        throw new FormulaError("ROUND 需要数值，可再填保留的小数位数。");
      return { type: "call", name: token.text, args };
    }
    throw new FormulaError("这里需要数值、列引用或子公式。");
  }
  function expression(minimum: number, depth: number): Expression {
    let left = prefix(depth);
    for (let token = peek(); token.type === "operator"; token = peek()) {
      const rank = precedence[token.text];
      if (rank < minimum) break;
      cursor++;
      const right = expression(rank + 1, depth);
      left = { type: "binary", operator: token.text, left, right };
    }
    return left;
  }
  const parsed = expression(1, 0);
  if (peek().type !== "end") throw new FormulaError("公式含有未使用的记号。");
  return {
    source: tokens.map(sourceOf).join(""),
    dependencies: [...dependencies],
    run: (read) => valueOf(parsed, read),
  };
}

function numeric(value: Cell): number {
  if (value === null) throw new FormulaError("计算需要的单元格为空。");
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new FormulaError("计算需要数字类型的单元格。");
  return value;
}

function finite(value: number) {
  if (!Number.isFinite(value))
    throw new FormulaError("计算结果超出了数值范围。");
  return value;
}

function binary(operator: Operator, left: Cell, right: Cell): Cell {
  if (left === null || right === null)
    throw new FormulaError("计算需要的单元格为空。");
  if (operator === "=" || operator === "<>") {
    if (typeof left !== typeof right)
      throw new FormulaError("比较要求两侧的值类型一致。");
    return operator === "=" ? left === right : left !== right;
  }
  const a = numeric(left);
  const b = numeric(right);
  switch (operator) {
    case "+":
      return finite(a + b);
    case "-":
      return finite(a - b);
    case "*":
      return finite(a * b);
    case "/":
      if (b === 0) throw new FormulaError("无法除以零。");
      return finite(a / b);
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

function valueOf(tree: Expression, read: (key: string) => Cell): Cell {
  switch (tree.type) {
    case "number":
      return tree.value;
    case "column":
      return read(tree.key);
    case "unary": {
      const value = numeric(valueOf(tree.value, read));
      return tree.negative ? -value : value;
    }
    case "binary":
      return binary(
        tree.operator,
        valueOf(tree.left, read),
        valueOf(tree.right, read),
      );
    case "call": {
      if (tree.name === "IF") {
        const condition = valueOf(tree.args[0], read);
        if (typeof condition !== "boolean")
          throw new FormulaError("IF 的条件需要返回真或假。");
        return valueOf(tree.args[condition ? 1 : 2], read);
      }
      const values = tree.args.map((arg) => valueOf(arg, read));
      if (tree.name === "ROUND") {
        const value = numeric(values[0]);
        const digits = values.length === 1 ? 0 : numeric(values[1]);
        if (!Number.isInteger(digits) || Math.abs(digits) > 15)
          throw new FormulaError("小数位数须为 -15 到 15 之间的整数。");
        const scale = 10 ** digits;
        return finite(
          (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale,
        );
      }
      const present = values.filter((value) => value !== null);
      if (tree.name === "COUNT") return present.length;
      const numbers = present.map(numeric);
      if (tree.name === "MIN" || tree.name === "MAX") {
        if (!numbers.length) throw new FormulaError("没有可聚合的数字。");
        return tree.name === "MIN"
          ? Math.min(...numbers)
          : Math.max(...numbers);
      }
      const sum = numbers.reduce((total, number) => total + number, 0);
      if (tree.name === "AVG" && !numbers.length)
        throw new FormulaError("没有可求平均的数字。");
      return finite(tree.name === "AVG" ? sum / numbers.length : sum);
    }
  }
}
