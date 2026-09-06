"""Opt-in real-Hermes test with a fake local LLM; no paid API calls.

Run with the pinned checkout's Python and PYTHONPATH pointing to that checkout.
"""
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import uuid4

os.environ['HERMES_HOME'] = tempfile.mkdtemp(prefix='companion-smoke-')
os.environ['HERMES_MODEL'] = 'companion-test-model'
os.environ['OPENROUTER_API_KEY'] = 'local-test-only'
os.environ['INTERNAL_API_TOKEN'] = 's' * 64
calls = []


class MockProvider(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data": []}')

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        calls.append((self.path, data))
        if self.path == '/api/show':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"model_info": {}}')
            return
        if self.path == '/internal/tools':
            assert self.headers.get('Authorization') == 'Bearer ' + 'c' * 64
            assert data == {'operation': 'job_list'}
            result = {'result': [{'title': 'AI Engineer', 'company': 'Example'}]}
        else:
            assert self.path.endswith('/chat/completions'), self.path
            has_result = any(m.get('role') == 'tool' for m in data['messages'])
            message = {'role': 'assistant', 'content': 'You have an AI Engineer role at Example.' if has_result else None}
            if not has_result:
                message['tool_calls'] = [{'id': 'call_smoke', 'type': 'function', 'function': {'name': 'companion_action', 'arguments': '{"operation":"job_list"}'}}]
            finish = 'stop' if has_result else 'tool_calls'
            if data.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                delta = dict(message)
                if 'tool_calls' in delta:
                    delta['tool_calls'][0]['index'] = 0
                chunk = {'id': 'smoke', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'companion-test-model', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\n').encode())
                chunk['choices'] = [{'index': 0, 'delta': {}, 'finish_reason': finish}]
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
                return
            result = {'id': 'smoke', 'object': 'chat.completion', 'created': 0, 'model': 'companion-test-model', 'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20}}
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())


server = ThreadingHTTPServer(('127.0.0.1', 0), MockProvider)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}'
os.environ['LLM_BASE_URL'] = base + '/v1'
os.environ['GATEWAY_URL'] = base
try:
    import bridge
    bridge.prepare_runtime()
    from run_agent import AIAgent
    from tools.registry import registry
    registry.register(name='companion_action', toolset='companion', schema=bridge.SCHEMA, handler=bridge.tool_handler)
    with bridge.TURN_LOCK:
        result = bridge.run_turn({'runId': str(uuid4()), 'capability': 'c' * 64, 'message': 'List my saved roles', 'history': [], 'memories': []})
    assert 'AI Engineer' in result['reply'], result
    assert any(path == '/internal/tools' for path, _ in calls), calls
    assert bridge._active_capability is None
    print('PASS: real pinned Hermes invoked companion_action, received tool evidence and produced a final reply.')
finally:
    server.shutdown()
