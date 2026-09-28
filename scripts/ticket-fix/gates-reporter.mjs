// node:test reporter used by run-tests.mjs and the ticket gates: one JSON line
// per finished test, with the names of its parent tests, so a reply can cite
// "<file>::<parent> > <test>" and the host can look the result up. A failure
// also records why: error_code is the failing assertion's code (ERR_ASSERTION
// for an assertion; absent for a thrown TypeError or a missing module) and
// failure_type is node's (testCodeFailure, hookFailure, subtestsFailed ...),
// so the reproduction gate can tell "failed on an assertion" from "did not run".
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
    const line = { file: data.file ?? null, name: names.join(' > '), status, kind: data.details?.type ?? 'test' };
    if (status === 'fail') {
      const error = data.details?.error;
      const cause = error?.cause && typeof error.cause === 'object' ? error.cause : null;
      const code = cause?.code ?? (error?.code === 'ERR_TEST_FAILURE' ? null : error?.code) ?? null;
      line.error_code = typeof code === 'string' ? code : null;
      line.failure_type = typeof error?.failureType === 'string' ? error.failureType : null;
      const message = String(cause?.message ?? error?.message ?? '').split('\n')[0].slice(0, 300);
      if (message) line.message = message;
    }
    yield `${JSON.stringify(line)}\n`;
  }
}
