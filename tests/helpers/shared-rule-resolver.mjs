// An esbuild plugin for tests that bundle app modules: src/utils/ruleResolver.js
// stays outside the bundle, so the bundle reads the same PA and NP rule data
// the test installed (tests/helpers/app-rules.mjs) instead of a copy of its
// own that nothing installed. Node loads the file itself (require of an ES
// module).
import { fileURLToPath } from 'node:url';

const RESOLVER = fileURLToPath(new URL('../../src/utils/ruleResolver.js', import.meta.url));

export const sharedRuleResolver = {
  name: 'shared-rule-resolver',
  setup(b) {
    b.onResolve({ filter: /(^|\/)ruleResolver(\.js)?$/ }, () => ({ path: RESOLVER, external: true }));
  },
};
