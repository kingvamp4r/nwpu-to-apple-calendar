"""Private, read-only iCalendar feed. Only this handler is exposed by Tunnel."""
import argparse
from collections import defaultdict
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from email.utils import formatdate
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import uuid
import threading
import time

from accounts import Accounts
from zoneinfo import ZoneInfo

from collector import write_json


def entity(value):
    if isinstance(value, list):
        return '、'.join(filter(None, map(entity, value)))
    if isinstance(value, dict):
        return str(next((value[k] for k in ('nameZh', 'name', 'nameEn',
                        'fullName', 'teacherName') if value.get(k)), ''))
    return '' if value is None else str(value).strip()


def escape(value):
    return str(value).replace('\\', '\\\\').replace('\r\n', '\n').replace(
        '\r', '\n').replace('\n', '\\n').replace(';', '\\;').replace(',', '\\,')


def fold(line):
    result, current = [], ''
    for char in line:
        if len((current + char).encode()) > 75:
            result.append(current)
            current = ' '
        current += char
    result.append(current)
    return '\r\n'.join(result)


def timestamp(value):
    return value.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def occurrence_time(day, value):
    value = str(value).strip()
    if ':' not in value and value.isdigit() and len(value) in (3, 4):
        value = value[:-2] + ':' + value[-2:]
    clock = datetime.strptime(value, '%H:%M').time()
    return timestamp(datetime.combine(day, clock, ZoneInfo('Asia/Shanghai')))


def occurrences(snapshot):
    semester = snapshot['semester']
    if semester.get('weekStartOnSunday') is True:
        raise ValueError('Sunday-first semester is not supported')
    start = date.fromisoformat(semester['startDate'])
    if start.weekday() != 0:
        raise ValueError('Semester must start on Monday; verify teaching week definition')
    semester_id = str(semester['id'])
    activities = snapshot['course']['studentTableVm']['activities']
    if not isinstance(activities, list):
        raise ValueError('Invalid activities')
    output, seen = [], set()
    for item in activities:
        lesson = item.get('lessonId') or item.get('lessonCode')
        weeks = item.get('weekIndexes')
        weekday = int(item['weekday'])
        if not lesson or not isinstance(weeks, list) or not 1 <= weekday <= 7:
            raise ValueError('Incomplete activity identity or weeks')
        location = ' · '.join(dict.fromkeys(filter(None, (
            entity(item.get(k)) for k in ('campus', 'building', 'room')))))
        description = []
        for label, key in (('教师', 'teachers'), ('课程代码', 'courseCode'),
                           ('课程类型', 'courseType'), ('备注', 'lessonRemark')):
            if entity(item.get(key)):
                description.append(f'{label}：{entity(item[key])}')
        if item.get('startUnit') and item.get('endUnit'):
            description.append(f'节次：第 {item["startUnit"]}–{item["endUnit"]} 节')
        for week in weeks:
            if isinstance(week, bool) or int(week) != week or not 1 <= week <= 60:
                raise ValueError('Invalid teaching week')
            day = start + timedelta(days=7 * (week - 1) + weekday - 1)
            data = {
                'start': occurrence_time(day, item['startTime']),
                'end': occurrence_time(day, item['endTime']),
                'summary': entity(item.get('courseName') or item.get('lessonName') or '课程'),
                'location': location,
                'description': '\n'.join(description + [f'教学周：第 {week} 周']),
            }
            if data['end'] <= data['start']:
                raise ValueError('Course must end after it starts')
            record = {'group': f'{semester_id}:{lesson}:{week}', 'data': data}
            key = json.dumps(record, sort_keys=True, ensure_ascii=False)
            if key not in seen:
                seen.add(key)
                output.append(record)
    return sorted(output, key=lambda r: (r['group'], r['data']['start'],
                                         json.dumps(r['data'], sort_keys=True)))


