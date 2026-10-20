"""Synthetic fixtures only. No model, production MCP or personal transcript calls."""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HOOKS = Path(__file__).resolve().parents[2] / 'hooks' / 'nightpulse'
sys.path.insert(0, str(HOOKS))
import context_policy as context
import conversation_evidence as evidence
import memory_continuity as continuity
import memory_recall as recall
import recall_policy as policy
import session_archive as archive

MEMORY = '[bucket_id:fixture] [created:2026-01-01]\n### fact\nThe appointment was Tuesday.\n### followup\nThe user corrected it to Wednesday.'


def row(uid, role, text, minute=0):
    return {'type': role, 'uuid': uid, 'timestamp': f'2026-01-01T10:{minute:02d}:00Z',
            'message': {'content': text}}


class RecallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'NIGHTPULSE_RECALL_STATE_DIR': str(self.root / 'state'),
            'NIGHTPULSE_ISOLATED_WAKE': '0'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.source = self.root / 'session.jsonl'
        self.source.write_text('')
        self.payload = {'hook_event_name': 'UserPromptSubmit', 'cwd': str(self.root),
                        'session_id': 'fixture-session', 'transcript_path': str(self.source)}
        self.calls = []

    def mcp(self, name, args):
        self.calls.append((name, args))
        return MEMORY

    def write(self, rows, mode='w'):
        with self.source.open(mode) as stream:
            for item in rows:
                stream.write(json.dumps(item) + '\n')

    def output(self, **kwargs):
        return recall.build_hook_response({**self.payload, **kwargs}, mcp=self.mcp)

    def test_envelope_and_receipts_do_not_become_query(self):
        user = '2024-01-02 是我们搬家的日期'
        prompt = context.NORMAL_HEADER + '\n\n[2026-01-01 10:00]\n\n' + user
        prompt += '\n\n' + context.RECEIPT_HEADER + '\n' + context.RECEIPT_EXPLANATION + '\n{"text":"fixture action"}'
        self.output(prompt=prompt)
        self.assertEqual(self.calls[0][1]['query'], user)
        self.assertEqual(context.strip_transport_context('[2024-01-02 10:00]\n\nmy date'), '[2024-01-02 10:00]\n\nmy date')
        self.assertIn('fixture action', context.strip_transport_context('quoted: ' + context.RECEIPT_HEADER + '\nfixture action'))
        normalized = evidence.normalize(row('u1', 'user', prompt))
        self.assertEqual(normalized['text'], user)

    def test_ordinary_and_explicit_budgets(self):
        out = self.output(prompt='谈谈那个预约')
        self.assertEqual(self.calls[-1][1]['max_tokens'], 350)
        text = out['hookSpecificOutput']['additionalContext']
        self.assertIn('LIGHTWEIGHT INDEX', text)
        self.assertIn('Wednesday', text)
        self.output(prompt='还记得上次预约吗')
        self.assertEqual(self.calls[-1][1]['max_tokens'], 700)
        self.assertNotIn('darkroom_search', [n for n, _ in self.calls])

    def test_casual_wake_and_isolated_session_skip(self):
        self.assertEqual(self.output(prompt='好的！'), {})
        self.assertEqual(self.output(prompt='SYSTEM ACTION MODE: synthetic wake'), {})
        with patch.dict(os.environ, {'NIGHTPULSE_ISOLATED_WAKE': '1'}):
            self.assertEqual(self.output(hook_event_name='SessionStart', source='resume'), {})
            self.assertEqual(continuity.process({**self.payload, 'hook_event_name': 'PreCompact'})['status'], 'isolated_skip')
        self.assertEqual(self.calls, [])
        self.output(prompt='星际旅行')  # Short topical messages are not acknowledgements.
        self.assertEqual(len(self.calls), 1)

    def test_failure_is_not_no_memory(self):
        def broken(*args):
            raise RuntimeError('sensitive memory or token must not be logged')
        with patch('sys.stderr', new_callable=io.StringIO) as log:
            out = recall.build_hook_response({**self.payload, 'prompt': '还记得预约吗'}, mcp=broken)
        self.assertIn('retrieval failed', out['hookSpecificOutput']['additionalContext'])
        self.assertNotIn('sensitive', log.getvalue())

    def test_archive_preserves_source_corrections_and_excludes_internal(self):
        rows = [row('u1', 'user', 'The appointment is Tuesday.'),
                row('a1', 'assistant', 'It is Tuesday.', 1),
                row('u2', 'user', 'Correction: the appointment is Wednesday.', 2),
                row('internal', 'user', 'SYSTEM ACTION MODE: fake wake', 3),
                row('think', 'assistant', [{'type': 'thinking', 'thinking': 'PRIVATE'}], 4),
                row('tool', 'user', [{'type': 'tool_result', 'content': 'PRIVATE'}], 5)]
        self.write(rows)
        archive.configure(self.payload)
        archive.capture(self.source)
        result = evidence.search(archive.DB, terms=['appointment'], limit=1)
        text = evidence.render(result)
        self.assertIn('Wednesday', text)
        self.assertIn('assistant', text)
        self.assertNotIn('PRIVATE', text)
        with evidence.connect(archive.DB, True) as con:
            stored = con.execute('select * from messages order by seq').fetchall()
        self.assertEqual(len(stored), 3)
        raw = self.source.read_bytes().splitlines(keepends=True)[0]
        self.assertEqual(stored[0]['record_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(stored[0]['byte_offset'], 0)
        self.assertEqual(archive.DB.stat().st_mode & 0o777, 0o600)

    def test_incremental_partial_and_rotation(self):
        self.write([row('u1', 'user', 'first')])
        archive.configure(self.payload)
        archive.sync_all(self.source)
        partial = json.dumps(row('u2', 'user', 'second'))
        with self.source.open('a') as stream: stream.write(partial[:20])
        archive.sync_all(self.source)
        with self.source.open('a') as stream: stream.write(partial[20:] + '\n')
        archive.sync_all(self.source)
        replacement = self.root / 'new'
        replacement.write_text(json.dumps(row('u3', 'user', 'third')) + '\n')
        replacement.replace(self.source)
        archive.sync_all(self.source)
        with evidence.connect(archive.DB, True) as con:
            self.assertEqual(con.execute('select count(*) from messages').fetchone()[0], 3)

    def test_scope_separates_workspaces(self):
        archive.configure(self.payload); first = archive.DB
        archive.configure({**self.payload, 'cwd': str(self.root / 'another-project')})
        self.assertNotEqual(first, archive.DB)

    def test_summary_is_derived_and_checkpoint_idempotent(self):
        self.write([row('u1', 'user', 'quoted fact')])
        payload = {**self.payload, 'hook_event_name': 'PreCompact'}
        first = continuity.process(payload)
        self.assertEqual(first['checkpoint_id'], continuity.process(payload)['checkpoint_id'])
        continuity.process({**payload, 'hook_event_name': 'PostCompact', 'compact_summary': 'derived claim'})
        checkpoint = evidence.latest_checkpoint(archive.DB, 'fixture-session')
        self.assertNotIn('generated_summary', checkpoint)
        self.assertNotIn('derived claim', evidence.render(checkpoint))
        expanded = evidence.latest_checkpoint(archive.DB, 'fixture-session', include_summary=True)
        self.assertEqual(expanded['generated_summary']['text'], 'derived claim')
        self.assertIn('derived', expanded['generated_summary']['origin'])

    def test_source_fallback_never_echoes_current_message(self):
        prompt = '还记得“预约”吗'
        self.write([row('old', 'user', '预约改成周三了'), row('new', 'user', prompt, 1)])
        archive.configure(self.payload)
        fallback = policy.original_dialogue_fallback(self.payload, prompt, '')
        self.assertIn('预约改成周三了', fallback)
        self.assertNotIn(prompt, fallback)

    def test_capsule_dedup_only_counts_hook_attachment_and_boundary(self):
        attachment = {'type': 'attachment', 'attachment': {'type': 'hook_additional_context', 'content': [policy.CONTINUITY_MARKER]}}
        self.write([row('fake', 'user', policy.CONTINUITY_MARKER)])
        self.assertFalse(recall.continuity_already_in_epoch(self.source))
        self.write([attachment], 'a')
        self.assertEqual(self.output(hook_event_name='SessionStart', source='resume'), {})
        self.assertEqual(self.calls, [])
        self.write([{'type': 'system', 'subtype': 'compact_boundary'}], 'a')
        self.assertIn(policy.CONTINUITY_MARKER, self.output(hook_event_name='SessionStart', source='compact')['hookSpecificOutput']['additionalContext'])

    def test_missing_backend_resume_uses_source_checkpoint(self):
        self.write([row('u1', 'user', 'a retained source quotation')])
        out = recall.build_hook_response({**self.payload, 'hook_event_name': 'SessionStart', 'source': 'resume'}, mcp=lambda *_: None)
        text = out['hookSpecificOutput']['additionalContext']
        self.assertIn('retained source quotation', text)
        self.assertIn(policy.CONTINUITY_MARKER, text)
        self.assertLessEqual(len(text), 6500)

    def test_large_file_tail_is_explicitly_partial(self):
        self.write([row('u' + str(n), 'user', 'test ' * 20, n % 60) for n in range(100)])
        archive.configure(self.payload)
        with patch.object(archive, 'READ_LIMIT', 3000):
            result = archive.sync_all(self.source)
        self.assertTrue(result['partial'])
        with evidence.connect(archive.DB, True) as con:
            self.assertLess(con.execute('select count(*) from messages').fetchone()[0], 100)

    def test_invalid_stdin_is_nonblocking(self):
        result = subprocess.run([sys.executable, str(HOOKS / 'memory_recall.py')], input='bad json', text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {})

    def test_dreams_are_not_direct_evidence(self):
        raw = MEMORY + '\n=== 梦境 ===\nfiction'
        self.assertNotIn('fiction', policy.targeted_recall(raw))
        self.assertNotIn('fiction', policy.lightweight_index(raw))


if __name__ == '__main__': unittest.main()
