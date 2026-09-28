// node:test reporter used by run-tests.mjs: one JSON line per finished test,
// with the names of its parent tests, so a reply can cite
// "<file>::<parent> > <test>" and the host can look the result up.
export default async function* gatesReporter(source) {
  const stacks = new Map();
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      stacks.set(data.file, stack);
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const names = [...(stacks.get(data.file) ?? []).slice(0, data.nesting), data.name];
    const status = event.type === 'test:fail' ? 'fail' : data.skip !== undefined && data.skip !== false ? 'skip' : data.todo !== undefined && data.todo !== false ? 'todo' : 'pass';
    yield `${JSON.stringify({ file: data.file ?? null, name: names.join(' > '), status, kind: data.details?.type ?? 'test' })}\n`;
  }
}
