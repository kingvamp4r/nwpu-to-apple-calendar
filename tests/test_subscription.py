from copy import deepcopy
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from subscription import fold, handler, occurrences, publish, reconcile


def snapshot():
    return {'semester': {'id': 1, 'startDate': '2026-08-31', 'weekStartOnSunday': False},
            'course': {'studentTableVm': {'activities': [{
                'lessonId': 7, 'courseName': '测试课程', 'weekday': 1,
                'weekIndexes': [1, 3], 'startTime': '8:30', 'endTime': '10:10',
                'room': 'A', 'teachers': ['教师甲']}]}}}


class SubscriptionTests(unittest.TestCase):
    def test_weeks_timezone_and_deduplication(self):
        value = snapshot()
        value['course']['studentTableVm']['activities'] *= 2
        rows = occurrences(value)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['data']['start'], '20260831T003000Z')
        self.assertEqual(rows[1]['data']['start'], '20260914T003000Z')

    def test_invalid_times_do_not_publish(self):
        value = snapshot()
        value['course']['studentTableVm']['activities'][0]['endTime'] = '07:00'
        with self.assertRaises(ValueError):
            occurrences(value)

    def test_move_and_room_change_keep_identity(self):
        incoming = occurrences(snapshot())
        old = reconcile([], incoming, '20260101T000000Z')
        moved = deepcopy(incoming)
        moved[0]['data'].update(start='20260901T003000Z', end='20260901T021000Z', location='B')
        new = reconcile(old, moved, '20260102T000000Z')
        by_uid = {r['uid']: r for r in new}
        original = next(r for r in old if r['group'] == moved[0]['group'])
        self.assertEqual(by_uid[original['uid']]['data'], moved[0]['data'])
        self.assertEqual(by_uid[original['uid']]['sequence'], 1)

    def test_cancel_and_restore_increment_sequence(self):
        incoming = occurrences(snapshot())
        old = reconcile([], incoming, '20260101T000000Z')
        cancelled = reconcile(old, [], '20260102T000000Z')
        self.assertTrue(all(r['status'] == 'CANCELLED' for r in cancelled))
        restored = reconcile(cancelled, incoming, '20260103T000000Z')
        self.assertEqual({r['uid'] for r in old}, {r['uid'] for r in restored})
        self.assertTrue(all(r['sequence'] == 2 for r in restored))

    def test_ambiguous_moves_cancel_and_add_without_dropping_events(self):
        one = occurrences(snapshot())[0]
        two = deepcopy(one)
        two['data'].update(start='20260901T003000Z', end='20260901T021000Z')
        old = reconcile([], [one, two], '20260101T000000Z')
        changed = deepcopy([one, two])
        for r in changed:
            r['data']['start'] = r['data']['start'].replace('003000', '013000')
            r['data']['end'] = r['data']['end'].replace('021000', '031000')
        new = reconcile(old, changed, '20260102T000000Z')
        self.assertEqual(sum(r['status'] == 'CONFIRMED' for r in new), 2)
        self.assertEqual(sum(r['status'] == 'CANCELLED' for r in new), 2)

    def test_identical_publish_preserves_bytes_and_mtime(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'snapshot.json'
            path.write_text(json.dumps(snapshot()))
            self.assertEqual(publish(root), 2)
            feed = root / 'calendar.ics'
            before = feed.read_bytes(), feed.stat().st_mtime_ns
            publish(root)
            self.assertEqual(before, (feed.read_bytes(), feed.stat().st_mtime_ns))
            value = snapshot()
            value['course']['studentTableVm']['activities'] = []
            path.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                publish(root)
            self.assertEqual(feed.read_bytes(), before[0])

    def test_utf8_folded_lines_are_at_most_75_bytes(self):
        lines = fold('SUMMARY:' + '中文测试' * 60).split('\r\n')
        self.assertTrue(all(len(line.encode()) <= 75 for line in lines))
        self.assertEqual(''.join(line.lstrip(' ') for line in lines), 'SUMMARY:' + '中文测试' * 60)

    def test_private_route_head_etag_and_no_directory_access(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'calendar.ics').write_bytes(b'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler(root, 'test-token'))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                for path in ('/', '/example.ics', '/data/session.json', '/../calendar.ics'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + path)
                    self.assertEqual(error.exception.code, 404)
                    error.exception.close()
                with urlopen(base + '/test-token.ics') as response:
                    etag = response.headers['ETag']
                    self.assertIn('text/calendar', response.headers['Content-Type'])
                with urlopen(Request(base + '/test-token.ics', method='HEAD')) as response:
                    self.assertEqual(response.read(), b'')
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + '/test-token.ics', headers={'If-None-Match': etag}))
                self.assertEqual(error.exception.code, 304)
                error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
