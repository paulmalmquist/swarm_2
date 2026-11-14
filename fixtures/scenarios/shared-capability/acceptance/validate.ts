// Minimal structural validator for the JSON-Schema subset the HealthRecord contract uses.
type Schema = { type?: string | string[]; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema };

export function validate(value: unknown, schema: Schema, path = '$'): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actual)) errors.push(`${path}: expected ${types.join('|')}, got ${actual}`);
  }
  if (schema.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}.${key}: required field is missing`);
    for (const [key, sub] of Object.entries(schema.properties)) if (key in obj) errors.push(...validate(obj[key], sub, `${path}.${key}`));
  }
  if (schema.items && Array.isArray(value)) value.forEach((v, i) => errors.push(...validate(v, schema.items!, `${path}[${i}]`)));
  return errors;
}
