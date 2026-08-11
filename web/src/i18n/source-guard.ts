import ts from "typescript";

const HAN = /[\p{Script=Han}]/u;
const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "label",
  "placeholder",
  "title",
]);

export type LocalizationViolation = Readonly<{
  file: string;
  line: number;
  column: number;
  text: string;
}>;

function staticText(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
  }
  return undefined;
}

function isTranslationCall(node: ts.Node): boolean {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && (node.expression.text === "t" || node.expression.text === "translate");
}

function staticTexts(node: ts.Node): string[] {
  const value = staticText(node);
  if (value !== undefined) return [value];
  if (ts.isConditionalExpression(node)) return [...staticTexts(node.whenTrue), ...staticTexts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...staticTexts(node.left), ...staticTexts(node.right)];
  }
  return [];
}

function visibleChinese(node: ts.Node): string[] {
  if (ts.isJsxText(node)) return HAN.test(node.text) ? [node.text.trim()] : [];
  if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText())) {
    const initializer = node.initializer;
    if (!initializer) return [];
    if (ts.isStringLiteral(initializer)) return HAN.test(initializer.text) ? [initializer.text] : [];
    if (ts.isJsxExpression(initializer) && initializer.expression) {
      if (isTranslationCall(initializer.expression)) return [];
      return staticTexts(initializer.expression).filter((value) => HAN.test(value));
    }
  }
  if (ts.isJsxExpression(node) && node.expression && !isTranslationCall(node.expression)) {
    return staticTexts(node.expression).filter((value) => HAN.test(value));
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && (node.expression.text === "alert" || node.expression.text === "confirm" || node.expression.text === "setError" || node.expression.text === "setErr")) {
    return node.arguments[0] ? staticTexts(node.arguments[0]).filter((value) => HAN.test(value)) : [];
  }
  return [];
}

export function findHardcodedUserFacingChinese(
  sources: Readonly<Record<string, string>>,
): LocalizationViolation[] {
  const violations: LocalizationViolation[] = [];
  for (const [relativeFile, sourceText] of Object.entries(sources)) {
    const source = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const texts = visibleChinese(node);
      for (const text of texts) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push({
          file: relativeFile,
          line: position.line + 1,
          column: position.character + 1,
          text: text.replace(/\s+/g, " ").trim(),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
