// Step `interface_compat` — first attempt: compare top-level fields before and after.
export const id = 'interface_compat';

export function check(c) {
  const before = c.contract_before?.properties ?? {};
  const after = c.contract_after?.properties ?? {};
  const findings = [];
  for (const name of Object.keys(before)) {
    if (!(name in after)) findings.push({ step: id, class: 'field_removed_or_renamed', field: name, severity: 'blocking', message: `Field "${name}" is no longer in the contract.` });
    else if (JSON.stringify(before[name].type) !== JSON.stringify(after[name].type)) findings.push({ step: id, class: 'type_changed', field: name, severity: 'blocking', message: `Field "${name}" changed type.` });
  }
  for (const name of Object.keys(after)) {
    if (!(name in before)) findings.push({ step: id, class: 'field_added', field: name, severity: 'blocking', message: `Field "${name}" was added.` });
  }
  return findings;
}
