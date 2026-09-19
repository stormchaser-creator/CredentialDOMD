#!/usr/bin/env python3
"""Installed Claude CLI JSON contract against an OS-confined loopback mock API.

No provider/account credentials: the child gets an environment allowlist, --bare,
empty settings/MCP/tools, and a fake key. Its OS profile blocks every network
destination except this ephemeral local fixture server and denies Keychain reads.
Failure to apply that profile fails the test; no unrestricted retry is allowed.
"""
import hashlib
import json
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLI = Path('/Users/ew/.local/share/fnm/node-versions/v24.15.0/installation/bin/claude')
NODE = Path(shutil.which('node')).resolve()
TARGET = '20000000-0000-4000-8000-000000000001'
result = {
    'reply': 'Your existing answer is recorded. Investigation remains in progress.',
    'summary': 'Wholly synthetic CLI compatibility fixture.',
    'needs_owner_review': False,
    'assessment': {
        'acceptance_criteria': [{'requirement': 'Review the synthetic report', 'state': 'open', 'evidence_ids': [TARGET]}],
        'answered_questions': [], 'prior_fixes': [], 'questions': [],
        'follow_up': [{'work': 'Investigate synthetic issue', 'owner': 'support_worker', 'next_action': 'Review synthetic fixture'}],
        'completed_follow_up': [],
        'verification': {'kind': 'not_run', 'reproduction': 'Synthetic fixture only', 'checks': 'No product checks run', 'release': 'Not deployed'},
    },
}
requests = []
errors = []


