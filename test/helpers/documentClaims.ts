import { Lexer, type MarkedToken, type Token } from "marked";
import ts from "typescript-compiler-api";

export type ClaimUnit = {
  file: string;
  line: number;
  text: string;
  introduction?: string;
  forbiddenExample?: boolean;
};

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
// A new finite predicate or contrasting clause does not inherit an earlier
// predicate's negation. Coordinated noun objects stay together.
const auxiliaries = "is|are|was|were|can|could|will|would|must|should|does|do";
const finiteVerbs = "provides|supports|enables|offers|grants|establishes|proves|guarantees|computes|returns|creates|claims|produces|includes|accepts|permits|allows|rejects|excludes|marks|describes|classifies|labels|treats|identifies";
const denial = String.raw`(?:(?:not|never)\b(?!\s+(?:only|merely|just)\b)|unsupported\b|unavailable\b|out of scope\b|excluded\b)`;
const deniedComplement = String.raw`(?:(?:marked|described|classified|labelled|labeled|treated|identified)\s+as\s+)?${denial}`;
const copularDenial = new RegExp(String.raw`\b(?:is|are|remain(?:s)?|stay(?:s)?)\s+${deniedComplement}`, "i");
const newPredicate = new RegExp(String.raw`\b(?:${auxiliaries})\b|\b(?:${finiteVerbs})\b(?=\s+(?!(?:and|or|is|are)\b)\w)`, "i");
const clauseBoundary = new RegExp([
  String.raw`;|\b(?:but|however|whereas|while|yet)\b`,
  String.raw`(?:,\s+|\s+\b(?:and|or)\b\s+)(?=[^,;.!?]*\b(?:is|are)\s+(?!${deniedComplement}))`,
  String.raw`,?\s+\b(?:and|or)\b\s+(?=(?:(?:it|they|we|this (?:tool|server|product)|the (?:tool|server|product))\s+)?(?:${auxiliaries}|${finiteVerbs})\b)`
].join("|"), "i");
const negative = /\bnot\b(?!\s+(?:only|merely|just)\b)|\b(?:cannot|never|no|unsupported|unavailable|forbidden)\b|out of scope/gi;
const sourceExclusion = new RegExp(`${negative.source}|\\brejects?\\b|\\bexcluded\\b`, "gi");

function clauses(text: string): string[] {
  return [...sentences.segment(normalize(text))].flatMap(({ segment }) => segment.split(clauseBoundary))
    .map(normalize).filter(Boolean);
}

function inlineText(tokens: Token[]): string {
  return tokens.map((token) => {
    if (token.type === "br") return " ";
    if ("tokens" in token && token.tokens) return inlineText(token.tokens);
    return "text" in token && typeof token.text === "string" ? token.text : token.raw;
  }).join("");
}

function ownsList(text: string): boolean {
  return /\b(?:not|never|cannot)\s+(?:imply|establish|provide|support|include|claim|say|infer|offer|create|produce|enable)(?:\s+(?:(?:any of )?the following|these claims|these conclusions))?\s*:\s*$/i.test(text) ||
    /^(?:the following\s+)?(?:unsupported|forbidden|out of scope)\b[^.!?]*:\s*$/i.test(text);
}

function introducesForbiddenExample(text: string): boolean {
  return /^(?:forbidden|unsupported)\s+(?:claims?|examples?)\s*:\s*$/i.test(text) ||
    /^do not (?:claim|say|write)\s*:\s*$/i.test(text);
}

/** Logical assertion units, with the line of the owning source block.
 * This is a bounded regression guard, not a general natural-language verifier.
 */
export function claimUnits(source: string, file: string): ClaimUnit[] {
  const units: ClaimUnit[] = [];
  const emit = (text: string, offset: number, introduction?: string, forbiddenExample = false) => {
    for (const clause of clauses(text)) units.push({ file, line: source.slice(0, offset).split("\n").length,
      text: clause, ...(introduction ? { introduction } : {}), ...(forbiddenExample ? { forbiddenExample: true } : {}) });
  };
  if (/\.[cm]?tsx?$/.test(file)) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && !ts.isLiteralTypeNode(node.parent)) {
        emit(node.text, node.getStart(tree));
        return;
      }
      if (ts.isTemplateExpression(node)) {
        // Preserve the outer literal's boundaries without evaluating code or
        // inventing the value of an interpolated expression.
        emit(node.head.text + node.templateSpans.map((span) => ` \uFFFC ${span.literal.text}`).join(""), node.getStart(tree));
        for (const span of node.templateSpans) visit(span.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    return units;
  }
  const walk = (tokens: Token[], start: number, inherited?: string, example = false): void => {
    let cursor = start;
    let previous = "";
    for (const entry of tokens) {
      const token = entry as MarkedToken;
      const found = source.indexOf(token.raw, cursor);
      const offset = found < 0 ? start : found;
      if (found >= 0) cursor = found + token.raw.length;
      if (token.type === "space") continue;
      if (token.type === "list") {
        const intro = ownsList(previous) ? previous : undefined;
        const quoted = introducesForbiddenExample(previous);
        for (const item of token.items) walk(item.tokens, offset, intro, quoted);
      } else if (token.type === "blockquote") {
        walk(token.tokens, offset);
      } else if (token.type === "table") {
        for (const cell of [token.header, ...token.rows].flat()) emit(inlineText(cell.tokens), offset);
      } else if (token.type === "code") {
        emit(token.text, offset, undefined, introducesForbiddenExample(previous));
      } else if (token.type === "paragraph" || token.type === "text" || token.type === "heading") {
        const text = "tokens" in token && token.tokens ? inlineText(token.tokens) : token.text;
        emit(text, offset, token.type === "heading" ? undefined : inherited, example);
        previous = clauses(text).at(-1) ?? "";
        continue;
      } else if (token.type === "html") {
        // Opaque HTML is inspected conservatively, not silently excluded.
        emit(token.text, offset);
      }
      previous = "";
    }
  };
  walk(Lexer.lex(source), 0);
  return units;
}

