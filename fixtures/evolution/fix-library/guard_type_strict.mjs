// Blocks any difference in a field's type. (Flaw: widening a type, such as allowing null, is safe.)
export const id = 'guard_type_strict';
export function check(c) {
  const b = c.contract_before?.properties ?? {};
  const a = c.contract_after?.properties ?? {};
  return Object.keys(b).filter((k) => k in a && JSON.stringify(b[k].type) !== JSON.stringify(a[k].type)).map((k) => ({ step: id, class: 'type_changed', field: k, severity: 'blocking', message: `"${k}" changed type.` }));
}
