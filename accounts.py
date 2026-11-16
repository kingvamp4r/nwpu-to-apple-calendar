"""Invite-only users and devices. Administration is local CLI only."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
import uuid


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Accounts:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.root / 'accounts.sqlite3'
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                    course_token TEXT UNIQUE NOT NULL, exam_token TEXT UNIQUE NOT NULL,
                    legacy INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1, last_upload REAL);
                CREATE TABLE IF NOT EXISTS pairs (
                    code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    expires REAL NOT NULL, consumed INTEGER NOT NULL DEFAULT 0);
            ''')
        self.path.chmod(0o600)

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def migrate(self):
        path = self.root / 'subscription.json'
        if not path.exists():
            return
        config = json.loads(path.read_text())
        with self.db() as db:
            if db.execute('SELECT 1 FROM users WHERE id=?', ('owner',)).fetchone():
                return
            db.execute('INSERT INTO users(id,label,course_token,exam_token,legacy) VALUES(?,?,?,?,1)',
                       ('owner', '原有个人账户', config['token'], config['exam_token']))
            if config.get('upload_token'):
                db.execute('INSERT INTO devices(id,user_id,label,token_hash) VALUES(?,?,?,?)',
                           ('owner-original-device', 'owner', '原有插件', digest(config['upload_token'])))

    def create(self, label):
        uid = uuid.uuid4().hex
        with self.db() as db:
            db.execute('INSERT INTO users(id,label,course_token,exam_token) VALUES(?,?,?,?)',
                       (uid, label[:80], secrets.token_urlsafe(32), secrets.token_urlsafe(32)))
        return uid

    def invitation(self, uid):
        code = secrets.token_urlsafe(24)
        with self.db() as db:
            if not db.execute('SELECT 1 FROM users WHERE id=? AND enabled=1', (uid,)).fetchone():
                raise ValueError('Unknown or disabled user')
            db.execute('INSERT INTO pairs(code_hash,user_id,expires) VALUES(?,?,?)',
                       (digest(code), uid, time.time() + 600))
        return code

    def pair(self, code, label):
        if not isinstance(code, str) or not 20 <= len(code) <= 100:
            raise ValueError('Invalid pairing code')
        token, device_id = secrets.token_urlsafe(32), uuid.uuid4().hex
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('''SELECT p.*,u.course_token,u.exam_token FROM pairs p
                JOIN users u ON u.id=p.user_id WHERE p.code_hash=? AND p.consumed=0
                AND p.expires>? AND u.enabled=1''', (digest(code), time.time())).fetchone()
            if not row:
                raise ValueError('Expired or used pairing code')
            db.execute('UPDATE pairs SET consumed=1 WHERE code_hash=?', (digest(code),))
            db.execute('INSERT INTO devices(id,user_id,label,token_hash) VALUES(?,?,?,?)',
                       (device_id, row['user_id'], str(label or '浏览器')[:80], digest(token)))
            return {'uploadToken': token, 'deviceId': device_id,
                    'coursePath': '/' + row['course_token'] + '.ics',
                    'examPath': '/' + row['exam_token'] + '.ics'}

    def upload_user(self, token):
        if not isinstance(token, str) or not 32 <= len(token) <= 200:
            return None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('''SELECT u.*,d.id AS device_id,d.last_upload FROM devices d
                JOIN users u ON u.id=d.user_id WHERE d.token_hash=? AND d.enabled=1
                AND u.enabled=1''', (digest(token),)).fetchone()
            if not row:
                return None
            if row['last_upload'] and time.time() - row['last_upload'] < .5:
                raise ValueError('rate_limit')
            db.execute('UPDATE devices SET last_upload=? WHERE id=?', (time.time(), row['device_id']))
            return self.directory(row)

    def directory(self, user):
        root = self.root if user['legacy'] else self.root / 'users' / user['id']
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        return root

    def feed(self, token):
        with self.db() as db:
            row = db.execute('SELECT * FROM users WHERE enabled=1 AND (course_token=? OR exam_token=?)',
                             (token, token)).fetchone()
            if not row:
                return None
            root = self.directory(row)
            return root / ('calendar.ics' if token == row['course_token'] else 'exams/calendar.ics')

    def disable(self, kind, identifier):
        if kind not in ('users', 'devices'):
            raise ValueError('Invalid kind')
        with self.db() as db:
            cursor = db.execute(f'UPDATE {kind} SET enabled=0 WHERE id=?', (identifier,))
            if cursor.rowcount != 1:
                raise ValueError('Unknown identifier')


def main():
    parser = argparse.ArgumentParser(description='本地管理用户、设备及十分钟一次性配对码')
    parser.add_argument('command', choices=['create-user', 'pair-device', 'list', 'disable-user', 'revoke-device'])
    parser.add_argument('value', nargs='?')
    parser.add_argument('--data-dir', type=Path, default=Path('data'))
    args = parser.parse_args()
    os.umask(0o077)
    accounts = Accounts(args.data_dir)
    accounts.migrate()
    if args.command in ('create-user', 'pair-device'):
        if not args.value:
            parser.error('需要用户备注或 user_id')
        uid = accounts.create(args.value) if args.command == 'create-user' else args.value
        print(json.dumps({'user_id': uid, 'pairing_code': accounts.invitation(uid),
                          'expires_in_seconds': 600}, ensure_ascii=False))
    elif args.command == 'list':
        with accounts.db() as db:
            for table, columns in [('users', 'id,label,enabled'), ('devices', 'id,user_id,label,enabled,last_upload')]:
                print(table, json.dumps([dict(r) for r in db.execute(f'SELECT {columns} FROM {table}')], ensure_ascii=False))
    else:
        if not args.value:
            parser.error('需要用户或设备 ID')
        accounts.disable('users' if args.command == 'disable-user' else 'devices', args.value)
        print('已停用。')


if __name__ == '__main__':
    main()
