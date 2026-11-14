// Blocks a newly required field that existing producers do not send.
export const id = 'guard_required';
export function check(c) {
  const before = new Set(c.contract_before?.required ?? []);
  const had = c.contract_before?.properties ?? {};
  return (c.contract_after?.required ?? []).filter((k) => !before.has(k) && !(k in had)).map((k) => ({ step: id, class: 'required_added', field: k, severity: 'blocking', message: `"${k}" is newly required.` }));
}
