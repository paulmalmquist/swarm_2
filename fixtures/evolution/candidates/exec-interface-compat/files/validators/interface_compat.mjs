// Step `interface_compat` — recursive comparison that separates breaking from safe differences.
export const id = 'interface_compat';

const types = (s) => (s?.type === undefined ? [] : Array.isArray(s.type) ? [...s.type] : [s.type]).sort();

function walk(before, after, path, findings) {
  const b = before?.properties ?? {};
  const a = after?.properties ?? {};
  const requiredBefore = new Set(before?.required ?? []);
  for (const name of after?.required ?? []) {
    if (!requiredBefore.has(name) && !(name in b)) findings.push({ step: id, class: 'required_added', field: path + name, severity: 'blocking', message: `"${path + name}" is newly required; existing producers do not send it.` });
  }
  for (const name of Object.keys(b)) {
    const p = path + name;
    if (!(name in a)) {
      findings.push({ step: id, class: 'field_removed_or_renamed', field: p, severity: 'blocking', message: `"${p}" is no longer in the contract; consumers that read it will break.` });
      continue;
    }
    const tb = types(b[name]);
    const ta = types(a[name]);
    // Narrowing breaks consumers or producers; widening (for example allowing null) does not.
    if (tb.some((t) => !ta.includes(t))) findings.push({ step: id, class: 'type_changed', field: p, severity: 'blocking', message: `"${p}" no longer accepts ${tb.filter((t) => !ta.includes(t)).join(', ')}.` });
    const removed = (b[name].enum ?? []).filter((v) => !(a[name].enum ?? []).includes(v));
    if (removed.length) findings.push({ step: id, class: 'enum_value_removed', field: p, severity: 'blocking', message: `"${p}" no longer allows ${removed.join(', ')}.` });
    if (b[name]['x-unit'] !== a[name]['x-unit']) findings.push({ step: id, class: 'unit_changed', field: p, severity: 'blocking', message: `"${p}" changed unit from ${b[name]['x-unit']} to ${a[name]['x-unit']}.` });
    if (b[name].properties || a[name].properties) walk(b[name], a[name], p + '.', findings);
  }
}

export function check(c) {
  const findings = [];
  walk(c.contract_before, c.contract_after, '', findings);
  return findings;
}
