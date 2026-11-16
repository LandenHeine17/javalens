// Lesson library: every .java file in /samples shows up in the dropdown automatically.
const files = import.meta.glob('../../samples/*.java', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

export const samples: { name: string; code: string }[] = Object.entries(files)
  .map(([path, code]) => ({ name: path.split('/').pop()!.replace('.java', ''), code }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const defaultSample = samples.find((s) => s.name === 'Factorial') ?? samples[0];
