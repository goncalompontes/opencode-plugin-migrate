/** Turn a V1 plugin module into the IR used by the rest of the pipeline. */
import path from "node:path"
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type SourceFile,
} from "ts-morph"
import type { Diagnostic } from "../core/diagnostics"
import type { HookSite, ImportIR, PluginIR, ToolSite } from "./schema"
import type { PluginProject } from "../env/project"
import { HOOK_RULES } from "../rules/hooks"

function hasKnownHook(object: ObjectLiteralExpression): boolean {
  return object.getProperties().some((property) => {
    const name = hookNameOf(property)
    return name === "tool" || (name !== undefined && name in HOOK_RULES)
  })
}

type Factory =
  | ArrowFunction
  | FunctionExpression
  | FunctionDeclaration
  | MethodDeclaration

const V1_PACKAGE = "@opencode-ai/plugin"

function isFunctionNode(node: Node | undefined): node is Factory {
  return (
    !!node &&
    (Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node))
  )
}

/** A V1 plugin factory returns its hook object directly (or is already typed as Plugin). */
function isFactoryNode(node: Node | undefined): node is Factory {
  if (!isFunctionNode(node)) return false
  const annotation = node.getReturnType().getText(node)
  if (/\bHooks\b|\bPlugin\b/.test(annotation)) return true
  const body = node.getBody()
  if (!body) return false
  if (!Node.isBlock(body)) return true
  return body
    .getStatements()
    .filter(Node.isReturnStatement)
    .some((statement) => {
      const expression = resolveValue(statement.getExpression())
      return !!expression && Node.isObjectLiteralExpression(expression) && hasKnownHook(expression)
    })
}

/** Unwrap parens/casts/identifiers down to the value they denote. */
function resolveValue(node: Node | undefined): Node | undefined {
  if (!node) return undefined
  if (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isTypeAssertion(node) ||
    Node.isNonNullExpression(node)
  ) {
    return resolveValue(node.getExpression())
  }
  if (Node.isIdentifier(node)) {
    const declaration = node.getDefinitions()[0]?.getDeclarationNode()
    if (declaration && Node.isVariableDeclaration(declaration)) {
      return resolveValue(declaration.getInitializer())
    }
  }
  return node
}

function rangeOf(_file: SourceFile, node: Node) {
  const owner = node.getSourceFile()
  const start = node.getStart()
  const { line, column } = owner.getLineAndColumnAtPos(start)
  return { file: owner.getFilePath(), start, end: node.getEnd(), line, column }
}

function statementText(node: Node): string {
  const file = node.getSourceFile()
  const { column } = file.getLineAndColumnAtPos(node.getStart())
  const lines = node.getText().split("\n")
  return lines
    .map((line, index) => {
      if (index === 0) return line.trimStart()
      let remove = 0
      while (remove < column - 1 && (line[remove] === " " || line[remove] === "\t")) remove += 1
      const rest = line.slice(remove)
      const leading = /^[ \t]*/.exec(rest)?.[0] ?? ""
      return leading.replace(/\t/g, "  ") + rest.slice(leading.length)
    })
    .join("\n")
}

function renderStatements(body: Node | undefined): string {
  if (!body) return ""
  if (Node.isBlock(body)) {
    return body
      .getStatements()
      .map((statement) => statementText(statement))
      .join("\n")
  }
  // Concise arrow body: keep it as an explicit return.
  return `return ${body.getText()}`
}

function typedParameters(fn: Factory): string[] {
  return fn.getParameters().map((parameter) => {
    const name = parameter.getNameNode()
    const rest = parameter.isRestParameter() ? "..." : ""
    const optional = parameter.hasQuestionToken() ? "?" : ""
    return `${rest}${name.getText()}${optional}: any`
  })
}

function paramInfo(factory: Factory): { names: string[]; patterns: string[]; inputParam?: string } {
  const names: string[] = []
  const patterns: string[] = []
  for (const param of factory.getParameters()) {
    const nameNode = param.getNameNode()
    if (Node.isIdentifier(nameNode)) {
      names.push(nameNode.getText())
      continue
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        const local = element.getNameNode()
        const property = element.getPropertyNameNode()
        if (Node.isIdentifier(local) && !property && !element.getInitializer()) {
          names.push(local.getText())
        } else {
          // Aliased or nested destructuring: keep it visible instead of guessing a mapping.
          patterns.push(element.getText())
        }
      }
      continue
    }
    patterns.push(nameNode.getText())
  }
  return { names, patterns }
}

function inputParamOf(factory: Factory): string | undefined {
  const first = factory.getParameters()[0]
  const nameNode = first?.getNameNode()
  return nameNode && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined
}

interface FoundFactory {
  factory: Factory
  dualShape: boolean
  exportName?: string
}

