// Step `interface_compat`: compare contract_before and contract_after structurally and block
// changes that can break an existing consumer or invalidate records that were valid before.
//
// Blocking (consumer-visible breakage):
//   - a property removed or renamed (reported under the OLD path)
//   - a property's type set lost a type it allowed before (swapped or narrowed)
//   - a field made required (new required field, or optional -> required)
//   - an enum value removed, or an enum/const restriction added/changed
//   - a unit (x-unit) or format changed from one value to another
//   - a value constraint tightened (min/max, length, pattern, additionalProperties: false, ...)
//   - a oneOf/anyOf alternative dropped or changed; allOf/not/$ref changed
// Advisory only (every previously valid record stays valid): enum values added, type widened
// (added type, integer -> number, made nullable), required field made optional, explicit type
// added that existing enum values already satisfy, format/unit annotation added or dropped,
// oneOf/anyOf alternatives added, constraints loosened, defaults changed.
// Ignored: description/title/examples/comments and key order.
export const id = 'interface_compat';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeSet(s) {
  if (!isObj(s)) return null;
  let t = s.type;
  if (t === undefined) {
    if (isObj(s.properties)) t = 'object';
    else if (s.items !== undefined) t = 'array';
    else return null;
  }
  const set = new Set(Array.isArray(t) ? t : [t]);
  if (s.nullable === true) set.add('null');
  return set;
}

const covers = (set, t) => set.has(t) || (t === 'integer' && set.has('number'));
const valueType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v);

const setKey =(set) => (set ? [...set].sort().join('|') : '');

