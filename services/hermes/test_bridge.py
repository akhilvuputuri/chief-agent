import os
import unittest
from unittest.mock import patch
import bridge

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.data = {"runId": "dc86f43e-0e99-4a0b-a15a-b7e81f64aac6", "capability": "a"*64,
                     "message": "Help me compare roles", "history": [], "memories": []}

    def test_envelope_rejects_identity_injection(self):
        with self.assertRaises(ValueError):
            bridge.validate_request({**self.data, "user_id": "victim"})

    def test_exact_tool_allowlist_and_history(self):
        seen = {}
        class FakeAgent:
            tools = [{"function": {"name": "companion_action"}}]
            def __init__(self, **kwargs): seen.update(kwargs)
            def run_conversation(self, **kwargs):
                seen.update(kwargs)
                return {"final_response": "Let's compare", "messages": [{"role": "assistant", "content": "Let's compare"}]}
        with patch.dict(os.environ, {"HERMES_MODEL": "test"}):
            result = bridge.run_turn(self.data, FakeAgent)
        self.assertEqual(result["reply"], "Let's compare")
        self.assertEqual(seen["enabled_toolsets"], ["companion"])
        self.assertTrue(seen["skip_memory"])
        self.assertIsNone(bridge._active_capability)

    def test_unexpected_native_tool_fails_closed(self):
        class UnsafeAgent:
            tools = [{"function": {"name": "terminal"}}]
            def __init__(self, **kwargs): pass
            def run_conversation(self, **kwargs): raise AssertionError("Must not run")
        with patch.dict(os.environ, {"HERMES_MODEL": "test"}), self.assertRaises(RuntimeError):
            bridge.run_turn(self.data, UnsafeAgent)
        self.assertIsNone(bridge._active_capability)

    def test_no_tool_outside_turn(self):
        self.assertIn('No active turn', bridge.tool_handler({"operation": "job_list"}))

if __name__ == '__main__': unittest.main()
