/** Browser expression preserving the script completion value and enforcing the JSON result contract. */
export function extractionExpression(script: string, source?: string): string {
  return `(() => {
  const doc = ${source === undefined ? 'document' : `new DOMParser().parseFromString(${JSON.stringify(source)}, 'text/html')`};
  // Direct eval preserves the script completion value; document is the live page or an inert capture.
  const run = new Function('document', 'scriptSource', 'return eval(scriptSource)');
  const data = run(doc, ${JSON.stringify(script)});
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.then === 'function'
      || ![Object.prototype, null].includes(Object.getPrototypeOf(data))) {
    throw new Error('Executing extra.js must directly return a synchronous JSON object');
  }
  return JSON.stringify(data, (_key, value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) || Array.isArray(value)
      || (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)))) return value;
    throw new Error('extra.js result must contain only JSON values');
  });
})()`;
}
