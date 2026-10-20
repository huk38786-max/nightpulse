"""Local HTTP fixtures exercise the MCP wire format without production services."""
import io
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'hooks' / 'nightpulse'))
import memory_transport as transport


class Server(ThreadingHTTPServer):
    daemon_threads = True


class Fixture(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args): pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append((body, dict(self.headers)))
        if self.path == '/forbidden':
            return self.send_body(403, b'denied')
        if self.path == '/redirect':
            self.send_response(307)
            self.send_header('Location', '/other')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if self.path == '/unavailable':
            return self.send_body(503, b'unavailable')
        if body['method'] == 'notifications/initialized':
            return self.send_body(202, b'')
        if body['method'] == 'initialize':
            payload = {'jsonrpc': '2.0', 'id': body['id'], 'result': {'protocolVersion': transport.PROTOCOL_VERSION, 'capabilities': {}}}
            session = None if self.path == '/stateless' else 'fixture-session'
            return self.send_body(200, json.dumps(payload).encode(), session=session)
        if self.path == '/error':
            payload = {'jsonrpc': '2.0', 'id': body['id'], 'result': {'isError': True, 'content': [{'type': 'text', 'text': 'secret error'}]}}
        else:
            payload = {'jsonrpc': '2.0', 'id': body['id'], 'result': {'content': [{'type': 'text', 'text': 'synthetic memory'}]}}
        if self.path == '/sse':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            event = 'data: ' + json.dumps(payload) + '\n\n'
            self.wfile.write(b'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n')
            self.wfile.write(event.encode()); self.wfile.flush()
            self.server.release.wait(2)  # Matching result must return before this closes.
            self.close_connection = True
            return
        if self.path == '/drip':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            try:
                for char in json.dumps(payload).encode():
                    self.wfile.write(bytes([char])); self.wfile.flush()
                    time.sleep(.025)
            except (BrokenPipeError, ConnectionResetError): pass
            self.close_connection = True
            return
        return self.send_body(200, json.dumps(payload).encode())

    def send_body(self, status, body, session=None):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if session: self.send_header('Mcp-Session-Id', session)
        self.end_headers(); self.wfile.write(body)


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(('127.0.0.1', 0), Fixture)
        cls.server.calls = []
        cls.server.release = threading.Event()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.release.set(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def setUp(self):
        self.server.calls.clear()
        self.env = patch.dict(os.environ, {'NIGHTPULSE_OB_MCP_URL': '', 'NIGHTPULSE_OB_MCP_TOKEN': '', 'NIGHTPULSE_OB_MCP_FALLBACK_URL': ''})
        self.env.start(); self.addCleanup(self.env.stop)

    def call(self, path, deadline=None):
        return transport.mcp_call_at_url(self.base + path, 'breath', {'query': 'fixture'}, deadline=deadline or time.monotonic() + 2)

    def test_session_json_and_bearer_header(self):
        os.environ['NIGHTPULSE_OB_MCP_TOKEN'] = 'fixture-token'
        self.assertEqual(self.call('/json'), 'synthetic memory')
        calls = self.server.calls
        self.assertEqual([body['method'] for body, _ in calls], ['initialize', 'notifications/initialized', 'tools/call'])
        self.assertEqual(calls[-1][1]['Mcp-Session-Id'], 'fixture-session')
        self.assertEqual(calls[-1][1]['Authorization'], 'Bearer fixture-token')
        self.assertEqual(calls[-1][0]['params']['arguments'], {'query': 'fixture'})

    def test_stateless_server(self):
        self.assertEqual(self.call('/stateless'), 'synthetic memory')
        self.assertNotIn('Mcp-Session-Id', self.server.calls[-1][1])

    def test_sse_returns_without_waiting_for_stream_close(self):
        start = time.monotonic()
        self.assertEqual(self.call('/sse'), 'synthetic memory')
        self.assertLess(time.monotonic() - start, 1)
        self.assertFalse(self.server.release.is_set())

    def test_shared_deadline_stops_drip_response(self):
        start = time.monotonic()
        with self.assertRaises(TimeoutError):
            self.call('/drip', deadline=start + .15)
        self.assertLess(time.monotonic() - start, .75)

    def test_expired_budget_sends_no_request(self):
        with self.assertRaises(TimeoutError): self.call('/json', deadline=time.monotonic() - 1)
        self.assertEqual(self.server.calls, [])

    def test_authorization_failure_does_not_fallback(self):
        os.environ['NIGHTPULSE_OB_MCP_URL'] = self.base + '/forbidden'
        os.environ['NIGHTPULSE_OB_MCP_FALLBACK_URL'] = self.base + '/json'
        with self.assertRaises(urllib.error.HTTPError): transport.mcp_call('breath', {})
        self.assertEqual(len(self.server.calls), 1)

    def test_explicit_fallback_on_service_unavailable(self):
        os.environ['NIGHTPULSE_OB_MCP_URL'] = self.base + '/unavailable'
        os.environ['NIGHTPULSE_OB_MCP_FALLBACK_URL'] = self.base + '/json'
        self.assertEqual(transport.mcp_call('breath', {}), 'synthetic memory')
        self.assertEqual(len(self.server.calls), 4)

    def test_redirect_is_not_followed(self):
        with self.assertRaises(urllib.error.HTTPError): self.call('/redirect')
        self.assertEqual(len(self.server.calls), 1)

    def test_readonly_allowlist_and_missing_config(self):
        with self.assertRaises(ValueError):
            transport.mcp_call_at_url(self.base, 'write_memory', {}, deadline=time.monotonic() + 1)
        with self.assertRaises(transport.RecallNotConfigured): transport.mcp_call('breath', {})
        self.assertEqual(self.server.calls, [])

    def test_rpc_error_and_size_limit(self):
        with self.assertRaises(transport.MCPProtocolError): self.call('/error')
        class Body(io.BytesIO):
            headers = {'content-type': 'application/json'}
        with patch.object(transport, 'MCP_RESPONSE_LIMIT', 12):
            with self.assertRaises(transport.MCPProtocolError):
                transport.read_mcp_payload(Body(b'x' * 13), 1, time.monotonic() + 1)
        with self.assertRaises(transport.MCPProtocolError):
            transport.read_mcp_payload(Body(b'{"id":99,"result":{}}'), 1, time.monotonic() + 1)

    def test_logs_omit_url_credentials_and_error_message(self):
        error = urllib.error.HTTPError('https://sensitive.invalid/token=private', 403, 'private', {}, None)
        with patch('sys.stderr', new_callable=io.StringIO) as log:
            transport.log_mcp_failure('breath', error, .1)
        data = json.loads(log.getvalue())
        self.assertEqual(data['http_status'], 403)
        self.assertNotIn('private', log.getvalue())
        self.assertNotIn('sensitive', log.getvalue())
        error.close()


if __name__ == '__main__': unittest.main()
