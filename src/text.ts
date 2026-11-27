/** 英文文案按数量选单复数：plural(1, "build") → "1 build"，plural(2, "build") → "2 builds" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
