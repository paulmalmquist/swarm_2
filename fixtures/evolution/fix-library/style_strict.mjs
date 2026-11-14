// Blocks any field whose name is not snake_case. (Addresses a frequent complaint, not a defect.)
export const id = 'style_strict';
export function check(c) {
  return Object.keys(c.contract_after?.properties ?? {}).filter((k) => !/^[a-z][a-z0-9_]*$/.test(k)).map((k) => ({ step: id, class: 'style', field: k, severity: 'blocking', message: `"${k}" is not snake_case.` }));
}
