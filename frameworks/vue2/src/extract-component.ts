import type { Component, ComponentTypeInfo } from "@previewjs/core";
import {
  extractCsf3Stories,
  extractDefaultComponent,
  resolveComponent,
} from "@previewjs/csf3";
import { helpers, TypeResolver, UNKNOWN_TYPE } from "@previewjs/type-analyzer";
import ts from "typescript";
import { inferComponentNameFromVuePath } from "./infer-component-name";

export function extractVueComponents(
  resolver: TypeResolver,
  absoluteFilePath: string
): Component[] {
  const sourceFile = resolver.sourceFile(absoluteFilePath);
  if (!sourceFile) {
    return [];
  }

  const functions: Array<[string, ts.Statement, ts.Node]> = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) {
        // Avoid duplicates.
        continue;
      }
      functions.push(["default", statement, statement.expression]);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
          continue;
        }
        functions.push([
          declaration.name.text,
          statement,
          declaration.initializer,
        ]);
      }
    } else if (ts.isFunctionDeclaration(statement)) {
      const isDefaultExport =
        !!statement.modifiers?.find(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword
        ) &&
        !!statement.modifiers?.find(
          (m) => m.kind === ts.SyntaxKind.DefaultKeyword
        );
      const name = statement.name?.text;
      if (isDefaultExport || name) {
        functions.push([name || "default", statement, statement]);
      }
    }
  }

  const storiesDefaultComponent = extractDefaultComponent(sourceFile);
  const resolvedStoriesComponent = storiesDefaultComponent
    ? resolveComponent(resolver.checker, storiesDefaultComponent)
    : null;
  const components: Component[] = [];
  const nameToExportedName = helpers.extractExportedNames(sourceFile);
  const args = helpers.extractArgs(sourceFile);

  function extractComponentTypeInfo(
    node: ts.Node,
    name: string
  ): ComponentTypeInfo | null {
    const hasArgs = !!args[name];
    const isExported = name === "default" || !!nameToExportedName[name];
    if (storiesDefaultComponent && hasArgs && isExported) {
      return { kind: "story", associatedComponent: resolvedStoriesComponent };
    }
    const type = resolver.checker.getTypeAtLocation(node);
    for (const callSignature of type.getCallSignatures()) {
      const returnType = callSignature.getReturnType();
      if (isJsxElement(returnType)) {
        return {
          kind: "component",
          exported: isExported,
          analyze: async () => ({
            // TODO: Handle JSX properties.
            propsType: UNKNOWN_TYPE,
            types: {},
          }),
        };
      }
      if (isExported && returnType.getProperty("template")) {
        // This is a story.
        return { kind: "story", associatedComponent: resolvedStoriesComponent };
      }
    }
    return null;
  }

  for (const [name, statement, node] of functions) {
    const info = extractComponentTypeInfo(node, name);
    if (info) {
      components.push({
        absoluteFilePath,
        name,
        offsets: [[statement.getStart(), statement.getEnd()]],
        info,
      });
    }
  }

  return [...components, ...extractCsf3Stories(resolver, sourceFile)].map(
    (c) => ({
      ...c,
      info:
        c.info.kind === "story"
          ? {
              kind: "story",
              associatedComponent: c.info.associatedComponent
                ? transformVirtualTsVueFile(c.info.associatedComponent)
                : null,
            }
          : c.info,
    })
  );
}

function transformVirtualTsVueFile({
  absoluteFilePath,
  name,
}: {
  absoluteFilePath: string;
  name: string;
}) {
  if (absoluteFilePath.endsWith(".vue.ts")) {
    absoluteFilePath = absoluteFilePath.substring(
      0,
      absoluteFilePath.length - 3
    );
    name = inferComponentNameFromVuePath(absoluteFilePath);
  }
  return { absoluteFilePath, name };
}

const jsxElementTypes = new Set(["Element"]);
function isJsxElement(type: ts.Type): boolean {
  if (type.isUnion()) {
    for (const subtype of type.types) {
      if (isJsxElement(subtype)) {
        return true;
      }
    }
  }
  return jsxElementTypes.has(type.symbol?.getEscapedName().toString());
}
