/** Lossless structural companion to source.html; it contains data, never reconstruction code. */
import { sha256Hex } from './protocol.ts';

export const DOM_LIMITS = { bytes: 16 * 1024 * 1024, nodes: 200_000, depth: 512 } as const;
export type DomNamespace = number | string | null;
export type DomNode = [3 | 8, string] | [1, DomNamespace, string, [DomNamespace, string, string][], DomNode[], DomNode[]?];
export interface DomSnapshot { version: 1; sourceSha256: string; root: DomNode }

/** Validates the entire tree before browser reconstruction, including size and traversal budgets. */
export function parseDomSnapshot(json: string): DomSnapshot {
  if (new TextEncoder().encode(json).length > DOM_LIMITS.bytes) throw new Error('DOM snapshot exceeds 16 MiB');
  const value = JSON.parse(json) as DomSnapshot;
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.sourceSha256 ?? '') || !Array.isArray(value.root) || value.root[0] !== 1) throw new Error('Invalid DOM snapshot header');
  const namespace = (ns: unknown) => ns === null || ns === 0 || ns === 1 || ns === 2 || (typeof ns === 'string' && ns.length > 0 && ns.length <= 1024);
  const name = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 1024 && !/[\s<>"'=]/u.test(s);
  const pending: [unknown, number][] = [[value.root, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (++count > DOM_LIMITS.nodes || depth > DOM_LIMITS.depth) throw new Error('DOM snapshot exceeds node/depth budget');
    if (!Array.isArray(node)) throw new Error('Invalid DOM node');
    if ((node[0] === 3 || node[0] === 8) && node.length === 2 && typeof node[1] === 'string') continue;
    if (node[0] !== 1 || (node.length !== 5 && node.length !== 6) || !namespace(node[1]) || !name(node[2]) || !Array.isArray(node[3]) || !Array.isArray(node[4])) throw new Error('Invalid DOM element');
    const attributes = new Set<string>();
    for (const attr of node[3]) {
      if (!Array.isArray(attr) || attr.length !== 3 || !namespace(attr[0]) || !name(attr[1]) || typeof attr[2] !== 'string') throw new Error('Invalid DOM attribute');
      const key = JSON.stringify([attr[0], attr[1]]);
      if (attributes.has(key)) throw new Error('Duplicate DOM attribute');
      attributes.add(key);
    }
    for (const child of node[4]) pending.push([child, depth + 1]);
    if (node.length === 6) {
      if (node[1] !== 0 || node[2] !== 'template' || !Array.isArray(node[5])) throw new Error('Invalid template content');
      for (const child of node[5]) pending.push([child, depth + 1]);
    }
  }
  if (value.root[1] !== 0 || value.root[2] !== 'html') throw new Error('DOM snapshot root must be HTML html');
  return value;
}

export async function validateDomSnapshot(source: string, json: string): Promise<DomSnapshot> {
  if (new TextEncoder().encode(source).length > DOM_LIMITS.bytes) throw new Error('source.html exceeds 16 MiB');
  const snapshot = parseDomSnapshot(json);
  if (snapshot.sourceSha256 !== await sha256Hex(new TextEncoder().encode(source))) throw new Error('DOM snapshot does not match source.html');
  return snapshot;
}

export async function serializeDomSnapshot(source: string, root: DomNode): Promise<string> {
  const json = JSON.stringify({ version: 1, sourceSha256: await sha256Hex(new TextEncoder().encode(source)), root });
  parseDomSnapshot(json);
  return json;
}

/** Trusted source evaluated in Chromium by capture and preview; no page-owned code is executed. */
export const DOM_CODEC = `
const namespaces = ['http://www.w3.org/1999/xhtml','http://www.w3.org/2000/svg','http://www.w3.org/1998/Math/MathML'];
const namespaceCode = ns => namespaces.includes(ns) ? namespaces.indexOf(ns) : ns;
// Custom elements can shadow native getters, including relative-time.prefix on GitHub.
const domRead = {};
for (const [prototype, names] of [
  [Node.prototype, ['nodeType','childNodes','parentNode','parentElement']],
  [Element.prototype, ['namespaceURI','prefix','localName','attributes','previousElementSibling']],
  [CharacterData.prototype, ['data']],
  [HTMLTemplateElement.prototype, ['content']],
]) for (const name of names) domRead[name] = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(prototype, name).get);
const attrRead = {};
for (const name of ['namespaceURI','name','value']) attrRead[name] = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(Attr.prototype, name).get);
function encodeDom(root) {
  let count = 0;
  function visit(node, depth) {
    if (++count > ${DOM_LIMITS.nodes} || depth > ${DOM_LIMITS.depth}) throw new Error('DOM snapshot exceeds node/depth budget');
    const type = domRead.nodeType(node);
    if (type === 3 || type === 8) return [type, domRead.data(node)];
    if (type !== 1) throw new Error('Unsupported DOM node type: ' + type);
    const ns = domRead.namespaceURI(node), prefix = domRead.prefix(node), name = domRead.localName(node);
    const result = [1, namespaceCode(ns), prefix ? prefix + ':' + name : name,
      [...domRead.attributes(node)].map(a => [namespaceCode(attrRead.namespaceURI(a)), attrRead.name(a), attrRead.value(a)]),
      [...domRead.childNodes(node)].map(child => visit(child, depth + 1))];
    if (ns === namespaces[0] && name === 'template') result.push([...domRead.childNodes(domRead.content(node))].map(child => visit(child, depth + 1)));
    return result;
  }
  return visit(root, 0);
}
function decodeDom(tree) {
  const doc = document.implementation.createHTMLDocument('');
  const namespace = ns => typeof ns === 'number' ? namespaces[ns] : ns;
  function visit(node) {
    if (node[0] === 3) return doc.createTextNode(node[1]);
    if (node[0] === 8) return doc.createComment(node[1]);
    const el = doc.createElementNS(namespace(node[1]), node[2]);
    for (const [ns, name, value] of node[3]) {
      if (ns === null) el.setAttribute(name, value); else el.setAttributeNS(namespace(ns), name, value);
    }
    for (const child of node[4]) el.appendChild(visit(child));
    if (node.length === 6) for (const child of node[5]) el.content.appendChild(visit(child));
    return el;
  }
  doc.replaceChild(visit(tree), doc.documentElement);
  if (JSON.stringify(encodeDom(doc.documentElement)) !== JSON.stringify(tree)) throw new Error('DOM reconstruction changed the captured structure');
  return doc;
}`;
