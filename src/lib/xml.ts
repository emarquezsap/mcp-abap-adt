import { xml2js } from "xml-js";

/**
 * Small XML helpers on top of xml-js. Namespace prefixes are removed from
 * element and attribute names so callers can work with plain names
 * (e.g. "dataPreview:columns" -> "columns", "adtcore:name" -> "name").
 */

export type XmlNode = Record<string, any>;

const stripPrefix = (name: string) => {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
};

export function parseXml(xml: string): XmlNode {
  return xml2js(xml, {
    compact: true,
    trim: false,
    nativeType: false,
    alwaysChildren: false,
    elementNameFn: stripPrefix,
    attributeNameFn: stripPrefix,
  }) as XmlNode;
}

export function asArray<T = any>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function attrs(node: any): Record<string, string> {
  return (node && node._attributes) || {};
}

export function text(node: any): string {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(text).join("");
  if (node._text !== undefined) return asArray(node._text).join("");
  if (node._cdata !== undefined) return asArray(node._cdata).join("");
  return "";
}

/** Follow a path of element names, returning undefined when missing. */
export function child(node: any, ...path: string[]): any {
  let current = node;
  for (const name of path) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) current = current[0];
    current = current[name];
  }
  return current;
}

/**
 * Convert an xml-js compact node into a plain, compact JS value:
 * attributes become properties, text-only nodes become strings and
 * repeated elements stay arrays. Useful to return generic ADT payloads
 * (traces, ATC) without their XML noise.
 */
export function simplify(node: any): any {
  if (node === undefined || node === null) return undefined;
  if (Array.isArray(node)) return node.map(simplify);
  if (typeof node !== "object") return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs(node))) out[k] = v;
  let childCount = 0;
  for (const [k, v] of Object.entries(node)) {
    if (k === "_attributes" || k === "_declaration" || k === "_instruction")
      continue;
    if (k === "_text" || k === "_cdata") continue;
    childCount++;
    // xmlns declarations are attributes; links are mostly navigation noise
    out[k] = simplify(v);
  }
  const t = text(node).trim();
  if (t) {
    if (childCount === 0 && Object.keys(out).length === 0) return t;
    out.value = t;
  }
  for (const k of Object.keys(out)) {
    if (k === "xmlns" || k.startsWith("xmlns")) delete out[k];
  }
  return out;
}

/** Decode the few HTML/XML entities SAP uses and strip tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h\d|tr|li|pre|table)\s*>/gi, "\n")
    .replace(/<\s*\/\s*t[dh]\s*>/gi, "\t")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Serialize an object as JSON with each array item on its own line, so line paging stays useful. */
export function jsonLines(header: Record<string, any>, listKey: string, items: any[]): string {
  const head = JSON.stringify({ ...header, [listKey]: "__LIST__" });
  const body = items.length
    ? "[\n" + items.map((i) => JSON.stringify(i)).join(",\n") + "\n]"
    : "[]";
  return head.replace('"__LIST__"', body);
}
