import importlib.util
import contextlib
import io
import http.server
import threading
import sys
import json
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

p = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'synthetic_operator.py'
spec = importlib.util.spec_from_file_location('operator', p)
op = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op)

class OperatorTests(unittest.TestCase):
    def test_origin_and_paths(self):
        for origin in ('http://example.test', 'https://example.test/', 'https://u@example.test', 'https://example.test?x', 'https://example.test:443'):
            with self.assertRaises(ValueError): op.check_origin(origin)
        self.assertEqual(op.check_origin('https://example.test'), 'https://example.test')
        with self.assertRaises(ValueError): op.identifier('../bad')

    def test_private_output_and_existing_file(self):
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path.home())) as path:
            fd, ids = op.open_path(path)
            try:
                op.write_url(op.reserve_url(fd, 'editor-url'), path, ids, 'https://example.test/#code=secret')
                self.assertEqual(os.stat(path + '/editor-url').st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError): op.reserve_url(fd, 'editor-url')
            finally: os.close(fd)

    def test_transport_sends_explicit_user_agent(self):
        class Response:
            status = 200
            def read(self, n): return b'{}'
        class Connection:
            def __init__(self, host, timeout): pass
            def request(self, method, path, body, headers):
                self.headers = headers
                calls.append(headers)
            def getresponse(self): return Response()
            def close(self): pass
        calls = []
        with patch.object(op.http.client, 'HTTPSConnection', Connection):
            self.assertEqual(op.request('https://example.test', 'synthetic-key', 'GET', '/v1/me'), {})
        self.assertEqual(calls[0]['User-Agent'], 'Mozilla/5.0 (compatible; SyntheticOperator/1.0)')

    def test_transport_never_follows_redirect_or_retries_and_bounds_body(self):
        class Response:
            status = 302
            def read(self, n): return b'private'
        class Connection:
            calls = 0
            def __init__(self, *a, **kw): pass
            def request(self, *a, **kw): Connection.calls += 1
            def getresponse(self): return Response()
            def close(self): pass
        with patch.object(op.http.client, 'HTTPSConnection', Connection):
            with self.assertRaises(op.Stop): op.request('https://example.test', 'synthetic-key', 'POST', '/v1/editor-sessions', {})
        self.assertEqual(Connection.calls, 1)
        Response.status = 200
        Response.read = lambda self, n: b'x' * n
        with patch.object(op.http.client, 'HTTPSConnection', Connection):
            with self.assertRaises(op.Stop): op.request('https://example.test', 'synthetic-key', 'GET', '/v1/me')

    def test_local_http_transport_and_private_editor_output(self):
        seen = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                seen.append((self.path, self.headers.get('Authorization'), self.headers.get('Origin'), json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                body = json.dumps({'pageId': 'a' * 64, 'code': 'synthetic_secret_code'}).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory(dir=str(pathlib.Path.home())) as path:
                keypath = path + '/management-key'
                with open(keypath, 'w') as f: f.write('k' * 32)
                os.chmod(keypath, 0o600)
                stdout, stderr = io.StringIO(), io.StringIO()
                argv = ['operator', '--origin', 'https://example.test', '--private-dir', path, 'editor', 'one', 'two']
                with patch.object(sys, 'argv', argv), patch.object(op.http.client, 'HTTPSConnection', side_effect=lambda *a, **kw: http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(op.main(), 0)
                    self.assertEqual(op.main(), 1)
                self.assertEqual(len(seen), 1)
                self.assertEqual(seen[0], ('/v1/editor-sessions', 'Bearer ' + 'k' * 32, None, {'origin': 'https://example.test', 'roles': ['one', 'two']}))
                self.assertNotIn('synthetic_secret_code', stdout.getvalue() + stderr.getvalue())
                self.assertNotIn('k' * 32, stdout.getvalue() + stderr.getvalue())
                self.assertIn('#pageId=', pathlib.Path(path + '/editor-url').read_text())
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_view_url_and_failed_response_remain_private(self):
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path.home())) as path:
            keypath = path + '/management-key'
            pathlib.Path(keypath).write_text('k' * 32); os.chmod(keypath, 0o600)
            argv = ['operator', '--origin', 'https://example.test', '--private-dir', path, 'view', 'envelope1', 'task1']
            out, err = io.StringIO(), io.StringIO()
            with patch.object(sys, 'argv', argv), patch.object(op, 'request', return_value={'code': 'private_synthetic_code'}) as req, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(op.main(), 0)
            self.assertEqual(req.call_count, 1)
            self.assertEqual(pathlib.Path(path + '/recipient-url-task1').read_text(), 'https://example.test/candidate.html#code=private_synthetic_code\n')
            self.assertEqual(os.stat(path + '/recipient-url-task1').st_mode & 0o777, 0o600)
            self.assertNotIn('private_synthetic_code', out.getvalue() + err.getvalue())
            argv[-1] = 'task2'
            with patch.object(sys, 'argv', argv), patch.object(op, 'request', side_effect=op.Stop()) as req, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                self.assertEqual(op.main(), 1)
            self.assertEqual(req.call_count, 1)
            self.assertEqual(pathlib.Path(path + '/recipient-url-task2').read_text(), '')
            self.assertIn('result may be lost', err.getvalue())

    def test_management_actions_http_contract_and_failure_output(self):
        page = 'a' * 64
        cases = [
            (['result', page], 'GET', '/v1/editor-sessions/' + page + '/result', None, None,
             {'templateId': 'template1'}, 'Template ID: template1\n'),
            (['envelope', 'template1', 'idem1', 'signer1', 'Alex Example', 'alex@example.test', 'signer2', 'Blair Example', 'blair@example.test'],
             'POST', '/v1/envelopes', {'templateId': 'template1', 'recipients': [
                 {'role': 'signer1', 'name': 'Alex Example', 'email': 'alex@example.test'},
                 {'role': 'signer2', 'name': 'Blair Example', 'email': 'blair@example.test'}]}, 'idem1',
             {'id': 'envelope1'}, 'Envelope ID: envelope1\n'),
            (['prepare', 'envelope1'], 'POST', '/v1/envelopes/envelope1/prepare', None, None,
             {}, 'Prepared.\n'),
            (['tasks', 'envelope1'], 'GET', '/v1/envelopes/envelope1/tasks', None, None,
             {'tasks': [{'id': 'task1', 'role': 'signer1', 'routingOrder': 1},
                        {'id': 'task2', 'role': 'signer2', 'routingOrder': 2}]},
             'Task ID: task1 role: signer1\nTask ID: task2 role: signer2\n'),
        ]
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path.home())) as path:
            key = 'k' * 32
            pathlib.Path(path + '/management-key').write_text(key)
            os.chmod(path + '/management-key', 0o600)
            for action, method, url, body, idem, response, expected in cases:
                for status in (200, 503):
                    with self.subTest(action=action[0], status=status):
                        calls = []
                        class Response:
                            def read(self, n):
                                calls.append(('read', n))
                                return json.dumps(response).encode() if status == 200 else b'private server error'
                        class Connection:
                            def __init__(self, host, timeout): calls.append(('connect', host, timeout))
                            def request(self, method, url, body, headers): calls.append(('request', method, url, body, headers))
                            def getresponse(self):
                                result = Response(); result.status = status
                                return result
                            def close(self): calls.append(('close',))
                        out, err = io.StringIO(), io.StringIO()
                        argv = ['operator', '--origin', 'https://example.test', '--private-dir', path] + action
                        with patch.object(sys, 'argv', argv), patch.object(op.http.client, 'HTTPSConnection', Connection), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                            self.assertEqual(op.main(), 0 if status == 200 else 1)
                        headers = {'Authorization': 'Bearer ' + key, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; SyntheticOperator/1.0)'}
                        if body is not None: headers['Content-Type'] = 'application/json'
                        if idem is not None: headers['Idempotency-Key'] = idem
                        encoded = json.dumps(body, separators=(',', ':')).encode() if body is not None else None
                        self.assertEqual(calls, [('connect', 'example.test', 20), ('request', method, url, encoded, headers), ('read', op.MAX_BODY + 1), ('close',)])
                        if status == 200:
                            self.assertEqual(out.getvalue(), expected)
                            self.assertEqual(err.getvalue(), '')
                        else:
                            self.assertEqual(out.getvalue(), '')
                            self.assertEqual(err.getvalue(), 'Stopped. Do not retry a mutation: its result may be lost. Establish settlement and inspect state privately before any recovery. Check private output files.\n')
                            self.assertNotIn('private server error', err.getvalue())

    def test_rejects_insecure_key_before_request(self):
        with tempfile.TemporaryDirectory(dir=str(pathlib.Path.home())) as path:
            pathlib.Path(path + '/management-key').write_text('k' * 32)
            os.chmod(path + '/management-key', 0o644)
            argv = ['operator', '--origin', 'https://example.test', '--private-dir', path, 'editor', 'one', 'two']
            with patch.object(sys, 'argv', argv), patch.object(op, 'request') as req, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(op.main(), 1)
            req.assert_not_called()

    def test_output_does_not_echo_server_code(self):
        with self.assertRaises(op.Stop): op.safe_id({'pageId': 'bad#secret'}, 'pageId')

if __name__ == '__main__': unittest.main()
