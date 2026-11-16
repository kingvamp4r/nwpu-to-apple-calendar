import tempfile
import unittest
from pathlib import Path

from collector import endpoint_kind, fingerprint, valid_data, write_json


class CollectorTests(unittest.TestCase):
    def test_only_school_https_endpoints(self):
        path = '/student/ws/semester/get/123'
        self.assertEqual(endpoint_kind('https://jwxt.nwpu.edu.cn' + path), 'semester')
        self.assertIsNone(endpoint_kind('https://evil.example' + path))
        self.assertIsNone(endpoint_kind('http://jwxt.nwpu.edu.cn' + path))

    def test_login_or_error_payload_rejected(self):
        for value in (None, [], {'message': '登录失效'}, {'studentTableVm': {}}):
            self.assertFalse(valid_data('course', value))
        self.assertFalse(valid_data('semester', {'id': 1, 'startDate': 'bad'}))

    def test_reordering_does_not_trigger_change_but_room_change_does(self):
        semester = {'id': 1, 'startDate': '2026-09-01'}
        a, b = {'lessonId': 1, 'room': 'A'}, {'lessonId': 2, 'room': 'B'}
        def digest(rows):
            return fingerprint({'studentTableVm': {'activities': rows}}, semester)
        self.assertEqual(digest([a, b]), digest([b, a]))
        self.assertNotEqual(digest([a]), digest([{**a, 'room': 'C'}]))

    def test_atomic_private_json(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'snapshot.json'
            write_json(path, {'value': 1})
            write_json(path, {'value': 2})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertIn('2', path.read_text())
            self.assertFalse(path.with_suffix('.tmp').exists())


if __name__ == '__main__':
    unittest.main()
