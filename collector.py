"""Session feasibility probe. Never exposes a public HTTP or browser debugging port."""
import argparse
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import signal
from datetime import datetime, timezone
from urllib.parse import urlparse

HOME = 'https://jwxt.nwpu.edu.cn/student/home'


def write_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def valid_data(kind, data):
    if not isinstance(data, dict):
        return False
    if kind == 'course':
        return isinstance(data.get('studentTableVm'), dict) and isinstance(
            data['studentTableVm'].get('activities'), list)
    return bool(data.get('id')) and bool(re.fullmatch(
        r'\d{4}-\d{2}-\d{2}', str(data.get('startDate', ''))))


def endpoint_kind(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname != 'jwxt.nwpu.edu.cn':
        return None
    if '/student/for-std/course-table/semester/' in parsed.path and '/print-data/' in parsed.path:
        return 'course'
    if re.fullmatch(r'/student/ws/semester/get/\d+', parsed.path):
        return 'semester'
    return None


def fingerprint(course, semester):
    # Ignore response ordering, but retain all activity fields until real samples
    # establish which fields are volatile and which identify a course occurrence.
    activities = sorted(json.dumps(x, sort_keys=True, ensure_ascii=False)
                        for x in course['studentTableVm']['activities'])
    value = {'activities': activities, 'semester': semester}
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


async def connect_browser(playwright, directory):
    """Use the installed browser's normal startup and private persistent profile.

    Remote debugging is loopback-only and is never forwarded through Tunnel.
    A real display or xvfb-run is required, including for scheduled checks.
    """
    executable = shutil.which('chromium')
    if not executable:
        raise RuntimeError('chromium_missing')
    profile = directory / 'browser-profile'
    profile.mkdir(mode=0o700, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    process = subprocess.Popen([
        executable, f'--user-data-dir={profile}',
        '--remote-debugging-address=127.0.0.1',
        f'--remote-debugging-port={port}', '--no-first-run',
        '--no-default-browser-check', 'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    try:
        for _ in range(30):
            if process.poll() is not None:
                raise RuntimeError('browser_start_failed')
            try:
                browser = await playwright.chromium.connect_over_cdp(
                    f'http://127.0.0.1:{port}', timeout=1500)
                return browser, process
            except Exception:
                await asyncio.sleep(1)
        raise RuntimeError('browser_start_timeout')
    except BaseException:
        await stop_browser(None, process)
        raise


async def stop_browser(browser, process):
    if browser:
        try:
            session = await browser.new_browser_cdp_session()
            await session.send('Browser.close')
        except Exception:
            pass
    if process:
        try:
            await asyncio.to_thread(process.wait, timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                await asyncio.to_thread(process.wait, timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                await asyncio.to_thread(process.wait)
            except ProcessLookupError:
                pass


async def run(args, directory):
    from playwright.async_api import async_playwright

    status_path = directory / 'status.json'
    previous = json.loads(status_path.read_text()) if status_path.exists() else {}
    now = datetime.now(timezone.utc).isoformat()
    status = {**previous, 'last_attempt': now}
    captured, endpoints = {}, {}
    document_status = None
    tasks = set()
    async with async_playwright() as p:
        browser = None
        process = None
        try:
            browser, process = await connect_browser(p, directory)
            state = directory / 'session.json'
            context = browser.contexts[0]
            # Chromium does not necessarily persist session cookies on exit.
            # Restore the last successful context snapshot before navigation.
            if state.exists():
                saved_state = json.loads(state.read_text())
                await context.add_cookies(saved_state.get('cookies', []))

            async def capture(response):
                kind = endpoint_kind(response.url)
                if kind and response.ok:
                    try:
                        data = await response.json()
                        if valid_data(kind, data):
                            captured[kind] = data
                            endpoints[kind] = response.url
                    except Exception:
                        pass

            def on_response(response):
                nonlocal document_status
                if (response.request.is_navigation_request()
                        and response.frame == page.main_frame):
                    document_status = response.status
                task = asyncio.create_task(capture(response))
                tasks.add(task)
                task.add_done_callback(tasks.discard)

            page = context.pages[0] if context.pages else await context.new_page()
            context.on('response', on_response)
            await page.goto(HOME, wait_until='domcontentloaded', timeout=60000)
            if args.command == 'login':
                print('请完成验证码登录并打开本学期课表；采集成功后浏览器会自动关闭，最长等待 10 分钟。', flush=True)
                for elapsed in range(600):
                    if len(captured) == 2:
                        break
                    # A challenge may initially return 412 and then redirect.
                    # Only flag a persistent error after allowing it to finish.
                    if elapsed >= 15 and document_status in (400, 403, 412, 429):
                        if not (await page.locator('body').inner_text()).strip():
                            raise RuntimeError('school_access_blocked')
                    await page.wait_for_timeout(1000)
            else:
                saved = directory / 'endpoints.json'
                if not saved.exists():
                    raise RuntimeError('missing_endpoints')
                urls = json.loads(saved.read_text())
                # Let the normal page complete its initial access checks.
                await page.wait_for_timeout(3000)
                # Fetch inside the real page, preserving browser headers and
                # cookie handling instead of a separate HTTP client's identity.
                for kind in ('course', 'semester'):
                    url = urls.get(kind, '')
                    if endpoint_kind(url) != kind:
                        raise RuntimeError('invalid_endpoint')
                    response = await page.evaluate('''async url => {
                        const response = await fetch(url, {
                            credentials: 'include',
                            signal: AbortSignal.timeout(60000)
                        });
                        let data = null;
                        try { data = await response.json(); } catch {}
                        return {status: response.status, ok: response.ok, data};
                    }''', url)
                    if response['status'] in (401, 403):
                        raise RuntimeError('authentication_required')
                    data = response['data']
                    if data is None:
                        raise RuntimeError('unexpected_response') from None
                    if not response['ok'] or not valid_data(kind, data):
                        raise RuntimeError('invalid_response')
                    captured[kind] = data
                    endpoints[kind] = url

            if len(captured) != 2:
                raise RuntimeError('capture_timeout')
            digest = fingerprint(captured['course'], captured['semester'])
            completed = datetime.now(timezone.utc).isoformat()
            # Only publish a snapshot after both responses passed validation.
            write_json(directory / 'snapshot.json', {**captured, 'captured_at': completed})
            write_json(directory / 'endpoints.json', endpoints)
            write_json(state, await context.storage_state(indexed_db=True))
            status.update(state='ok', last_success=completed, fingerprint=digest,
                          changed=digest != previous.get('fingerprint'), error=None)
            if args.command == 'login':
                status['last_login'] = completed
            print('采集成功；课表有变化。' if status['changed'] else '采集成功；课表无变化。')
        except Exception as exc:
            # Exception strings may contain sensitive URLs or response bodies.
            allowed = {'missing_endpoints', 'invalid_endpoint', 'authentication_required',
                       'unexpected_response', 'invalid_response', 'capture_timeout',
                       'school_access_blocked', 'chromium_missing',
                       'browser_start_failed', 'browser_start_timeout'}
            code = str(exc) if str(exc) in allowed else type(exc).__name__
            status.update(state='check_failed', error=code)
            print(f'采集失败：{code}。保留上次成功数据；请检查网络或重新登录。')
            return 1
        finally:
            write_json(status_path, status)
            await stop_browser(browser, process)
    return 0


def main():
    parser = argparse.ArgumentParser(description='NWPU 登录会话与每日课表采集验证')
    parser.add_argument('command', choices=['login', 'check', 'status'])
    parser.add_argument('--data-dir', type=Path, default=Path('data'))
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.data_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    if args.command == 'status':
        path = directory / 'status.json'
        print(path.read_text() if path.exists() else '尚无采集记录。')
        return 0
    with (directory / 'collector.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('已有采集或登录进程运行，请稍后重试。')
            return 1
        return asyncio.run(run(args, directory))


if __name__ == '__main__':
    raise SystemExit(main())
