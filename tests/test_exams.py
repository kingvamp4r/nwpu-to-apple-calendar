import json
from pathlib import Path
import tempfile
import unittest
from subscription import publish_exams

class ExamTests(unittest.TestCase):
    def test_exam_move_preserves_uid_and_absence_does_not_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            row={'name':'测试课程','type':'期末','date':'2026-11-29','start':'18:30','end':'20:30','location':'A'}
            publish_exams(root,[row])
            path=root/'exams/events.json'
            original=json.loads(path.read_text())[0]
            publish_exams(root,[{**row,'date':'2026-11-30','location':'B'}])
            moved=json.loads(path.read_text())[0]
            self.assertEqual(original['uid'],moved['uid'])
            self.assertEqual(moved['sequence'],1)
            publish_exams(root,[{**row,'name':'另一门课程'}])
            self.assertTrue(all(x['status']=='CONFIRMED' for x in json.loads(path.read_text())))
    def test_invalid_exam_retains_feed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            row={'name':'测试','type':'期末','date':'2026-11-29','start':'18:30','end':'20:30'}
            publish_exams(root,[row]);path=root/'exams/calendar.ics';before=path.read_bytes()
            with self.assertRaises((ValueError,KeyError)):
                publish_exams(root,[{**row,'end':''}])
            self.assertEqual(before,path.read_bytes())