def reconcile(old, incoming, now):
    """Preserve identity on exact matches, location changes, and unique moves.

    The school provides no per-occurrence ID. Ambiguous multi-event moves use
    cancellation plus addition instead of guessing the original occurrence.
    """
    remaining = deepcopy(old)
    result = []
    pending = []

    def take(record, candidates):
        previous = candidates[0]
        remaining.remove(previous)
        changed = previous['data'] != record['data'] or previous['status'] != 'CONFIRMED'
        result.append({**previous, **record, 'status': 'CONFIRMED',
                       'sequence': previous['sequence'] + int(changed),
                       'stamp': now if changed else previous['stamp']})

    # Finish ALL exact matches before assigning any potentially moved event.
    for record in incoming:
        matches = [r for r in remaining if r['group'] == record['group']
                   and r['data'] == record['data']]
        matches.sort(key=lambda r: r['status'] != 'CONFIRMED')
        if matches:
            take(record, matches)
        else:
            pending.append(record)
    unmatched = []
    for record in pending:
        matches = [r for r in remaining if r['group'] == record['group']
                   and r['status'] == 'CONFIRMED'
                   and (r['data']['start'], r['data']['end']) ==
                   (record['data']['start'], record['data']['end'])]
        if len(matches) == 1:
            take(record, matches)
        else:
            unmatched.append(record)
    groups = defaultdict(list)
    for record in unmatched:
        groups[record['group']].append(record)
    for group, records in groups.items():
        matches = [r for r in remaining if r['group'] == group and r['status'] == 'CONFIRMED']
        if len(matches) == len(records) == 1:
            take(records[0], matches)
        else:
            for record in records:
                result.append({**record, 'uid': f'{uuid.uuid4()}@nwpu-calendar',
                               'sequence': 0, 'stamp': now, 'status': 'CONFIRMED'})
    for previous in remaining:
        if previous['status'] != 'CANCELLED':
            previous.update(status='CANCELLED', sequence=previous['sequence'] + 1, stamp=now)
        result.append(previous)
    return sorted(result, key=lambda r: r['uid'])


def render(records, name):
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0',
             'PRODID:-//NWPU Calendar//Subscription//CN', 'CALSCALE:GREGORIAN',
             f'X-WR-CALNAME:{escape(name)}', 'X-WR-TIMEZONE:Asia/Shanghai',
             'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H']
    for record in records:
        data = record['data']
        lines.extend(['BEGIN:VEVENT', f'UID:{record["uid"]}',
                      f'DTSTAMP:{record["stamp"]}', f'LAST-MODIFIED:{record["stamp"]}',
                      f'SEQUENCE:{record["sequence"]}', f'DTSTART:{data["start"]}',
                      f'DTEND:{data["end"]}', f'SUMMARY:{escape(data["summary"])}',
                      f'LOCATION:{escape(data["location"])}',
                      f'DESCRIPTION:{escape(data["description"])}',
                      f'STATUS:{record["status"]}', 'TRANSP:OPAQUE', 'END:VEVENT'])
    lines.append('END:VCALENDAR')
    return ('\r\n'.join(map(fold, lines)) + '\r\n').encode()