function stableKey(v) {
  if (Array.isArray(v)) return '[' + v.map(stableKey).join(',') + ']';
  if (isObj(v)) {
    const skip = new Set(['description', 'title', 'examples', 'example', '$comment', 'x-doc', 'x-description']);
    return '{' + Object.keys(v).filter((k) => !skip.has(k)).sort().map((k) => JSON.stringify(k) + ':' + stableKey(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

const join = (base, name) => (base ? base + '.' + name : name);

function compare(before, after, path, out) {
  const block = (cls, field, message) => out.push({ step: id, class: cls, field, severity: 'blocking', message });
  const advise = (cls, field, message) => out.push({ step: id, class: cls, field, severity: 'advisory', message });
  const label = path || '(root)';
  if (!isObj(before) || !isObj(after)) return;

  // Type
  const tb = typeSet(before), ta = typeSet(after);
  if (tb && ta && setKey(tb) !== setKey(ta)) {
    // Only a type that was allowed before and is no longer allowed breaks anything (swap or narrowing).
    // Pure widening (adding a type, integer -> number) keeps every old value valid: advisory.
    const lost = [...tb].filter((t) => !covers(ta, t));
    if (lost.length) block('type_changed', path || null, `Type of "${label}" changed from ${setKey(tb)} to ${setKey(ta)}.`);
    else advise('type_widened', path || null, `Type of "${label}" widened from ${setKey(tb)} to ${setKey(ta)}.`);
  } else if (!tb && ta && path) {
    // Adding an explicit type that every existing enum/const value already satisfies is a no-op.
    const vals = Array.isArray(before.enum) ? before.enum : ('const' in before ? [before.const] : null);
    if (vals && vals.length && vals.every((v) => covers(ta, valueType(v)))) {
      advise('type_made_explicit', path, `"${label}" now states its type explicitly (${setKey(ta)}).`);
    } else {
      block('type_changed', path, `"${label}" gained a type restriction (${setKey(ta)}).`);
    }
  }

  // Enum
  if (Array.isArray(before.enum) || Array.isArray(after.enum)) {
    if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
      const a = new Set(after.enum.map(stableKey));
      const b = new Set(before.enum.map(stableKey));
      const removed = before.enum.filter((v) => !a.has(stableKey(v)));
      const added = after.enum.filter((v) => !b.has(stableKey(v)));
      if (removed.length) block('enum_value_removed', path || null, `"${label}" no longer allows ${removed.map((v) => JSON.stringify(v)).join(', ')}.`);
      if (added.length) advise('enum_value_added', path || null, `"${label}" now allows ${added.map((v) => JSON.stringify(v)).join(', ')}; exhaustive consumers should be checked.`);
    } else if (Array.isArray(after.enum)) {
      block('enum_added', path || null, `"${label}" is now restricted to an enum.`);
    } else {
      advise('enum_dropped', path || null, `"${label}" is no longer restricted to an enum.`);
    }
  }
  if ('const' in before || 'const' in after) {
    if (stableKey(before.const) !== stableKey(after.const)) {
      if ('const' in after) block('const_changed', path || null, `Constant value of "${label}" changed.`);
      else advise('const_dropped', path || null, `"${label}" is no longer a constant.`);
    }
  }

  // Semantics: unit and format
  for (const k of ['x-unit', 'unit', 'format', 'contentEncoding', 'contentMediaType']) {
    if (stableKey(before[k]) !== stableKey(after[k])) {
      if (before[k] !== undefined && after[k] !== undefined) block(k === 'format' ? 'format_changed' : 'unit_changed', path || null, `${k} of "${label}" changed from ${JSON.stringify(before[k])} to ${JSON.stringify(after[k])}.`);
      else advise('annotation_changed', path || null, `${k} of "${label}" changed.`);
    }
  }

  // Numeric / length bounds: tightening blocks, loosening is advisory
  const lower = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties'];
  const upper = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties'];
  for (const k of [...lower, ...upper]) {
    const b = before[k], a = after[k];
    if (b === a) continue;
    if (typeof b === 'boolean' || typeof a === 'boolean') {
      // Draft-4 style boolean exclusivity: only false/absent -> true tightens.
      if (a === true && b !== true) block('constraint_tightened', path || null, `${k} of "${label}" became exclusive.`);
      else if (stableKey(b) !== stableKey(a)) advise('constraint_loosened', path || null, `${k} of "${label}" changed.`);
      continue;
    }
    const isLower = lower.includes(k);
    let tighter;
    if (a === undefined) tighter = false;
    else if (b === undefined) tighter = true;
    else tighter = isLower ? a > b : a < b;
    if (tighter) block('constraint_tightened', path || null, `${k} of "${label}" tightened from ${JSON.stringify(b)} to ${JSON.stringify(a)}.`);
    else advise('constraint_loosened', path || null, `${k} of "${label}" loosened from ${JSON.stringify(b)} to ${JSON.stringify(a)}.`);
  }
  for (const k of ['pattern', 'multipleOf']) {
    if (stableKey(before[k]) !== stableKey(after[k])) {
      if (after[k] !== undefined) block('constraint_tightened', path || null, `${k} of "${label}" changed to ${JSON.stringify(after[k])}.`);
      else advise('constraint_loosened', path || null, `${k} of "${label}" removed.`);
    }
  }
  if (before.uniqueItems !== true && after.uniqueItems === true) block('constraint_tightened', path || null, `"${label}" now requires unique items.`);
  if (before.additionalProperties !== false && after.additionalProperties === false) {
    block('constraint_tightened', path || null, `"${label}" no longer allows additional properties.`);
  }
  if (stableKey(before.default) !== stableKey(after.default)) advise('default_changed', path || null, `Default of "${label}" changed.`);

  // Properties
  const pb = isObj(before.properties) ? before.properties : {};
  const pa = isObj(after.properties) ? after.properties : {};
  const rb = new Set(Array.isArray(before.required) ? before.required : []);
  const ra = new Set(Array.isArray(after.required) ? after.required : []);
  const removed = Object.keys(pb).filter((k) => !(k in pa));
  const added = Object.keys(pa).filter((k) => !(k in pb));
  const renamedTo = new Set();
  for (const name of removed) {
    const sig = stableKey(pb[name]);
    const match = added.find((n) => !renamedTo.has(n) && stableKey(pa[n]) === sig);
    if (match) {
      renamedTo.add(match);
      block('field_renamed', join(path, name), `Field "${join(path, name)}" was renamed to "${join(path, match)}"; consumers reading the old name break.`);
    } else {
      block('field_removed', join(path, name), `Field "${join(path, name)}" was removed.`);
    }
  }
  for (const name of added) {
    if (renamedTo.has(name)) continue;
    if (ra.has(name)) block('required_added', join(path, name), `New field "${join(path, name)}" is required; existing records and producers do not supply it.`);
  }
  for (const name of Object.keys(pb)) {
    if (!(name in pa)) continue;
    const p = join(path, name);
    if (!rb.has(name) && ra.has(name)) block('required_added', p, `Field "${p}" became required.`);
    if (rb.has(name) && !ra.has(name)) advise('required_removed', p,`Field "${p}" is no longer required; consumers relying on it may receive records without it.`);
    compare(pb[name], pa[name], p, out);
  }
  // Required names with no property definition
  for (const name of ra) {
    if (!(name in pa) && !(name in pb) && !rb.has(name)) block('required_added', join(path, name), `"${join(path, name)}" became required.`);
  }

  // Arrays: compare item schemas under the same path
  if (isObj(before.items) && isObj(after.items)) compare(before.items, after.items, path, out);
  else if (before.items !== undefined && after.items !== undefined && stableKey(before.items) !== stableKey(after.items)) {
    block('type_changed', path || null, `Item schema of "${label}" changed.`);
  }

  // Composition keywords. Adding alternatives to oneOf/anyOf only widens what is accepted (advisory);
  // dropping or changing an alternative, or any change to allOf/not/$ref, is treated as breaking.
  for (const k of ['oneOf', 'anyOf']) {
    if (stableKey(before[k]) === stableKey(after[k])) continue;
    if (Array.isArray(before[k]) && Array.isArray(after[k])) {
      const a = new Set(after[k].map(stableKey));
      const lost = before[k].filter((s) => !a.has(stableKey(s)));
      if (lost.length) block('type_changed', path || null, `${k} of "${label}" dropped or changed an alternative.`);
      else advise('alternative_added', path || null, `${k} of "${label}" gained alternatives.`);
    } else if (Array.isArray(before[k])) {
      advise('alternative_dropped', path || null, `${k} restriction of "${label}" removed.`);
    } else {
      block('type_changed', path || null, `${k} of "${label}" added.`);
    }
  }
  for (const k of ['allOf', 'not', '$ref']) {
    if (stableKey(before[k]) !== stableKey(after[k])) block('type_changed', path || null, `${k} of "${label}" changed.`);
  }
}

export function check(c) {
  const before = c?.contract_before, after = c?.contract_after;
  if (!isObj(before) || !isObj(after)) return [];
  const out = [];
  compare(before, after, '', out);
  return out;
}
