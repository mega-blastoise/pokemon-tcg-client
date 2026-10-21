/** @module tcgdex Convert pinned provider records into drafts without executing source code. */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  commitSchema,
  identifierSchema,
  reviewSchema,
  setIdentifierSchema,
} from "@johto-ai/tcg-client/schema";
import ts from "typescript";
import { z } from "zod";
import { gitText, sha256, within, writeJson } from "./files.js";

/** Literal values allowed in provider evidence; executable expressions are excluded. */
export type Value =
  | null
  | boolean
  | string
  | number
  | Value[]
  | { [key: string]: Value };
export type RecordValue = { [key: string]: Value };

/** A deliberately small literal parser. It never imports, transpiles, or evaluates provider code. */
export function parseTCGdexLiteral(
  source: string,
  filename = "card.ts",
): RecordValue {
  if (source.length > 2_000_000)
    throw new Error("Source record exceeds size limit");
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseErrors = (
    file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseErrors?.length)
    throw new Error(`Invalid TypeScript syntax: ${filename}`);
  // Follow only a local default-export binding, never imports or runtime code.
  const constants = new Map<string, ts.Expression>();
  let exported: ts.Expression | undefined;
  // The imported set object is metadata, not a card field to evaluate.
  const setImports = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const binding = statement.importClause?.name?.text;
      if (binding) setImports.add(binding);
    } else if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          throw new Error("Only named const literals are supported");
        constants.set(declaration.name.text, declaration.initializer);
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals)
      exported = statement.expression;
    else if (!ts.isEmptyStatement(statement))
      throw new Error(
        `Unsupported source statement: ${ts.SyntaxKind[statement.kind]}`,
      );
  }
  if (!exported) throw new Error("Source record has no default export");
  if (ts.isIdentifier(exported)) exported = constants.get(exported.text);
  if (!exported) throw new Error("Default export is not a local literal");
  /** Read supported syntax directly so provider code cannot run during import. */
  function read(node: ts.Expression, depth = 0): Value {
    if (depth > 32) throw new Error("Source nesting limit exceeded");
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return read(node.expression, depth + 1);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    )
      return -Number(node.operand.text);
    if (ts.isArrayLiteralExpression(node))
      return node.elements.map((element) =>
        read(element as ts.Expression, depth + 1),
      );
    if (ts.isObjectLiteralExpression(node)) {
      const result: RecordValue = Object.create(null);
      for (const property of node.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          ts.isComputedPropertyName(property.name)
        )
          throw new Error(
            "Spreads, methods, and computed keys are unsupported",
          );
        const key = property.name.text;
        if (
          ["__proto__", "prototype", "constructor"].includes(key) ||
          Object.hasOwn(result, key)
        )
          throw new Error(`Unsafe/duplicate property: ${key}`);
        if (
          key === "set" &&
          ts.isIdentifier(property.initializer) &&
          setImports.has(property.initializer.text)
        )
          continue;
        result[key] = read(property.initializer, depth + 1);
      }
      return result;
    }
    throw new Error(
      `Unsupported source expression: ${ts.SyntaxKind[node.kind]}`,
    );
  }
  const result = read(exported);
  if (!result || Array.isArray(result) || typeof result !== "object")
    throw new Error("Card export must be an object literal");
  return result;
}

