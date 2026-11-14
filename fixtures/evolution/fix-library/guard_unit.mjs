// Blocks a field whose declared unit changes.
export const id = 'guard_unit';
export function check(c) {
  const b = c.contract_before?.properties ?? {};
  const a = c.contract_after?.properties ?? {};
  return Object.keys(b).filter((k) => k in a && b[k]['x-unit'] !== undefined && a[k]['x-unit'] !== undefined && b[k]['x-unit'] !== a[k]['x-unit']).map((k) => ({ step: id, class: 'unit_changed', field: k, severity: 'blocking', message: `"${k}" changed unit from ${b[k]['x-unit']} to ${a[k]['x-unit']}.` }));
}
