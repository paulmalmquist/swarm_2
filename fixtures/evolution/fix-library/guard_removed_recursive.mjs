// Blocks a field that disappears at any depth.
export const id = 'guard_removed_recursive';
function walk(b, a, path, out) {
  for (const k of Object.keys(b?.properties ?? {})) {
    if (!(k in (a?.properties ?? {}))) out.push({ step: id, class: 'field_removed_or_renamed', field: path + k, severity: 'blocking', message: `"${path + k}" is no longer in the contract.` });
    else if (b.properties[k].properties) walk(b.properties[k], a.properties[k], path + k + '.', out);
  }
}
export function check(c) {
  const out = [];
  walk(c.contract_before, c.contract_after, '', out);
  return out;
}
