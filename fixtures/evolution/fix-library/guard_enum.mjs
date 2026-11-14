// Blocks an enum that loses a value, at any depth.
export const id = 'guard_enum';
function walk(b, a, path, out) {
  for (const k of Object.keys(b?.properties ?? {})) {
    const x = b.properties[k];
    const y = a?.properties?.[k];
    if (!y) continue;
    const removed = (x.enum ?? []).filter((v) => !(y.enum ?? []).includes(v));
    if (removed.length) out.push({ step: id, class: 'enum_value_removed', field: path + k, severity: 'blocking', message: `"${path + k}" no longer allows ${removed.join(', ')}.` });
    if (x.properties) walk(x, y, path + k + '.', out);
  }
}
export function check(c) {
  const out = [];
  walk(c.contract_before, c.contract_after, '', out);
  return out;
}
