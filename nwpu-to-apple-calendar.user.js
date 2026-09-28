// ==UserScript==
// @name         NWPU → Apple Calendar
// @namespace    https://jwxt.nwpu.edu.cn/
// @version      1.0.1
// @description  将西北工业大学新版教务系统课表导出为 Apple Calendar ICS
// @author       kv (kingvamp4r)
// @license      MIT
// @homepageURL  https://github.com/kingvamp4r/nwpu-to-apple-calendar
// @supportURL   https://github.com/kingvamp4r/nwpu-to-apple-calendar/issues
// @downloadURL  https://raw.githubusercontent.com/kingvamp4r/nwpu-to-apple-calendar/main/nwpu-to-apple-calendar.user.js
// @updateURL    https://raw.githubusercontent.com/kingvamp4r/nwpu-to-apple-calendar/main/nwpu-to-apple-calendar.user.js
// @match        https://jwxt.nwpu.edu.cn/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const CHANNEL = 'NWPU_CALENDAR_V1';
    const isTop = window === window.top;

    if (!isTop) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            try {
                this.__nwpuUrl = new URL(url, location.href).href;
            } catch {
                this.__nwpuUrl = String(url);
            }

            return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function (...args) {
            const xhr = this;

            xhr.addEventListener('load', () => {
                const url = xhr.__nwpuUrl || '';

                const isCourse = url.includes('/print-data/');
                const isSemester = /\/ws\/semester\/get\/\d+/.test(url);

                if (!isCourse && !isSemester) return;

                try {
                    let data;

                    if (xhr.responseType === 'json') {
                        data = xhr.response;
                    } else {
                        data = JSON.parse(xhr.responseText);
                    }

                    window.top.postMessage({
                        channel: CHANNEL,
                        type: isCourse ? 'course' : 'semester',
                        data
                    }, location.origin);
                } catch (error) {
                    window.top.postMessage({
                        channel: CHANNEL,
                        type: 'error',
                        message: error.message
                    }, location.origin);
                }
            });

            return originalSend.apply(this, args);
        };

        return;
    }

    let courseData = null;
    let semesterData = null;

    let panel;
    let status;
    let detail;
    let downloadButton;

    function createUI() {
        if (!document.body || panel) return;

        panel = document.createElement('div');
        panel.style.cssText = `
            position: fixed;
            right: 20px;
            bottom: 20px;
            width: 420px;
            z-index: 2147483647;
            padding: 16px;
            background: rgba(20,20,20,.96);
            color: white;
            border-radius: 12px;
            box-shadow: 0 8px 30px rgba(0,0,0,.35);
            font-family:
                -apple-system,
                BlinkMacSystemFont,
                "Segoe UI",
                sans-serif;
            font-size: 13px;
            line-height: 1.5;
        `;

        const title = document.createElement('div');
        title.textContent = 'NWPU → Apple Calendar';
        title.style.cssText = `
            font-size: 16px;
            font-weight: 600;
            margin-bottom: 8px;
        `;

        status = document.createElement('div');
        status.textContent = '✅ 脚本已运行，请点击“课表”';
        status.style.cssText = `
            color: #8fe388;
            margin-bottom: 8px;
        `;

        detail = document.createElement('div');
        detail.textContent = '等待课表与学期数据……';
        detail.style.cssText = `
            margin-bottom: 10px;
            color: #ddd;
        `;

        downloadButton = document.createElement('button');
        downloadButton.textContent = '下载 Apple Calendar ICS';
        downloadButton.disabled = true;
        downloadButton.style.cssText = `
            border: 0;
            border-radius: 7px;
            padding: 8px 12px;
            cursor: pointer;
        `;

        downloadButton.addEventListener('click', downloadICS);

        panel.append(title, status, detail, downloadButton);
        document.body.appendChild(panel);
    }

    function boot() {
        if (document.body) {
            createUI();
            return;
        }

        const observer = new MutationObserver(() => {
            if (document.body) {
                observer.disconnect();
                createUI();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    window.addEventListener('message', event => {
        if (event.origin !== location.origin) return;

        const msg = event.data;
        if (!msg || msg.channel !== CHANNEL) return;

        if (msg.type === 'course') {
            courseData = msg.data;
        }

        if (msg.type === 'semester') {
            semesterData = msg.data;
        }

        if (msg.type === 'error') {
            status.textContent = '❌ 数据读取失败';
            detail.textContent = msg.message;
            return;
        }

        updateUI();
    });

    function updateUI() {
        if (!courseData && !semesterData) return;

        const courseOK = Boolean(courseData);
        const semesterOK = Boolean(semesterData);

        if (courseOK && semesterOK) {
            const activities =
                courseData?.studentTableVm?.activities || [];

            const eventCount = countCalendarEvents(activities);

            status.textContent = '✅ 课表数据读取完成';

            detail.textContent =
                `${semesterData.nameZh || semesterData.name || '当前学期'}`
                + ` · ${activities.length} 个课表块`
                + ` · ${eventCount} 个日历事件`;

            downloadButton.disabled = false;
        } else {
            status.textContent = '🔎 正在读取课表数据……';

            detail.textContent =
                `课程：${courseOK ? '✅' : '等待'} `
                + `学期：${semesterOK ? '✅' : '等待'}`;
        }
    }

    function escapeICS(value) {
        return String(value ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/\r?\n/g, '\\n')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,');
    }

    function normalizeEntity(value) {
        if (value === null || value === undefined) return '';

        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number') return String(value);

        if (Array.isArray(value)) {
            return value
                .map(normalizeEntity)
                .filter(Boolean)
                .join('、');
        }

        if (typeof value === 'object') {
            return (
                value.nameZh ||
                value.name ||
                value.nameEn ||
                value.fullName ||
                value.teacherName ||
                ''
            );
        }

        return String(value);
    }

    function parseDateOnly(str) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);

        if (!match) {
            throw new Error(`无法解析日期：${str}`);
        }

        return new Date(
            Date.UTC(
                Number(match[1]),
                Number(match[2]) - 1,
                Number(match[3])
            )
        );
    }

    function addDays(date, days) {
        const result = new Date(date.getTime());
        result.setUTCDate(result.getUTCDate() + days);
        return result;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function formatDate(date) {
        return (
            date.getUTCFullYear()
            + pad2(date.getUTCMonth() + 1)
            + pad2(date.getUTCDate())
        );
    }

    function formatUtcTimestamp(date) {
        return (
            date.getUTCFullYear()
            + pad2(date.getUTCMonth() + 1)
            + pad2(date.getUTCDate())
            + 'T'
            + pad2(date.getUTCHours())
            + pad2(date.getUTCMinutes())
            + pad2(date.getUTCSeconds())
            + 'Z'
        );
    }

    function normalizeTime(value) {
        const s = String(value ?? '').trim();

        let m = /^(\d{1,2}):(\d{2})$/.exec(s);

        if (m) {
            return pad2(Number(m[1])) + m[2] + '00';
        }

        m = /^(\d{1,2})(\d{2})$/.exec(s);

        if (m) {
            return pad2(Number(m[1])) + m[2] + '00';
        }

        throw new Error(`无法解析时间：${value}`);
    }

    const encoder = new TextEncoder();

    function foldLine(line) {
        const parts = [];
        let current = '';
        let limit = 75;

        for (const ch of line) {
            const candidate = current + ch;

            if (
                current &&
                encoder.encode(candidate).length > limit
            ) {
                parts.push(current);
                current = ch;
                limit = 74;
            } else {
                current = candidate;
            }
        }

        if (current) parts.push(current);

        return parts
            .map((part, index) =>
                index === 0 ? part : ' ' + part
            )
            .join('\r\n');
    }

    function getWeeks(activity) {
        if (Array.isArray(activity.weekIndexes)) {
            return activity.weekIndexes
                .map(Number)
                .filter(n =>
                    Number.isInteger(n) && n > 0
                );
        }

        return [];
    }

    function countCalendarEvents(activities) {
        let total = 0;

        for (const activity of activities) {
            total += getWeeks(activity).length;
        }

        return total;
    }

    function makeLocation(activity) {
        const parts = [
            normalizeEntity(activity.campus),
            normalizeEntity(activity.building),
            normalizeEntity(activity.room)
        ].filter(Boolean);

        return [...new Set(parts)].join(' · ');
    }

    function makeDescription(activity) {
        const lines = [];
        const teachers = normalizeEntity(activity.teachers);

        if (teachers) {
            lines.push(`教师：${teachers}`);
        }

        if (activity.courseCode) {
            lines.push(`课程代码：${activity.courseCode}`);
        }

        if (activity.courseType) {
            lines.push(
                `课程类型：${normalizeEntity(activity.courseType)}`
            );
        }

        if (activity.weeksStr) {
            lines.push(`教学周：${activity.weeksStr}`);
        }

        if (activity.startUnit && activity.endUnit) {
            lines.push(
                `节次：第 ${activity.startUnit}–${activity.endUnit} 节`
            );
        }

        if (activity.lessonRemark) {
            lines.push(`备注：${activity.lessonRemark}`);
        }

        return lines.join('\n');
    }

    function buildEvent(
        activity,
        week,
        semesterStart,
        dtstamp,
        semesterId
    ) {
        const weekday = Number(activity.weekday);

        if (
            !Number.isInteger(weekday) ||
            weekday < 1 ||
            weekday > 7
        ) {
            return null;
        }

        const deltaDays =
            (week - 1) * 7 + (weekday - 1);

        const date = addDays(semesterStart, deltaDays);
        const dateStr = formatDate(date);

        const start = normalizeTime(activity.startTime);
        const end = normalizeTime(activity.endTime);

        const summary =
            activity.courseName ||
            activity.lessonName ||
            '课程';

        const location = makeLocation(activity);
        const description = makeDescription(activity);

        const lessonId =
            activity.lessonId ??
            activity.lessonCode ??
            'unknown';

        const uid = [
            'nwpu',
            semesterId,
            lessonId,
            dateStr,
            start,
            activity.weekday,
            activity.startUnit,
            activity.endUnit
        ].join('-') + '@nwpu-calendar';

        return [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${dtstamp}`,
            `DTSTART;TZID=Asia/Shanghai:${dateStr}T${start}`,
            `DTEND;TZID=Asia/Shanghai:${dateStr}T${end}`,
            `SUMMARY:${escapeICS(summary)}`,
            `LOCATION:${escapeICS(location)}`,
            `DESCRIPTION:${escapeICS(description)}`,
            'STATUS:CONFIRMED',
            'TRANSP:OPAQUE',
            'END:VEVENT'
        ];
    }

    function generateICS() {
        const activities =
            courseData?.studentTableVm?.activities;

        if (!Array.isArray(activities)) {
            throw new Error(
                '找不到 studentTableVm.activities'
            );
        }

        if (!semesterData?.startDate) {
            throw new Error(
                '找不到 semester.startDate'
            );
        }

        if (semesterData.weekStartOnSunday === true) {
            throw new Error(
                '当前学期定义为周日开周，脚本暂未支持。'
            );
        }

        const semesterStart =
            parseDateOnly(semesterData.startDate);

        const semesterId =
            semesterData.id || 'unknown';

        const dtstamp =
            formatUtcTimestamp(new Date());

        const calendarName =
            semesterData.nameZh ||
            semesterData.name ||
            'NWPU 课表';

        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//NWPU Calendar//Tampermonkey//CN',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
            `X-WR-CALNAME:${escapeICS(calendarName)}`,
            'X-WR-TIMEZONE:Asia/Shanghai',
            'BEGIN:VTIMEZONE',
            'TZID:Asia/Shanghai',
            'X-LIC-LOCATION:Asia/Shanghai',
            'BEGIN:STANDARD',
            'TZOFFSETFROM:+0800',
            'TZOFFSETTO:+0800',
            'TZNAME:CST',
            'DTSTART:19700101T000000',
            'END:STANDARD',
            'END:VTIMEZONE'
        ];

        const dedupe = new Set();
        let created = 0;

        for (const activity of activities) {
            const weeks = getWeeks(activity);

            for (const week of weeks) {
                const event = buildEvent(
                    activity,
                    week,
                    semesterStart,
                    dtstamp,
                    semesterId
                );

                if (!event) continue;

                const uid = event.find(
                    line => line.startsWith('UID:')
                );

                if (!uid || dedupe.has(uid)) {
                    continue;
                }

                dedupe.add(uid);
                lines.push(...event);
                created++;
            }
        }

        lines.push('END:VCALENDAR');

        const folded =
            lines.map(foldLine).join('\r\n')
            + '\r\n';

        return {
            ics: folded,
            eventCount: created
        };
    }

    function downloadICS() {
        try {
            const { ics, eventCount } = generateICS();

            const blob = new Blob(
                [ics],
                {
                    type:
                        'text/calendar;charset=utf-8'
                }
            );

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');

            const semesterName =
                semesterData.nameZh ||
                semesterData.name ||
                `semester-${semesterData.id}`;

            const safeName =
                semesterName.replace(
                    /[\\/:*?"<>|]/g,
                    '-'
                );

            a.href = url;
            a.download = `${safeName}-NWPU.ics`;

            document.body.appendChild(a);
            a.click();
            a.remove();

            URL.revokeObjectURL(url);

            status.textContent =
                `✅ 已生成 ${eventCount} 个日历事件`;

            detail.textContent =
                '下载完成，可以直接用 macOS “日历”打开测试。';
        } catch (error) {
            console.error(
                '[NWPU Calendar]',
                error
            );

            status.textContent =
                '❌ ICS 生成失败';

            detail.textContent =
                error.message;
        }
    }

    boot();
})();