function findInSourceFile(file: SourceFile): FoundFactory | undefined {
  const declarations = file.getExportedDeclarations()
  const ordered: Array<{ name: string; node: Node }> = []
  for (const [name, nodes] of declarations) {
    for (const node of nodes) ordered.push({ name, node })
  }
  // `export default X` yields the declaration of X, and named exports are just as valid.
  ordered.sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : 0))

  for (const { name, node } of ordered) {
    let candidate: Node | undefined
    if (Node.isVariableDeclaration(node)) candidate = node.getInitializer()
    else if (isFactoryNode(node)) candidate = node
    else if (Node.isExportAssignment(node)) candidate = node.getExpression()
    if (!candidate) continue

    const resolved = resolveValue(candidate)
    if (isFactoryNode(resolved)) {
      return { factory: resolved, dualShape: false, exportName: name }
    }
    if (resolved && Node.isObjectLiteralExpression(resolved)) {
      const server = resolved.getProperty("server")
      const serverValue =
        server && (Node.isPropertyAssignment(server) || Node.isShorthandPropertyAssignment(server))
          ? resolveValue(Node.isPropertyAssignment(server) ? server.getInitializer() : server.getNameNode())
          : undefined
      if (isFactoryNode(serverValue)) {
        return { factory: serverValue, dualShape: true, exportName: name }
      }
    }
  }
  return undefined
}

function findFactory(project: Project, entryFile: string): FoundFactory | undefined {
  const entry = project.getSourceFile(entryFile)
  if (!entry) return undefined
  const found = findInSourceFile(entry)
  if (found) return found

  // A plugin can live behind a barrel/re-export; scan the rest of the project.
  for (const file of project.getSourceFiles()) {
    if (file.getFilePath() === entryFile) continue
    const other = findInSourceFile(file)
    if (other) return other
  }
  return undefined
}

function hookNameOf(property: Node): string | undefined {
  if (Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
    const name = property.getNameNode()
    if (Node.isStringLiteral(name) || Node.isNoSubstitutionTemplateLiteral(name)) return name.getLiteralText()
    if (Node.isIdentifier(name)) return name.getText()
    if (Node.isComputedPropertyName(name)) return name.getExpression().getText()
  }
  if (Node.isShorthandPropertyAssignment(property)) return property.getName()
  return undefined
}

function callbackOf(property: Node): Node | undefined {
  if (Node.isPropertyAssignment(property)) return resolveValue(property.getInitializer())
  if (Node.isShorthandPropertyAssignment(property)) return resolveValue(property.getNameNode())
  if (Node.isMethodDeclaration(property)) return property
  return undefined
}

