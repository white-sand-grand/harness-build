export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`Missing prompt variable: ${name}`);
    return String(vars[name]);
  });
}
