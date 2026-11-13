export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number>;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
};

/** Deeply nested hostile values otherwise produce error paths that themselves blow up the context. */
const showPath = (path: string): string => (path.length > 200 ? path.slice(0, 200) + '…' : path);

export function validateSchema(schema: JsonSchema, value: unknown, path = ''): string[] {
  const errors: string[] = [];
  const at = path ? `property "${path}"` : 'value';
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const matches =
    schema.type === 'integer'
      ? typeof value === 'number' && Number.isInteger(value)
      : schema.type === 'object'
        ? actual === 'object'
        : actual === schema.type;
  if (schema.type && !matches) return [`${at} must be ${schema.type}, got ${actual}`];
  if (schema.enum && !schema.enum.includes(value as string | number))
    errors.push(`${at} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${at} must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(obj, key))
        errors.push(`missing required property "${path ? showPath(path) + '.' : ''}${key}"`);
    for (const [key, entry] of Object.entries(obj)) {
      const name = path ? `${path}.${key}` : key;
      if (schema.properties?.[key]) errors.push(...validateSchema(schema.properties[key], entry, name));
      else if (schema.additionalProperties === false) errors.push(`unknown property "${showPath(name)}"`);
    }
  }
  if (Array.isArray(value) && schema.items)
    value.forEach((v, i) => errors.push(...validateSchema(schema.items!, v, `${path}[${i}]`)));
  return errors;
}
