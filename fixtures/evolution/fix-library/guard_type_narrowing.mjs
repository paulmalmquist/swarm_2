// Blocks a field whose type no longer accepts something it used to accept.
export const id = 'guard_type_narrowing';
const types = (s) => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
export function check(c) {
  const b = c.contract_before?.properties ?? {};
  const a = c.contract_after?.properties ?? {};
  const out = [];
  for (const k of Object.keys(b)) {
    if (!(k in a)) continue;
    const lost = types(b[k]).filter((t) => !types(a[k]).includes(t));
    if (lost.length) out.push({ step: id, class: 'type_changed', field: k, severity: 'blocking', message: `"${k}" no longer accepts ${lost.join(', ')}.` });
  }
  return out;
}
