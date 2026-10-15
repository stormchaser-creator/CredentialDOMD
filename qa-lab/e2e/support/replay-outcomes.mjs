// A diagnostic must fail its actual browser feature, not only write a log.
export function createReplayProblemRecorder({ qa, problems, log = () => {} }) {
  if (!qa || typeof qa.check !== 'function' || typeof qa.bug !== 'function' || !Array.isArray(problems)) throw new TypeError('Replay outcomes require checks, bug recording and a problem ledger.');
  return (title, detail) => {
    problems.push({ title, detail });
    log(title, detail);
    qa.check(title, false, detail);
    qa.bug({ title, step: title, expected: 'The named signup step completes successfully.', actual: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  };
}
export function createReplayFeatureRecorder(qa, problems) {
  if (typeof qa?.feature !== 'function' || typeof qa?.check !== 'function' || !Array.isArray(problems)) throw new TypeError('Replay features require recorded checks and a problem ledger.');
  return (id, title, fn, options) => qa.feature(id, title, async () => {
    const before = problems.length;
    await fn();
    const added = problems.slice(before);
    qa.check('the signup replay step completes without a recorded problem', added.length === 0, added);
  }, options);
}
