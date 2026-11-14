// Step `interface_compat`: compare contract_before and contract_after and block changes that break
// existing producers or consumers of the shared record. Pure function of the two schemas.
export const id = 'interface_compat';

// Keywords that only document a field; changing them never changes which records are valid
// or what values mean.
const ANNOTATIONS = new Set([
  'description', 'title', 'examples', 'example', '$comment', 'comment', 'deprecated',
  'x-description', 'x-doc', 'x-docs', 'x-notes', 'x-note', 'x-owner', 'x-example', 'x-examples',
]);
// Keywords handled explicitly below.
const HANDLED = new Set(['type', 'properties', 'required', 'enum', 'items', 'default', 'const']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function typeSet(s) {
  if (!isObj(s)) return null;
  let t = s.type;
  if (t === undefined) {
    if (isObj(s.properties)) t = 'object';
    else if (s.items !== undefined) t = 'array';
    else return null;
  }
  const arr = Array.isArray(t) ? t : [t];
  const out = [...new Set(arr.map(String))].sort();
  if (s.nullable === true && !out.includes('null')) out.push('null');
  return out.sort();
}

// Strip annotations and nested structure so the remaining keywords can be compared directly.
function stripped(s) {
  const o = {};
  for (const k of Object.keys(s)) {
    if (ANNOTATIONS.has(k) || HANDLED.has(k) || k === 'nullable') continue;
    o[k] = s[k];
  }
  return o;
}

function join(path, name) {
  return path ? path + '.' + name : name;
}

function compare(before, after, path, findings) {
  const block = (cls, field, message) => findings.push({ step: id, class: cls, field, severity: 'blocking', message });
  const advise = (cls, field, message) => findings.push({ step: id, class: cls, field, severity: 'advisory', message });
  const where = path || '(root)';
  if (!isObj(before) || !isObj(after)) {
    if (canon(before) !== canon(after)) block('schema_changed', path || null, `Schema of "${where}" changed shape.`);
    return;
  }

  // Type.
  const tb = typeSet(before), ta = typeSet(after);
  if (canon(tb) !== canon(ta)) {
    block('type_changed', path || null, `Type of "${where}" changed from ${JSON.stringify(tb)} to ${JSON.stringify(ta)}.`);
  }

  // Enum / const: removed values break consumers and stored data; dropping the enum entirely
  // lets unexpected values reach consumers; added values are reported as advisory.
  const eb = Array.isArray(before.enum) ? before.enum.map(canon) : null;
  const ea = Array.isArray(after.enum) ? after.enum.map(canon) : null;
  if (eb && !ea) {
    block('enum_removed', path || null, `"${where}" is no longer restricted to its enum values.`);
  } else if (!eb && ea) {
    block('enum_added', path || null, `"${where}" is now restricted to enum values; existing values may become invalid.`);
  } else if (eb && ea) {
    const removed = eb.filter((v) => !ea.includes(v));
    const added = ea.filter((v) => !eb.includes(v));
    if (removed.length) block('enum_value_removed', path || null, `"${where}" no longer allows ${removed.join(', ')}.`);
    if (added.length) advise('enum_value_added', path || null, `"${where}" now also allows ${added.join(', ')}; consumers should handle it.`);
  }
  if (canon(before.const) !== canon(after.const)) {
    block('const_changed', path || null, `Constant value of "${where}" changed.`);
  }
  if (canon(before.default) !== canon(after.default)) {
    advise('default_changed', path || null, `Default of "${where}" changed.`);
  }

  // Other validation / semantic keywords (units, format, bounds, pattern, additionalProperties, ...).
  const sb = stripped(before), sa = stripped(after);
  for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) {
    if (canon(sb[k]) === canon(sa[k])) continue;
    if (k.startsWith('x-') && !/unit|scale|precision|timezone|tz|encoding|currency|format|semantic|meaning|reference|epoch/i.test(k)) {
      advise('extension_changed', path || null, `Extension "${k}" of "${where}" changed.`);
      continue;
    }
    const cls = k === 'x-unit' ? 'unit_changed' : k === 'format' ? 'format_changed' : 'constraint_changed';
    block(cls, path || null, `"${k}" of "${where}" changed from ${JSON.stringify(sb[k])} to ${JSON.stringify(sa[k])}.`);
  }

  // Object properties.
  const pb = isObj(before.properties) ? before.properties : null;
  const pa = isObj(after.properties) ? after.properties : null;
  if (pb || pa) {
    const propsB = pb ?? {}, propsA = pa ?? {};
    const reqB = new Set(Array.isArray(before.required) ? before.required : []);
    const reqA = new Set(Array.isArray(after.required) ? after.required : []);
    const addedNames = Object.keys(propsA).filter((n) => !(n in propsB));
    for (const name of Object.keys(propsB)) {
      const p = join(path, name);
      if (!(name in propsA)) {
        const twin = addedNames.find((n) => canon(stripAnn(propsA[n])) === canon(stripAnn(propsB[name])));
        if (twin) block('field_renamed', p, `Field "${p}" was renamed to "${join(path, twin)}"; consumers reading "${p}" break.`);
        else block('field_removed', p, `Field "${p}" was removed; consumers reading it break.`);
        continue;
      }
      if (reqB.has(name) && !reqA.has(name)) {
        block('required_removed', p, `Field "${p}" is no longer required; consumers relying on it may receive records without it.`);
      } else if (!reqB.has(name) && reqA.has(name)) {
        block('required_added', p, `Field "${p}" is now required; existing producers and stored records may not provide it.`);
      }
      compare(propsB[name], propsA[name], p, findings);
    }
    for (const name of addedNames) {
      const p = join(path, name);
      if (reqA.has(name)) block('required_added', p, `New field "${p}" is required; existing producers and stored records do not provide it.`);
      else advise('optional_field_added', p, `Optional field "${p}" was added.`);
    }
    // Required names that are not declared properties.
    for (const name of reqA) {
      if (!reqB.has(name) && !(name in propsA) && !(name in propsB)) {
        block('required_added', join(path, name), `"${join(path, name)}" is now required.`);
      }
    }
  } else {
    const rb = Array.isArray(before.required) ? before.required : [];
    const ra = Array.isArray(after.required) ? after.required : [];
    for (const n of ra) if (!rb.includes(n)) block('required_added', join(path, n), `"${join(path, n)}" is now required.`);
    for (const n of rb) if (!ra.includes(n)) block('required_removed', join(path, n), `"${join(path, n)}" is no longer required.`);
  }

  // Array items: element fields are addressed through the array field's path.
  if (before.items !== undefined || after.items !== undefined) {
    if (before.items === undefined || after.items === undefined) {
      block('items_changed', path || null, `Item schema of "${where}" was ${before.items === undefined ? 'added' : 'removed'}.`);
    } else if (Array.isArray(before.items) || Array.isArray(after.items)) {
      if (canon(stripAnnDeep(before.items)) !== canon(stripAnnDeep(after.items))) block('items_changed', path || null, `Item schema of "${where}" changed.`);
    } else {
      compare(before.items, after.items, path, findings);
    }
  }
}

function stripAnn(s) {
  return stripAnnDeep(s);
}

function stripAnnDeep(v) {
  if (Array.isArray(v)) return v.map(stripAnnDeep);
  if (!isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v)) {
    if (ANNOTATIONS.has(k)) continue;
    o[k] = k === 'properties' && isObj(v[k])
      ? Object.fromEntries(Object.keys(v[k]).map((n) => [n, stripAnnDeep(v[k][n])]))
      : stripAnnDeep(v[k]);
  }
  return o;
}

export function check(c) {
  const before = c?.contract_before;
  const after = c?.contract_after;
  if (!isObj(before) && !isObj(after)) return [];
  if (!isObj(before) || !isObj(after)) {
    return [{ step: id, class: 'contract_replaced', field: null, severity: 'advisory', message: 'Only one side of the contract is available; nothing to compare.' }];
  }
  const findings = [];
  compare(before, after, '', findings);
  // Collapse duplicate blocking findings for the same field and class.
  const seen = new Set();
  return findings.filter((f) => {
    const k = f.severity + '|' + f.class + '|' + f.field;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
