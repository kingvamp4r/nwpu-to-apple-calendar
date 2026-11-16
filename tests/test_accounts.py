import concurrent.futures
import json
from pathlib import Path
import tempfile
import time
import unittest
from accounts import Accounts
from subscription import handler
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError
import threading

class AccountsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve();self.a=Accounts(self.root)
    def tearDown(self):self.tmp.cleanup()
    def user(self,label):
        uid=self.a.create(label);credentials=self.a.pair(self.a.invitation(uid),'device');return uid,credentials
    def test_single_use_expiry_and_concurrent_redemption(self):
        uid=self.a.create('user');code=self.a.invitation(uid)
        def claim():
            try:return self.a.pair(code,'test')
            except ValueError:return None
        with concurrent.futures.ThreadPoolExecutor(2) as pool:results=list(pool.map(lambda _:claim(),range(2)))
        self.assertEqual(sum(x is not None for x in results),1)
        code=self.a.invitation(uid)
        with self.a.db() as db:db.execute('UPDATE pairs SET expires=0')
        with self.assertRaises(ValueError):self.a.pair(code,'expired')
    def test_devices_share_user_feeds_and_revoke_independently(self):
        uid,first=self.user('one');second=self.a.pair(self.a.invitation(uid),'two')
        self.assertEqual(first['coursePath'],second['coursePath'])
        self.assertNotEqual(first['uploadToken'],second['uploadToken'])
        self.a.disable('devices',first['deviceId'])
        self.assertIsNone(self.a.upload_user(first['uploadToken']))
        self.assertIsNotNone(self.a.upload_user(second['uploadToken']))
        self.assertIsNotNone(self.a.feed(first['coursePath'][1:-4]))
    def test_user_isolation_and_disabled_user(self):
        u1,c1=self.user('one');u2,c2=self.user('two')
        self.assertNotEqual(self.a.upload_user(c1['uploadToken']),self.a.upload_user(c2['uploadToken']))
        self.assertIsNone(self.a.upload_user(c1['coursePath'][1:-4]))
        self.a.disable('users',u1)
        self.assertIsNone(self.a.feed(c1['coursePath'][1:-4]))
        self.assertIsNone(self.a.upload_user(c1['uploadToken']))
        self.assertIsNotNone(self.a.feed(c2['coursePath'][1:-4]))
    def test_legacy_migration_preserves_urls_files_and_revocation(self):
        config={'token':'a'*43,'exam_token':'b'*43,'upload_token':'c'*43}
        (self.root/'subscription.json').write_text(json.dumps(config))
        self.a.migrate();self.a.migrate()
        self.assertEqual(self.a.feed(config['token']),self.root/'calendar.ics')
        self.assertEqual(self.a.upload_user(config['upload_token']),self.root)
        self.a.disable('users','owner');self.a.migrate()
        self.assertIsNone(self.a.feed(config['token']))
    def test_http_does_not_trust_payload_user_id(self):
        u1,c1=self.user('one');u2,c2=self.user('two')
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.root,'unused'))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base=f'http://127.0.0.1:{server.server_port}'
        payload={'kind':'exams','user_id':u2,'exams':[{'name':'Only One','type':'期末','date':'2026-11-29','start':'18:30','end':'20:30'}]}
        try:
            request=Request(base+'/api/upload',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+c1['uploadToken'],'Content-Type':'application/json'})
            with urlopen(request) as r:self.assertEqual(r.status,200)
            self.assertTrue((self.root/'users'/u1/'exams/calendar.ics').exists())
            self.assertFalse((self.root/'users'/u2/'exams/calendar.ics').exists())
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(base+'/api/upload',data=b'{}',headers={'Authorization':'Bearer '+c1['examPath'][1:-4]}))
            self.assertEqual(error.exception.code,403);error.exception.close()
            with urlopen(base+c1['examPath']) as r:self.assertIn(b'Only One',r.read())
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()

class PrivacyTests(unittest.TestCase):
    def test_student_metadata_is_not_persisted(self):
        from subscription import calendar_payload
        from test_subscription import snapshot
        payload=snapshot()
        payload['course']['studentTableVm']['student']={'number':'private-number'}
        payload['course']['cookie']='private-cookie'
        payload['semester']['internalStudent']='private-student'
        clean=calendar_payload(payload)
        value=json.dumps(clean)
        self.assertNotIn('private-',value)
        self.assertEqual(clean['course']['studentTableVm']['activities'][0]['lessonId'],7)
