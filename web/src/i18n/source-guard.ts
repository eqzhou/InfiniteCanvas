import ts from "typescript";

const HAN = /[\p{Script=Han}]/u;
const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
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

function visibleChinese(node: ts.Node): string | undefined {
  if (ts.isJsxText(node)) return HAN.test(node.text) ? node.text.trim() : undefined;
  if (ts.isJsxAttribute(node) && VISIBLE_ATTRIBUTES.has(node.name.getText())) {
    const initializer = node.initializer;
    if (!initializer) return undefined;
    if (ts.isStringLiteral(initializer)) return HAN.test(initializer.text) ? initializer.text : undefined;
    if (ts.isJsxExpression(initializer) && initializer.expression) {
      if (isTranslationCall(initializer.expression)) return undefined;
      const value = staticText(initializer.expression);
      return value && HAN.test(value) ? value : undefined;
    }
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && (node.expression.text === "alert" || node.expression.text === "confirm")) {
    const value = node.arguments[0] && staticText(node.arguments[0]);
    return value && HAN.test(value) ? value : undefined;
  }
  return undefined;
}

export function findHardcodedUserFacingChinese(
  sources: Readonly<Record<string, string>>,
): LocalizationViolation[] {
  const violations: LocalizationViolation[] = [];
  for (const [relativeFile, sourceText] of Object.entries(sources)) {
    const source = ts.createSourceFile(relativeFile, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      const text = visibleChinese(node);
      if (text) {
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