class MockAPI(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            if self.path.split('?')[0] != '/v1/messages':
                raise AssertionError('Unexpected mock API path')
            if self.headers.get('x-api-key') != 'synthetic-loopback-key':
                raise AssertionError('Only the synthetic credential is permitted')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size < 2_000_000:
                raise AssertionError('Unexpected mock request size')
            body = json.loads(self.rfile.read(size))
            tool = next((t for t in body.get('tools', []) if t.get('name') == 'StructuredOutput'), None)
            if not tool:
                raise AssertionError('Installed CLI did not register StructuredOutput')
            if tool.get('input_schema') != schema:
                raise AssertionError('Installed CLI did not pass the support result schema')
            requests.append({'model': body.get('model'), 'stream': body.get('stream'), 'tool': tool['name']})
            content = {'type': 'tool_use', 'id': 'toolu_synthetic_contract', 'name': 'StructuredOutput', 'input': result}
            message = {'id': 'msg_synthetic_contract', 'type': 'message', 'role': 'assistant',
                       'model': body['model'], 'content': [content], 'stop_reason': 'tool_use', 'stop_sequence': None,
                       'usage': {'input_tokens': 50, 'output_tokens': 150}}
            if body.get('stream'):
                initial = {**message, 'content': [], 'stop_reason': None}
                events = [
                    ('message_start', {'type': 'message_start', 'message': initial}),
                    ('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {**content, 'input': {}}}),
                    ('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(result)}}),
                    ('content_block_stop', {'type': 'content_block_stop', 'index': 0}),
                    ('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use', 'stop_sequence': None}, 'usage': {'output_tokens': 150}}),
                    ('message_stop', {'type': 'message_stop'}),
                ]
                encoded = ''.join('event: ' + name + '\ndata: ' + json.dumps(data) + '\n\n' for name, data in events).encode()
                content_type = 'text/event-stream'
            else:
                encoded = json.dumps(message).encode()
                content_type = 'application/json'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            errors.append(str(error))
            self.send_error(400, 'Synthetic fixture rejected request')


with tempfile.TemporaryDirectory(prefix='support-cli-contract-', dir='/private/tmp') as tmp:
    folder = Path(tmp)
    folder.chmod(0o700)
    config = folder / 'config'
    config.mkdir(mode=0o700)
    base_env = {'PATH': '/usr/bin:/bin', 'TMPDIR': str(folder), 'LC_ALL': 'C',
                'CLAUDE_CONFIG_DIR': str(config), 'ANTHROPIC_API_KEY': 'synthetic-loopback-key',
                'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
    schema = json.loads(subprocess.check_output([NODE, ROOT / 'scripts/ticket-agent-context.mjs', '--schema'],
                                               text=True, env=base_env, cwd=folder, timeout=10))
    server = HTTPServer(('127.0.0.1', 0), MockAPI)
    port = server.server_address[1]
    profile = folder / 'local-only.sb'
    profile.write_text('(version 1)\n(allow default)\n(deny network*)\n'
                       f'(allow network-outbound (remote ip "localhost:{port}"))\n'
                       '(deny file-read* (subpath "/Users/ew/Library/Keychains"))\n'
                       '(deny process-exec (literal "/usr/bin/security"))\n')
    profile.chmod(0o600)
    prefix = ['/usr/bin/sandbox-exec', '-f', str(profile)]
    # Prove the profile is enforceable before starting an installed model process.
    probe = subprocess.run(prefix + ['/usr/bin/true'], env=base_env, capture_output=True, text=True, timeout=5)
    if probe.returncode:
        server.server_close()
        raise RuntimeError('OS isolation unavailable; no CLI model session started: ' + probe.stderr.strip())
    # A refused connection is insufficient: an unlisted local destination must
    # be denied by the profile before any network traffic, with EPERM/EACCES.
    blocked_probe = subprocess.run(prefix + ['/usr/bin/python3', '-c',
        'import errno,socket,sys\n'
        'try:\n socket.create_connection(("127.0.0.1", 9), timeout=1)\n'
        'except OSError as e:\n sys.exit(0 if e.errno in (errno.EPERM,errno.EACCES) else 2)\n'
        'sys.exit(3)'], env=base_env, capture_output=True, text=True, timeout=5)
    if blocked_probe.returncode:
        server.server_close()
        raise RuntimeError('OS profile did not prove other destinations blocked; no CLI model session started')
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = {**base_env, 'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{port}'}
        version = subprocess.check_output(prefix + [str(CLI), '--version'], env=env, cwd=folder, text=True, timeout=10).strip()
        command = prefix + [str(CLI), '--bare', '-p', '--model', 'claude-sonnet-5',
                            '--dangerously-skip-permissions', '--output-format', 'json', '--json-schema', json.dumps(schema),
                            '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
                            '--tools', '', '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
                            '--system-prompt', 'This is an offline synthetic structured output test. Use StructuredOutput only.']
        completed = subprocess.run(command, input='Return the provided synthetic support assessment using StructuredOutput.',
                                   env=env, cwd=folder, capture_output=True, text=True, timeout=40)
        if completed.returncode:
            raise AssertionError('Installed CLI failed against confined mock API: ' + completed.stderr[:1200] + completed.stdout[:1200] + str(errors))
        output = json.loads(completed.stdout)
        assert output.get('type') == 'result' and output.get('subtype') == 'success'
        assert output.get('is_error') is False and output.get('structured_output') == result
        assert len(requests) == 1 and not errors
        validation = subprocess.run([NODE, '--input-type=module', '-e',
            "import {validateAssessment} from " + json.dumps((ROOT / 'scripts/ticket-agent-context.mjs').as_uri()) + ";"
            "let raw='';for await(const chunk of process.stdin)raw+=chunk;const output=JSON.parse(raw);"
            "validateAssessment(output.structured_output,{target_id:" + json.dumps(TARGET) +
            ",run_mode:'reply',history_complete:true,tickets:[{id:" + json.dumps(TARGET) +
            ",messages:[]}],prior_reviews:[],attachments:[]});"],
            input=completed.stdout, env=base_env, cwd=folder, capture_output=True, text=True, timeout=10)
        assert validation.returncode == 0, 'Actual installed CLI output failed trusted host validation'
        print('Installed CLI structured output exercised successfully with an OS-confined loopback mock API')
        print('Version: ' + version)
        print('Binary SHA-256: ' + hashlib.sha256(CLI.read_bytes()).hexdigest())
        print('Exactly one synthetic messages request; output passed trusted host validation; no provider calls')
        print('Limit: API/OAuth authentication, actual model behavior and current provider model availability were not tested')
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
