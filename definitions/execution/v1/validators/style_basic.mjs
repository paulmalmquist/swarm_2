// Step `style_basic`: advisory naming check. Never blocking.
export const id = 'style_basic';

export function check(c) {
  const findings = [];
  for (const name of Object.keys(c.contract_after?.properties ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) {
      findings.push({ step: id, class: 'style', field: name, severity: 'advisory', message: `Field "${name}" is not snake_case.` });
    }
  }
  return findings;
}
