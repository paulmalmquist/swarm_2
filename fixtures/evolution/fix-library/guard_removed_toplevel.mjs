// Blocks a top-level field that disappears (removed or renamed).
export const id = 'guard_removed_toplevel';
export function check(c) {
  const b = c.contract_before?.properties ?? {};
  const a = c.contract_after?.properties ?? {};
  return Object.keys(b).filter((k) => !(k in a)).map((k) => ({ step: id, class: 'field_removed_or_renamed', field: k, severity: 'blocking', message: `"${k}" is no longer in the contract.` }));
}
