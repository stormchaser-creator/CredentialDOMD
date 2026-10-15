"""Run the fixed scoped semaphore helper, failing closed without a compiler.

The binary lives only in this invocation's private temp directory. Never search
for or load a cached writable executable; do not accept source/compiler paths.
"""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def remove_orphan_semaphores(inodes):
    if not isinstance(inodes, (list, tuple)) or not 1 <= len(inodes) <= 64:
        return []
    if any(not isinstance(i, str) or not re.fullmatch(r'[0-9]{1,20}', i) or not 0 < int(i) <= 18446744073709551615 for i in inodes):
        return []
    source = Path(__file__).with_suffix('.c')
    # Only a fixed system compiler; the parent's environment cannot supply code.
    compiler = '/usr/bin/cc'
    try:
        with tempfile.TemporaryDirectory(prefix='credentialdomd-pg-semaphores-') as folder:
            binary = Path(folder) / 'helper'
            env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'TMPDIR': folder}
            built = subprocess.run([compiler, '-std=c99', '-O2', '-Wall', '-Wextra', str(source), '-o', str(binary)], env=env, text=True, capture_output=True, timeout=20)
            if built.returncode != 0:
                return []
            result = subprocess.run([str(binary), '--remove', *inodes], env=env, text=True, capture_output=True, timeout=5)
            if result.returncode != 0:
                return []
            rows = [json.loads(line) for line in result.stdout.splitlines() if line]
            return [r['id'] for r in rows if isinstance(r.get('id'), int) and r.get('removed') is True]
    except (OSError, ValueError, subprocess.SubprocessError):
        return []


if __name__ == '__main__':
    print(json.dumps(remove_orphan_semaphores(sys.argv[1:])))