def publish(directory):
    with (directory / 'publisher.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        snapshot = json.loads((directory / 'snapshot.json').read_text())
        registry_path = directory / 'events.json'
        previous = json.loads(registry_path.read_text()) if registry_path.exists() else []
        incoming = occurrences(snapshot)
        # A transient empty response must never cancel the entire timetable.
        if previous and not incoming:
            raise ValueError('Empty timetable requires manual review; previous feed retained')
        records = reconcile(previous, incoming, timestamp(datetime.now(timezone.utc)))
        name = 'NWPU 课表 · ' + entity(snapshot['semester'].get('nameZh') or '当前学期')
        body = render(records, name)
        feed = directory / 'calendar.ics'
        # Registry first allows deterministic recovery if interrupted before feed swap.
        write_json(registry_path, records)
        if not feed.exists() or feed.read_bytes() != body:
            temp = directory / 'calendar.ics.tmp'
            temp.write_bytes(body)
            temp.chmod(0o600)
            temp.replace(feed)
        return sum(r['status'] == 'CONFIRMED' for r in records)


def publish_exams(directory, rows):
    if not isinstance(rows, list) or not rows or len(rows) > 500:
        raise ValueError('Invalid examination list')
    incoming = []
    for row in rows:
        day = date.fromisoformat(row['date'])
        name, kind = str(row['name']).strip(), str(row['type']).strip()
        if not name or len(name) > 300:
            raise ValueError('Invalid examination name')
        data = {'start': occurrence_time(day, row['start']),
                'end': occurrence_time(day, row['end']),
                'summary': f'{kind}考试 · {name}',
                'location': str(row.get('location', ''))[:500],
                'description': '来源：教务系统考试安排'}
        if data['end'] <= data['start']:
            raise ValueError('Invalid examination duration')
        year = day.year if day.month >= 8 else day.year - 1
        incoming.append({'group': f'exam:{year}:{name}:{kind}', 'data': data})
    incoming = list({json.dumps(row, sort_keys=True): row for row in incoming}.values())
    root = directory / 'exams'
    root.mkdir(mode=0o700, exist_ok=True)
    with (root / 'publisher.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / 'events.json'
        old = json.loads(path.read_text()) if path.exists() else []
        records = reconcile(old, incoming, timestamp(datetime.now(timezone.utc)))
        # HTML listings do not provide stable IDs or guaranteed complete scope.
        # Retain absent entries; never interpret omission as cancellation.
        active_groups = {r['group'] for r in incoming}
        for record in records:
            if record['group'] not in active_groups:
                previous = next((r for r in old if r['uid'] == record['uid']), None)
                if previous:
                    record.update(previous)
        body = render(records, 'NWPU 考试安排')
        write_json(path, records)
        feed = root / 'calendar.ics'
        if not feed.exists() or feed.read_bytes() != body:
            temp = root / 'calendar.ics.tmp'
            temp.write_bytes(body)
            temp.chmod(0o600)
            temp.replace(feed)
        write_json(root / 'status.json', {'last_upload': datetime.now(timezone.utc).isoformat(),
                                         'received': len(rows)})
    return len(incoming)


def calendar_payload(payload):
    """Persist only fields used by calendar generation, never student/account metadata."""
    raw = payload['course']['studentTableVm']['activities']
    if not isinstance(raw, list) or len(raw) > 500:
        raise ValueError('Invalid activities')
    fields = ('lessonId', 'lessonCode', 'courseName', 'lessonName', 'courseCode',
              'weekIndexes', 'weekday', 'startUnit', 'endUnit', 'startTime', 'endTime')
    activities = []
    for item in raw:
        activity = {key: item[key] for key in fields if key in item}
        for key in ('room', 'building', 'campus', 'teachers', 'courseType', 'lessonRemark'):
            activity[key] = entity(item.get(key))[:1000]
        activities.append(activity)
    semester = payload['semester']
    return {'course': {'studentTableVm': {'activities': activities}},
            'semester': {key: semester[key] for key in
                         ('id', 'nameZh', 'name', 'startDate', 'weekStartOnSunday') if key in semester}}


def handler(directory, token):
    accounts = None
    if (directory / 'subscription.json').exists() or (directory / 'accounts.sqlite3').exists():
        accounts = Accounts(directory)
        accounts.migrate()
    pairing_attempts = []
    pairing_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Request paths contain the bearer token.

        def do_POST(self):
            target = None
            if self.path == '/api/pair':
                with pairing_lock:
                    now = time.monotonic()
                    pairing_attempts[:] = [t for t in pairing_attempts if now - t < 60]
                    if len(pairing_attempts) >= 30:
                        self.send_error(429)
                        return
                    pairing_attempts.append(now)
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not accounts or not 0 < length <= 4096:
                        raise ValueError('Invalid request')
                    self.connection.settimeout(15)
                    request = json.loads(self.rfile.read(length))
                    paired = accounts.pair(request['code'], request.get('deviceName', '浏览器'))
                except (ValueError, KeyError, TypeError, AttributeError, OSError):
                    self.send_error(400)
                    return
                self.respond_json({'ok': True, **paired})
                return
            supplied = self.headers.get('Authorization', '')
            try:
                if self.path == '/api/upload' and accounts and supplied.startswith('Bearer '):
                    target = accounts.upload_user(supplied[7:])
            except ValueError:
                self.send_error(429)
                return
            if target is None:
                self.send_error(403)
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 2_000_000:
                    raise ValueError('Invalid size')
                self.connection.settimeout(15)
                payload = json.loads(self.rfile.read(length))
                if payload['kind'] == 'exams':
                    count = publish_exams(target, payload['exams'])
                elif payload['kind'] == 'course':
                    from collector import valid_data
                    if len(payload['course'].get('studentTableVm', {}).get('activities', [])) > 500:
                        raise ValueError('Too many activities')
                    if not all(valid_data(k, payload[k]) for k in ('course', 'semester')):
                        raise ValueError('Invalid timetable')
                    payload = {'kind': 'course', **calendar_payload(payload)}
                    # Share the collector lock; browser uploads cannot race daily collection.
                    with (target / 'collector.lock').open('w') as lock:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        incoming = occurrences(payload)
                        if len(incoming) > 20000:
                            raise ValueError('Too many events')
                        if not incoming:
                            raise ValueError('Empty timetable requires review')
                        write_json(target / 'snapshot.json', {'course': payload['course'], 'semester': payload['semester']})
                        count = publish(target)
                else:
                    raise ValueError('Unknown kind')
            except (ValueError, KeyError, TypeError, AttributeError, BlockingIOError, OSError):
                self.send_error(400)
                return
            write_json(target / 'upload-status.json', {
                'last_upload': datetime.now(timezone.utc).isoformat(), 'kind': payload['kind'], 'count': count})
            self.respond_json({'ok': True, 'count': count,
                               'updated_at': datetime.now(timezone.utc).isoformat()})

        def respond_json(self, value):
            body = json.dumps(value).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET(head=True)

        def do_GET(self, head=False):
            if self.path == '/client.user.js' or hmac.compare_digest(self.path.encode(), f'/{token}.user.js'.encode()):
                source = Path(__file__).with_name('nwpu-to-apple-calendar.user.js').read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'private, no-store')
                self.send_header('Content-Length', str(len(source)))
                self.end_headers()
                if not head:
                    self.wfile.write(source)
                return
            if accounts:
                route = self.path[1:-4] if self.path.startswith('/') and self.path.endswith('.ics') else ''
                feed = accounts.feed(route) if route else None
                if feed is None:
                    self.send_error(404)
                    return
            else:
                if not hmac.compare_digest(self.path.encode(), f'/{token}.ics'.encode()):
                    self.send_error(404)
                    return
                feed = directory / 'calendar.ics'
            try:
                with feed.open('rb') as source:
                    body = source.read()
                    modified = os.fstat(source.fileno()).st_mtime
            except FileNotFoundError:
                self.send_error(503)
                return
            etag = '"' + hashlib.sha256(body).hexdigest() + '"'
            cached = self.headers.get('If-None-Match') == etag
            self.send_response(304 if cached else 200)
            self.send_header('ETag', etag)
            self.send_header('Last-Modified', formatdate(modified, usegmt=True))
            self.send_header('Cache-Control', 'private, no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            if not cached:
                self.send_header('Content-Type', 'text/calendar; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head and not cached:
                self.wfile.write(body)
    return Handler


def main():
    parser = argparse.ArgumentParser(description='Private NWPU ICS subscription')
    parser.add_argument('command', choices=['publish', 'init', 'serve'])
    parser.add_argument('--data-dir', type=Path, default=Path('data'))
    parser.add_argument('--port', type=int, default=8791)
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.data_dir.resolve()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.command == 'publish':
        print(f'已发布 {publish(directory)} 个有效课程事件。')
        return
    config = directory / 'subscription.json'
    if args.command == 'init':
        if not config.exists():
            write_json(config, {'token': secrets.token_urlsafe(32)})
        settings = json.loads(config.read_text())
        for key in ('exam_token', 'upload_token'):
            settings.setdefault(key, secrets.token_urlsafe(32))
        write_json(config, settings)
        print('订阅凭证已准备，保存在私有 data/subscription.json。')
        return
    token = json.loads(config.read_text())['token']
    if not isinstance(token, str) or len(token) < 32 or not token.isascii():
        raise ValueError('Invalid subscription token')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler(directory, token))
    print(f'ICS service listening on 127.0.0.1:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
