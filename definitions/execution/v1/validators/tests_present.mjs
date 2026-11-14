// Step `tests_present`: a change to source or contract must come with a test change.
export const id = 'tests_present';

export function check(c) {
  const kinds = new Set((c.files_changed ?? []).map((f) => f.kind));
  if ((kinds.has('source') || kinds.has('contract')) && !kinds.has('test')) {
    return [{ step: id, class: 'missing_tests', field: null, severity: 'blocking', message: 'The change modifies source or contract files but no test file.' }];
  }
  return [];
}