function matches(pattern: RegExp, text: string): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g"))];
}

function objectPrefix(text: string, coordinatedVerbs = false): boolean {
  const boundary = [...text.matchAll(/,|\b(?:and|or|nor)\b/gi)].at(-1);
  const prefix = normalize(boundary ? text.slice(boundary.index! + boundary[0].length) : text);
  if (/^(?:(?:a|an|the|any)(?:\s+|$))*$/i.test(prefix)) return true;
  // Coordinated objects must be noun fragments matching the requested term,
  // not an unrecognized new verb that happens to follow an earlier "not".
  if (boundary && !coordinatedVerbs) return false;
  return /^(?:add|build|calculate|call|choose|claim|compute|create|derive|enable|establish|estimate|evaluate|execute|generate|give|grant|hold|identify|imply|indicate|infer|interpret|make|mean|offer|perform|present|produce|promise|prove|provide|rank|record|return|run|show|sign|start|store|support|treat|turn|use)\b/i.test(prefix) ||
    /^be\s+(?:used|treated|interpreted|presented|considered)\b/i.test(prefix);
}

function subjectContinuation(text: string): boolean {
  // A second subject or predicate cannot be hidden between the guarded term
  // and a later copular denial. A plural suffix and closing punctuation do not
  // change the subject; further subjects must be coordinated explicitly.
  return /^s?[\s)\]"']*$/.test(text.split(/,|\b(?:and|or|nor)\b/i)[0] ?? "");
}

function denied(text: string, term: RegExpMatchArray, negators: RegExp): boolean {
  if (/\bnot\s+(?:not|unsupported|unavailable|out of scope)\b/i.test(text)) return false;
  const index = term.index!;
  const before = text.slice(0, index);
  const negation = matches(negators, before).at(-1);
  if (negation) {
    const object = before.slice(negation.index! + negation[0].length);
    const coordinatedVerbs = /\b(?:do|does|must|should|will|would|could)\s*$/i.test(before.slice(0, negation.index)) ||
      /^(?:cannot|never)$/i.test(negation[0]);
    if (objectPrefix(object, coordinatedVerbs) && !newPredicate.test(object + term[0])) return true;
  }
  const after = text.slice(index + term[0].length);
  // A shared subject list can precede a copular denial. A positive predicate
  // before that denial belongs to another claim and cannot be excused by it.
  const predicate = copularDenial.exec(after);
  if (predicate && subjectContinuation(after.slice(0, predicate.index)) && !newPredicate.test(after.slice(0, predicate.index))) return true;
  // An object list can receive its exclusion from its classification: "marks
  // X and Y as unavailable". Neither an earlier classification nor a later
  // unrelated predicate may supply that exclusion.
  const classification = matches(/\b(?:marks?|describes?|classif(?:y|ies)|labels?|treats?|identif(?:y|ies))\b/i, before).at(-1);
  const classifiedAs = /\bas\s+(?:not\b(?!\s+(?:only|merely|just)\b)|unsupported\b|unavailable\b|out of scope\b)/i.exec(after);
  if (classification && classifiedAs &&
      objectPrefix(before.slice(classification.index! + classification[0].length)) &&
      subjectContinuation(after.slice(0, classifiedAs.index)) &&
      !newPredicate.test(before.slice(classification.index! + classification[0].length) + term[0]) &&
      !newPredicate.test(after.slice(0, classifiedAs.index))) return true;
  return /^\s*:\s*(?:not\b(?!\s+(?:only|merely|just)\b)|unsupported\b|unavailable\b|out of scope\b)/i.test(after);
}

export function unnegatedClaims(source: string, file: string, terms: RegExp): ClaimUnit[] {
  return claimUnits(source, file).filter((unit) => {
    if (unit.forbiddenExample) return false;
    return matches(terms, unit.text).some((term) => {
      if (denied(unit.text, term, negative)) return false;
      // Only an object fragment inherits a list predicate. A fresh assertion
      // inside a list must carry its own denial.
      if (unit.introduction && !newPredicate.test(unit.text)) {
        const combined = `${unit.introduction.replace(/:\s*$/, "")} ${unit.text}`;
        return matches(terms, combined).some((match) => !denied(combined, match, negative));
      }
      return true;
    });
  });
}

export function unsupportedJsonRpcClaims(source: string, file: string): ClaimUnit[] {
  // The source subject includes its client/endpoint noun, when present. An
  // exclusion of another subject elsewhere in the sentence is not sufficient.
  const sourceSubject = /(?:Sui\s+)?JSON-RPC(?:\s+(?:client|endpoint)\b)?(?:\s+(?:imports?|configuration|config|endpoints?|transport|messages?))?/i;
  return claimUnits(source, file).filter((unit) => !unit.forbiddenExample && matches(sourceSubject, unit.text).some((term) => {
    const before = unit.text.slice(0, term.index);
    if (/\bMCP\s+$/i.test(before)) return false;
    if (/\bstdout\b/i.test(unit.text) && !/\bSui\b/i.test(unit.text)) return false;
    return !denied(unit.text, term, sourceExclusion);
  }));
}