function stringField(config: ObjectLiteralExpression, key: string): string {
  const prop = config.getProperty(key)
  const initializer = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined
  if (!initializer) return ""
  const text = initializer.getText()
  return /^["'`]/.test(text) ? text.replace(/^["'`]|["'`]$/g, "") : text
}

function extractTools(object: ObjectLiteralExpression, file: SourceFile, diagnostics: Diagnostic[]): ToolSite[] {
  const tools: ToolSite[] = []
  for (const property of object.getProperties()) {
    const name = hookNameOf(property)
    if (!name) continue
    if (!Node.isPropertyAssignment(property)) {
      diagnostics.push({
        code: "tool/shape",
        severity: "warning",
        message: `custom tool "${name}" is not a property assignment and was skipped`,
        range: rangeOf(file, property),
      })
      continue
    }

    const initializer = property.getInitializer()
    if (!initializer) continue
    const reference = initializer.getText()

    if (Node.isCallExpression(initializer)) {
      const config = initializer.getArguments()[0]
      if (!config || !Node.isObjectLiteralExpression(config)) {
        diagnostics.push({
          code: "tool/shape",
          severity: "warning",
          message: `custom tool "${name}" has no object literal configuration and was skipped`,
          range: rangeOf(file, property),
        })
        continue
      }
      tools.push({
        name,
        description: stringField(config, "description"),
        reference,
        kind: "inline",
        range: rangeOf(file, property),
      })
      continue
    }

    if (Node.isIdentifier(initializer) || Node.isPropertyAccessExpression(initializer)) {
      // The definition lives elsewhere; the emitted registration reads it at runtime.
      let description = ""
      if (Node.isIdentifier(initializer)) {
        const declaration = resolveValue(initializer)
        if (declaration && Node.isCallExpression(declaration)) {
          const config = declaration.getArguments()[0]
          if (config && Node.isObjectLiteralExpression(config)) description = stringField(config, "description")
        }
      }
      tools.push({ name, description, reference, kind: "reference", range: rangeOf(file, property) })
      continue
    }

    diagnostics.push({
      code: "tool/shape",
      severity: "warning",
      message: `custom tool "${name}" is neither a tool(...) call nor an identifier and was skipped`,
      range: rangeOf(file, property),
    })
  }
  return tools
}

export function extractPlugin(project: PluginProject): PluginIR {
  if (!/\.[cm]?tsx?$/.test(project.entryFile)) {
    throw new Error(
      `${project.entryFile} is JavaScript. V1 -> V2 conversion currently needs TypeScript sources so hook signatures and tool schemas can be typed.`,
    )
  }
  const diagnostics: Diagnostic[] = []
  const options: ConstructorParameters<typeof Project>[0] = {
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      allowJs: false,
    },
    skipAddingFilesFromTsConfig: true,
    // We only need symbols/return types from the plugin itself; skip parsing the
    // TypeScript standard library into every extraction.
    skipLoadingLibFiles: true,
  }
  if (project.tsconfigPath) options.tsConfigFilePath = project.tsconfigPath

  const tsProject = new Project(options)
  for (const file of project.sourceFiles) tsProject.addSourceFileAtPathIfExists(file)
  let sourceFile = tsProject.getSourceFile(project.entryFile)
  if (!sourceFile) throw new Error(`could not load ${project.entryFile}`)

  const importsV1 = tsProject
    .getSourceFiles()
    .some((file) => file.getImportDeclaration("@opencode-ai/plugin") !== undefined)
  const looksV2 = tsProject
    .getSourceFiles()
    .some(
      (file) =>
        file.getImportDeclaration("@opencode/plugin") !== undefined ||
        /Plugin\.define\s*\(/.test(file.getText()),
    )
  const found = importsV1 || !looksV2 ? findFactory(tsProject, project.entryFile) : undefined
  if (!found) {
    const alreadyV2 = tsProject
      .getSourceFiles()
      .some(
        (file) =>
          file.getImportDeclaration("@opencode/plugin") !== undefined ||
          /Plugin\.define\s*\(/.test(file.getText()),
      )
    if (alreadyV2) {
      throw new Error(
        `${project.dir} already targets the OpenCode V2 plugin API (@opencode/plugin); there is nothing to migrate.`,
      )
    }
    throw new Error(
      `no V1 plugin factory found in ${project.entryFile}. Expected an exported Plugin-typed function or a default-exported { server } object.`,
    )
  }

  const { factory, dualShape, exportName } = found
  const factoryFile = factory.getSourceFile()
  if (factoryFile.getFilePath() !== sourceFile.getFilePath()) {
    diagnostics.push({
      code: "entry/reexport",
      severity: "info",
      message: `the plugin factory lives in ${factoryFile.getFilePath()}; that file is the conversion target, and the re-exporting entrypoint is left untouched.`,
    })
    sourceFile = factoryFile
  }
  const preservedExport = exportName && exportName !== "default" && !dualShape ? exportName : undefined
  const { names, patterns } = paramInfo(factory)
  const inputParam = inputParamOf(factory)
  if (dualShape) {
    diagnostics.push({
      code: "entry/dual-shape",
      severity: "info",
      message:
        "entrypoint already exposes a V2 setup(); conversion targets its V1 server() branch. Keep the existing setup or review both after conversion.",
    })
  }
  if (patterns.length > 0) {
    diagnostics.push({
      code: "factory/params",
      severity: "warning",
      message: `factory uses destructured parameters (${patterns.join(", ")}); only simple names are mapped automatically`,
      range: rangeOf(sourceFile, factory),
    })
  }

  const factoryBody = factory.getBody()
  let hookObject: ObjectLiteralExpression | undefined
  let init = ""

  if (factoryBody && Node.isBlock(factoryBody)) {
    const statements = factoryBody.getStatements()
    const returnStatement = [...statements].reverse().find(Node.isReturnStatement)
    if (returnStatement) {
      const returned = resolveValue(returnStatement.getExpression())
      if (returned && Node.isObjectLiteralExpression(returned)) hookObject = returned
      const index = statements.indexOf(returnStatement)
      init = statements
        .slice(0, index)
        .map((statement) => statementText(statement))
        .join("\n")
    }
    if (!hookObject) {
      diagnostics.push({
        code: "factory/return",
        severity: "warning",
        message: "last return statement in the plugin factory does not return an object literal; hooks cannot be read statically",
        range: rangeOf(sourceFile, factory),
      })
    }
  } else if (factoryBody) {
    // Concise arrow: `async () => ({ ...hooks })`.
    const returned = resolveValue(factoryBody)
    if (returned && Node.isObjectLiteralExpression(returned)) hookObject = returned
    else {
      diagnostics.push({
        code: "factory/return",
        severity: "warning",
        message: "concise factory body does not return an object literal; hooks cannot be read statically",
        range: rangeOf(sourceFile, factory),
      })
    }
  }

  const hooks: HookSite[] = []
  const tools: ToolSite[] = []

  for (const property of hookObject?.getProperties() ?? []) {
    if (Node.isSpreadAssignment(property)) {
      diagnostics.push({
        code: "hook/spread",
        severity: "warning",
        message: "spread hooks are not analyzed statically and are dropped from the converted module",
        range: rangeOf(sourceFile, property),
      })
      continue
    }
    const name = hookNameOf(property)
    if (!name) {
      diagnostics.push({
        code: "hook/name",
        severity: "warning",
        message: "computed hook name could not be resolved",
        range: rangeOf(sourceFile, property),
      })
      continue
    }
    if (name === "tool") {
      const value = callbackOf(property)
      const object = value && Node.isObjectLiteralExpression(value) ? value : undefined
      if (object) tools.push(...extractTools(object, sourceFile, diagnostics))
      else {
        diagnostics.push({
          code: "tool/shape",
          severity: "warning",
          message: "`tool` hook is not an object literal; custom tools are reported but not converted",
          range: rangeOf(sourceFile, property),
        })
      }
      continue
    }

    const callback = callbackOf(property)
    if (!isFunctionNode(callback)) {
      diagnostics.push({
        code: "hook/shape",
        severity: "warning",
        message: `hook "${name}" is not a function literal and is dropped from the converted module`,
        range: rangeOf(sourceFile, property),
      })
      continue
    }

    const { names: hookParams, patterns: hookPatterns } = paramInfo(callback)
    const positional = callback
      .getParameters()
      .every((parameter) => Node.isIdentifier(parameter.getNameNode()))
    hooks.push({
      name,
      params: hookParams,
      paramsTyped: typedParameters(callback),
      body: renderStatements(callback.getBody()),
      isAsync: callback.isAsync(),
      usesAwait: callback.getDescendantsOfKind(SyntaxKind.AwaitExpression).length > 0,
      usesPatternParams: !positional,
      range: rangeOf(sourceFile, property),
      typeText: callback.getParameters()[1]?.getType().getText(callback),
    })
  }

  const imports: ImportIR[] = sourceFile
    .getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue() !== V1_PACKAGE)
    .map((declaration) => ({
      text: declaration.getText(),
      module: declaration.getModuleSpecifierValue(),
    }))

  // Everything at module scope except imports and the plugin factory itself: constants,
  // helper types, and functions the hook bodies close over.
  const factoryStatement =
    factory.getFirstAncestor((ancestor) => {
      const parent = ancestor.getParent()
      return !!parent && Node.isSourceFile(parent)
    }) ?? factory
  const factoryNames: string[] = Node.isVariableStatement(factoryStatement)
    ? factoryStatement.getDeclarations().map((declaration) => declaration.getName())
    : Node.isFunctionDeclaration(factoryStatement) || Node.isClassDeclaration(factoryStatement)
      ? factoryStatement.getName()
        ? [factoryStatement.getName() as string]
        : []
      : []
  const factoryReference = factoryNames.length
    ? new RegExp(`\\b(?:${factoryNames.join("|")})\\b`)
    : undefined
  const moduleScope = sourceFile
    .getStatements()
    .filter((statement) => Node.isImportDeclaration(statement) === false)
    .filter((statement) => statement !== factoryStatement)
    .filter((statement) => Node.isExportAssignment(statement) === false)
    // Drop declarations that reference the factory being replaced (dual-shape entry objects).
    .filter((statement) => !factoryReference || !factoryReference.test(statement.getText()))
    // Our emitted module defines its own setup.
    .filter(
      (statement) =>
        !(Node.isFunctionDeclaration(statement) && statement.getName() === "setup"),
    )
    .map((statement) => statementText(statement))
    .join("\n")

  const packageId = (
    project.packageName ??
    (exportName && exportName !== "default" ? exportName : path.basename(project.dir)) ??
    "plugin"
  ).replace(/^@[^/]+\//, "")
  const id = packageId.replace(/[^a-zA-Z0-9._-]/g, "-")

  return {
    id,
    packageName: project.packageName,
    sourceDir: project.dir,
    entryFile: sourceFile.getFilePath(),
    ...(preservedExport ? { exportName: preservedExport } : {}),
    sourceFiles: [...project.sourceFiles],
    ...(project.tsconfigPath ? { tsconfigPath: project.tsconfigPath } : {}),
    moduleScope,
    factory: {
      params: names,
      paramsTyped: typedParameters(factory),
      ...(inputParam ? { inputParam } : {}),
      init,
      isAsync: factory.isAsync(),
      dualShape,
    },
    imports,
    hooks,
    tools,
    diagnostics,
  }
}

/** Exported for tests: the value a hook body would see if it were rendered now. */
export function relativeEntry(ir: PluginIR): string {
  return path.relative(ir.sourceDir, ir.entryFile)
}
