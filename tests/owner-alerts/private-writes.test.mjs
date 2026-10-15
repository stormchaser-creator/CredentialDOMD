import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const scenario of ['short-state', 'short-append', 'interrupted', 'zero', 'write-error', 'sync-error', 'rename-error', 'remember']) {
  test(`owner notifier private writes: ${scenario}`, () => {
    const result = spawnSync('python3', ['-c', String.raw`
import importlib.util, tempfile, pathlib, os, errno, json, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('notifier', 'scripts/signup-notify.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
scenario = sys.argv[1]
with tempfile.TemporaryDirectory() as directory:
    target = pathlib.Path(directory) / 'state'
    target.write_text('original')
    target.chmod(0o600)
    real_write = os.write
    calls = [0]
    def short(fd, data):
        calls[0] += 1
        if scenario == 'interrupted' and calls[0] == 1:
            raise InterruptedError(errno.EINTR, 'synthetic interruption')
        if scenario == 'zero': return 0
        if scenario == 'write-error': raise OSError(errno.ENOSPC, 'synthetic full disk')
        return real_write(fd, data[:7])
    payload = 'Physician café 🩺' * 100
    if scenario in ('zero', 'write-error', 'sync-error', 'rename-error'):
        operation = 'fsync' if scenario == 'sync-error' else 'replace' if scenario == 'rename-error' else 'write'
        effect = short if operation == 'write' else OSError(errno.EIO, 'synthetic I/O failure')
        with patch.object(m.os, operation, side_effect=effect):
            try: m.write_private(str(target), payload)
            except OSError: pass
            else: raise AssertionError('I/O failure was swallowed')
        assert target.read_text() == 'original', 'previous state changed on failure'
        assert list(pathlib.Path(directory).glob('*.tmp')) == [], 'failed temporary file left behind'
    else:
        with patch.object(m.os, 'write', side_effect=short):
            if scenario == 'short-append':
                m.append_private(str(target), payload)
                assert target.read_text() == 'original' + payload
            elif scenario == 'remember':
                target.unlink()
                expected = m.remember([{'key': 'synthetic-' + str(i)} for i in range(100)], str(target))
                assert json.loads(target.read_text()) == expected
                assert len(expected) == 100
            else:
                m.write_private(str(target), payload)
                assert target.read_text() == payload
        assert target.stat().st_mode & 0o777 == 0o600
`, scenario], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