/** Reviewed links between provider file numbers, fork IDs and printed numbers. */
export const crosswalkSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceRepository: z.literal("tcgdex/cards-database"),
    sourceCommit: commitSchema,
    sourceSetId: identifierSchema,
    sourceDirectory: z.string().min(1),
    setId: setIdentifierSchema,
    review: reviewSchema,
    cards: z
      .array(
        z
          .object({
            sourceNumber: identifierSchema,
            canonicalId: identifierSchema,
            canonicalNumber: z.string().min(1),
            variantOf: identifierSchema.optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Crosswalk = z.infer<typeof crosswalkSchema>;
export interface ImportIssue {
  cardId: string;
  field: string;
  kind: "missing" | "conflict" | "unsupported" | "review";
  message: string;
}
/** Keep accepted values, provider suggestions and the editable proposal separate. */
export interface DraftRecord {
  id: string;
  accepted: Record<string, unknown> | null;
  candidate: Record<string, unknown>;
  proposed: Record<string, unknown>;
  issues: ImportIssue[];
  evidence: { sourcePath: string; sha256: string; providerRecord: RecordValue };
}

/** Identity is supplied by a reviewed crosswalk, never inferred from a card name. */
export function validateCrosswalk(mapping: Crosswalk): void {
  if (
    !mapping.review.approved ||
    !mapping.review.reviewedBy?.trim() ||
    !mapping.review.reviewedAt ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      mapping.review.reviewedAt,
    ) ||
    Number.isNaN(Date.parse(mapping.review.reviewedAt))
  )
    throw new Error(
      "Identity mapping must have an explicit human review receipt with an ISO timestamp",
    );
  if (
    !/^[\p{L}\p{N} _&().'!/-]+$/u.test(mapping.sourceDirectory) ||
    mapping.sourceDirectory
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Source directory must be a safe repository-relative path");
  // A provider file maps once; variants must point back to a mapped primary.
  const sourceNumbers = new Set<string>();
  const primaries = new Map<string, string>();
  for (const entry of mapping.cards) {
    if (sourceNumbers.has(entry.sourceNumber))
      throw new Error(`Duplicate source mapping: ${entry.sourceNumber}`);
    sourceNumbers.add(entry.sourceNumber);
    // IDs are not derived from printed numbers: e.g. cel25c-15_A1 has number 15.
    if (!entry.canonicalId.startsWith(`${mapping.setId}-`))
      throw new Error(
        `Canonical ID is outside selected set: ${entry.canonicalId}`,
      );
    if (!entry.variantOf) {
      if (primaries.has(entry.canonicalId))
        throw new Error(`Duplicate canonical mapping: ${entry.canonicalId}`);
      primaries.set(entry.canonicalId, entry.canonicalNumber);
    }
  }
  for (const entry of mapping.cards)
    if (
      entry.variantOf &&
      (entry.variantOf !== entry.canonicalId ||
        primaries.get(entry.variantOf) !== entry.canonicalNumber)
    )
      throw new Error(
        `Variant must reference its mapped canonical primary, not create a new identity: ${entry.sourceNumber}`,
      );
}

/** Treat absent or non-object provider values as an empty optional object. */
function object(value: Value | undefined): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
/** Accept plain text or an English translation; never select another language. */
function english(value: Value | undefined): string | undefined {
  return typeof value === "string"
    ? value
    : typeof object(value).en === "string"
      ? (object(value).en as string)
      : undefined;
}
/** Treat non-array optional provider values as absent. */
function array(value: Value | undefined): Value[] {
  return Array.isArray(value) ? value : [];
}

/** Map known fields, preserve accepted data and report differences for review. */
export function convertTCGdexCard(
  raw: RecordValue,
  identity: { id: string; number: string },
  accepted: Record<string, unknown> | null = null,
): Omit<DraftRecord, "evidence"> {
  const issues: ImportIssue[] = [];
  /** Attach field-level problems without discarding the provider record. */
  const issue = (field: string, kind: ImportIssue["kind"], message: string) =>
    issues.push({ cardId: identity.id, field, kind, message });
  // Identity comes from the reviewed mapping, not provider names or numbering.
  const candidate: Record<string, unknown> = {
    id: identity.id,
    number: identity.number,
  };
  // Unknown fields remain in evidence and block silent loss through review issues.
  const handled = new Set([
    "name",
    "category",
    "illustrator",
    "hp",
    "types",
    "dexId",
    "rarity",
    "regulationMark",
    "weaknesses",
    "resistances",
    "evolveFrom",
    "description",
    "stage",
    "retreat",
    "attacks",
    "abilities",
    "variants",
    "suffix",
    "trainerType",
    "energyType",
    "level",
    "rules",
  ]);
  for (const field of Object.keys(raw))
    if (!handled.has(field))
      issue(
        `provider.${field}`,
        "unsupported",
        "Unhandled provider field retained in evidence; decide an explicit mapping or documented exclusion",
      );
  /** Flag unmapped nested fields while retaining them in the source evidence. */
  const nestedFields = (
    value: RecordValue,
    allowed: string[],
    path: string,
  ) => {
    for (const field of Object.keys(value))
      if (!allowed.includes(field))
        issue(
          `provider.${path}.${field}`,
          "unsupported",
          "Unhandled nested provider field retained in evidence",
        );
  };
  const name = english(raw.name);
  if (name) candidate.name = name;
  else issue("name", "missing", "English printed name is missing");
  const category = { Pokemon: "Pokémon", Trainer: "Trainer", Energy: "Energy" }[
    String(raw.category)
  ];
  if (category) candidate.supertype = category;
  else issue("supertype", "unsupported", "Unknown/missing source category");
  // These names target the fork's input shape; public normalization happens later.
  const fields = {
    illustrator: "artist",
    hp: "hp",
    types: "types",
    dexId: "nationalPokedexNumbers",
    rarity: "rarity",
    regulationMark: "regulationMark",
    weaknesses: "weaknesses",
    resistances: "resistances",
  };
  for (const [source, target] of Object.entries(fields))
    if (raw[source] !== undefined)
      candidate[target] = source === "hp" ? String(raw[source]) : raw[source];
  if (english(raw.evolveFrom)) candidate.evolvesFrom = english(raw.evolveFrom);
  if (english(raw.description)) candidate.flavorText = english(raw.description);
  if (raw.level !== undefined) candidate.level = String(raw.level);
  if (typeof raw.stage === "string") {
    const stage = {
      Basic: "Basic",
      Stage1: "Stage 1",
      Stage2: "Stage 2",
      VMAX: "VMAX",
      VSTAR: "VSTAR",
      MEGA: "MEGA",
      BREAK: "BREAK",
      LEGEND: "LEGEND",
      Restored: "Restored",
    }[raw.stage];
    if (stage) candidate.subtypes = [stage];
    else issue("subtypes", "unsupported", `Review source stage: ${raw.stage}`);
  }
  if (typeof raw.suffix === "string") {
    const suffixes: Record<string, string> = {
      ex: "ex",
      EX: "EX",
      GX: "GX",
      V: "V",
      VMAX: "VMAX",
      VSTAR: "VSTAR",
      "V-UNION": "V-UNION",
      BREAK: "BREAK",
      LEGEND: "LEGEND",
      "TAG TEAM": "TAG TEAM",
      "Prism Star": "Prism Star",
    };
    const suffix = suffixes[raw.suffix];
    if (!suffix)
      issue("subtypes", "unsupported", `Review source suffix: ${raw.suffix}`);
    else
      candidate.subtypes = [
        ...new Set([
          ...(Array.isArray(candidate.subtypes) ? candidate.subtypes : []),
          suffix,
        ]),
      ];
  }
  for (const field of ["trainerType", "energyType"])
    if (typeof raw[field] === "string") {
      const value = raw[field] as string;
      const subtype = (
        {
          Item: "Item",
          Supporter: "Supporter",
          Stadium: "Stadium",
          Tool: "Pokémon Tool",
          TechnicalMachine: "Technical Machine",
          Basic: "Basic",
          Special: "Special",
        } as Record<string, string>
      )[value];
      if (subtype)
        candidate.subtypes = [
          ...new Set([
            ...(Array.isArray(candidate.subtypes) ? candidate.subtypes : []),
            subtype,
          ]),
        ];
      else issue("subtypes", "unsupported", `Review source ${field}: ${value}`);
    }
  if (
    typeof raw.retreat === "number" &&
    Number.isInteger(raw.retreat) &&
    raw.retreat >= 0
  ) {
    candidate.convertedRetreatCost = raw.retreat;
    candidate.retreatCost = Array.from(
      { length: raw.retreat },
      () => "Colorless",
    );
  } else if (raw.retreat !== undefined)
    issue(
      "retreatCost",
      "unsupported",
      "Source retreat must be a nonnegative integer",
    );
  if (Array.isArray(raw.attacks))
    candidate.attacks = raw.attacks.map((item, index) => {
      const attack = object(item);
      nestedFields(
        attack,
        ["name", "cost", "damage", "effect"],
        `attacks.${index}`,
      );
      if (!english(attack.name))
        issue(
          `attacks.${index}.name`,
          "missing",
          "English attack name is missing",
        );
      return {
        name: english(attack.name) ?? "",
        cost: array(attack.cost),
        convertedEnergyCost: array(attack.cost).length,
        ...(attack.damage !== undefined
          ? { damage: String(attack.damage) }
          : {}),
        ...(english(attack.effect) !== undefined
          ? { text: english(attack.effect) }
          : {}),
      };
    });
  if (Array.isArray(raw.abilities))
    candidate.abilities = raw.abilities.map((item, index) => {
      const ability = object(item);
      nestedFields(ability, ["name", "effect", "type"], `abilities.${index}`);
      if (!english(ability.name) || !english(ability.effect))
        issue(
          `abilities.${index}`,
          "missing",
          "English ability name/text needs review",
        );
      return {
        name: english(ability.name) ?? "",
        type: ability.type ?? "Ability",
        ...(english(ability.effect) !== undefined
          ? { text: english(ability.effect) }
          : {}),
      };
    });
  for (const field of ["weaknesses", "resistances"])
    if (Array.isArray(raw[field]))
      raw[field].forEach((entry, index) => {
        nestedFields(object(entry), ["type", "value"], `${field}.${index}`);
      });
  if (Array.isArray(raw.rules))
    candidate.rules = raw.rules.map((rule, index) => {
      const translated = english(rule);
      if (!translated)
        issue(`rules.${index}`, "missing", "English rule text is missing");
      return translated ?? "";
    });
  issue(
    "rules",
    "review",
    "Provider rule-box coverage is not authoritative; inspect printed rule text and stage/evolution",
  );
  if (raw.variants !== undefined)
    issue(
      "variants",
      "review",
      "Provider finish/stamp variants are evidence, not new canonical card identities",
    );
  for (const field of ["artist", "rarity"])
    if (candidate[field] == null && accepted?.[field] == null)
      issue(
        field,
        "missing",
        "Printed information is absent; complete it or document reviewed inapplicability",
      );
  if (
    candidate.supertype === "Pokémon" &&
    candidate.hp == null &&
    accepted?.hp == null
  )
    issue("hp", "missing", "Printed HP needs review");
  // Fill missing accepted fields only; conflicting accepted values stay unchanged.
  const proposed = structuredClone(accepted ?? {});
  for (const [field, value] of Object.entries(candidate)) {
    if (proposed[field] === undefined || proposed[field] === null)
      proposed[field] = value;
    else if (JSON.stringify(proposed[field]) !== JSON.stringify(value))
      issue(
        field,
        "conflict",
        "Accepted fork value retained; candidate differs and requires explicit correction review",
      );
  }
  return { id: identity.id, accepted, candidate, proposed, issues };
}

/** Read pinned Git objects and fork data into a fresh draft directory; never edit either source. */
export async function importTCGdex(options: {
  sourceDir: string;
  crosswalk: unknown;
  canonicalDir: string;
  outputDir: string;
}): Promise<{ records: DraftRecord[]; issues: ImportIssue[] }> {
  const mapping = crosswalkSchema.parse(options.crosswalk);
  validateCrosswalk(mapping);
  const sourceRoot = resolve(options.sourceDir);
  await gitText(sourceRoot, [
    "cat-file",
    "-e",
    `${mapping.sourceCommit}^{commit}`,
  ]);
  const paths = (
    await gitText(sourceRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      mapping.sourceCommit,
      "--",
      mapping.sourceDirectory,
    ])
  )
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".ts"));
  const canonicalFile = Bun.file(
    within(options.canonicalDir, `cards/en/${mapping.setId}.json`),
  );
  const canonical = (await canonicalFile.exists())
    ? await canonicalFile.json()
    : [];
  if (!Array.isArray(canonical))
    throw new Error("Canonical cards must be an array");
  // Existing fork records remain the source of accepted identities and values.
  const accepted = new Map<string, Record<string, unknown>>();
  for (const card of canonical) {
    if (
      !card ||
      typeof card !== "object" ||
      typeof card.id !== "string" ||
      typeof card.number !== "string" ||
      accepted.has(card.id)
    )
      throw new Error("Canonical cards contain invalid/duplicate identities");
    accepted.set(card.id, card as Record<string, unknown>);
  }
  // Compare the whole provider directory with the crosswalk to expose omissions.
  const sourceNumbers = new Set<string>();
  const records: DraftRecord[] = [];
  for (const entry of mapping.cards) {
    const previous = accepted.get(entry.canonicalId);
    if (previous && previous.number !== entry.canonicalNumber)
      throw new Error(
        `Crosswalk would renumber accepted card ${entry.canonicalId}`,
      );
    sourceNumbers.add(entry.sourceNumber);
    const path = `${mapping.sourceDirectory}/${entry.sourceNumber}.ts`;
    if (!paths.includes(path))
      throw new Error(`Mapped source record missing at pinned commit: ${path}`);
    const source = await gitText(sourceRoot, [
      "show",
      `${mapping.sourceCommit}:${path}`,
    ]);
    const providerRecord = parseTCGdexLiteral(source, path);
    const converted = convertTCGdexCard(
      providerRecord,
      { id: entry.canonicalId, number: entry.canonicalNumber },
      previous ?? null,
    );
    // Keep variant evidence in the batch without adding another primary record.
    if (entry.variantOf)
      converted.issues.push({
        cardId: entry.canonicalId,
        field: "variants",
        kind: "review",
        message: `Source variant of ${entry.variantOf}; do not publish as a separate primary identity`,
      });
    records.push({
      ...converted,
      evidence: { sourcePath: path, sha256: sha256(source), providerRecord },
    });
  }
  const issues = records.flatMap((record) => record.issues);
  for (const path of paths) {
    const filename = path.slice(mapping.sourceDirectory.length + 1);
    if (
      /^[A-Za-z0-9._-]+\.ts$/.test(filename) &&
      !filename.startsWith("_") &&
      !sourceNumbers.has(filename.slice(0, -3))
    )
      issues.push({
        cardId: "",
        field: "mapping",
        kind: "review",
        message: `Unmapped source file: ${path}`,
      });
  }
  await mkdir(dirname(resolve(options.outputDir)), { recursive: true });
  await mkdir(options.outputDir, { recursive: false });
  await writeJson(resolve(options.outputDir, "crosswalk.json"), mapping);
  await writeJson(resolve(options.outputDir, "batch.json"), {
    schemaVersion: 1,
    status: "draft",
    source: {
      repository: mapping.sourceRepository,
      commit: mapping.sourceCommit,
    },
    setId: mapping.setId,
    records,
    issues,
  });
  await writeJson(
    resolve(options.outputDir, "proposed-cards.json"),
    records
      .filter((_record, index) => !mapping.cards[index]?.variantOf)
      .map((record) => record.proposed),
  );
  return { records, issues };
}
