// ==UserScript==
// @name         NWPU → Apple Calendar
// @namespace    https://jwxt.nwpu.edu.cn/
// @version      1.3.0
// @description  西工大课表与考试 ICS 导出、个人日历订阅与邀请制多设备同步
// @author       kv (kingvamp4r)
// @license      MIT
// @homepageURL  https://github.com/kingvamp4r/nwpu-to-apple-calendar
// @supportURL   https://github.com/kingvamp4r/nwpu-to-apple-calendar/issues
// @downloadURL  https://cal.kingvamp.asia/client.user.js
// @updateURL    https://cal.kingvamp.asia/client.user.js
// @match        https://jwxt.nwpu.edu.cn/*
// @grant        GM_xmlhttpRequest
// @connect      cal.kingvamp.asia
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==


// Included in the userscript; no personal subscription or upload credentials here.
(function browserSync() {
    'use strict';
    const CHANNEL = 'NWPU_CALENDAR_V1';
    const EXAMS = 'NWPU_EXAMS_V1';
    const text = node => (node?.textContent || '').trim().replace(/\s+/g, ' ');
    if (window !== window.top) {
        let last = '';
        const scan = () => {
            if (!location.pathname.includes('/exam-arrange')) return;
            const table = document.querySelector('table#exams');
            if (!table) return;
            const exams = [], invalid = [];
            for (const row of table.querySelectorAll('tr[data-finished]')) {
                const cells = row.querySelectorAll('td');
                const match = text(row.querySelector('.time')).match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*[~～–-]\s*(\d{1,2}:\d{2})$/);
                if (!match || cells.length < 3) { invalid.push('考试时间不完整'); continue; }
                exams.push({date:match[1], start:match[2], end:match[3],
                    name:text(cells[1].querySelector('div > span')),
                    type:text(cells[1].querySelector('.tag-span')),
                    location:Array.from(cells[0].querySelectorAll('div:not(.time) span')).map(text).join(' · '),
                    finished:row.dataset.finished === 'true'});
            }
            const value = JSON.stringify({exams, invalid});
            if (value !== last) { last = value; window.top.postMessage({channel:EXAMS,exams,invalid},location.origin); }
        };
        const start = () => { scan(); new MutationObserver(scan).observe(document.body,{childList:true,subtree:true}); };
        if (document.body) start(); else addEventListener('DOMContentLoaded',start,{once:true});
        return;
    }
    let exams = [], invalid = [], course, semester;
    let config;
    config = GM_getValue('nwpu-calendar-sync', {});
    let status, examStatus;
    const save = () => GM_setValue('nwpu-calendar-sync',config);
    const escape = value => String(value || '').replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
    const utc = (date,time) => new Date(`${date}T${time.padStart(5,'0')}:00+08:00`).toISOString().replace(/[-:]/g,'').replace('.000','');
    const fold = line => { let out='',current=''; for(const c of line){ if(new TextEncoder().encode(current+c).length>75){out+=current+'\r\n';current=' ';}current+=c;} return out+current; };
    const download = () => {
        if (invalid.length || !exams.length) throw new Error('没有完整考试信息，请打开考试安排页面');
        const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//NWPU//Exams//CN','X-WR-CALNAME:NWPU 考试安排'];
        const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
        for (const e of exams) {
            const id=encodeURIComponent(`${e.name}:${e.type}:${e.date}:${e.start}`);
            lines.push('BEGIN:VEVENT',`UID:${id}@nwpu-exam-export`,`DTSTAMP:${stamp}`,`DTSTART:${utc(e.date,e.start)}`,`DTEND:${utc(e.date,e.end)}`,`SUMMARY:${escape(e.type+'考试 · '+e.name)}`,`LOCATION:${escape(e.location)}`,'END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        const url=URL.createObjectURL(new Blob([lines.map(fold).join('\r\n')+'\r\n'],{type:'text/calendar;charset=utf-8'}));
        const a=document.createElement('a');a.href=url;a.download='NWPU-考试安排.ics';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    };
    const subscription = kind => {
        const value=config[kind+'Url'];
        if(!value) throw new Error('请先配置订阅链接');
        const url=new URL(value);
        if(url.protocol!=='https:') throw new Error('订阅地址必须使用 HTTPS');
        return url;
    };
    const upload = kind => new Promise((resolve,reject) => {
        const url=subscription(kind==='course'?'course':'exam');
        if(!config.uploadToken) return reject(new Error('请先配置独立上传凭证'));
        const payload=kind==='course'?{kind,course:{studentTableVm:{activities:course?.studentTableVm?.activities?.map(item=>Object.fromEntries(['lessonId','lessonCode','courseName','lessonName','courseCode','weekIndexes','weekday','startUnit','endUnit','startTime','endTime','room','building','campus','teachers','courseType','lessonRemark'].filter(key=>key in item).map(key=>[key,item[key]]))) }},semester:semester?Object.fromEntries(['id','nameZh','name','startDate','weekStartOnSunday'].filter(key=>key in semester).map(key=>[key,semester[key]])):null}:{kind,exams};
        if(kind==='course'&&(!course||!semester)) return reject(new Error('请先打开本学期课表并等待读取完成'));
        if(kind==='exams'&&(!exams.length||invalid.length)) return reject(new Error('请先打开考试安排，检查完整考试时间'));
        GM_xmlhttpRequest({method:'POST',url:url.origin+'/api/upload',headers:{'Content-Type':'application/json','Authorization':'Bearer '+config.uploadToken},data:JSON.stringify(payload),timeout:30000,
            onload:r=>{ try { const d=JSON.parse(r.responseText); if(r.status!==200||!d.ok)throw new Error(); status.textContent=`服务器已更新 ${d.count} 个事件 · ${new Date(d.updated_at).toLocaleString()}；等待日历刷新`;resolve(); }catch{reject(new Error('上传失败，请检查凭证与服务器状态'));}},
            onerror:()=>reject(new Error('上传连接失败')),ontimeout:()=>reject(new Error('上传超时'))});
    });
    let refreshUI = () => {};
    const start = () => {
        const panel=document.createElement('section');
        panel.id='nwpu-calendar-panel';
        const style=document.createElement('style');
        style.textContent=`#nwpu-calendar-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:340px;max-width:calc(100vw - 36px);max-height:85vh;overflow:auto;background:#fff;color:#182333;border:1px solid #dfe5ec;border-radius:16px;box-shadow:0 12px 40px #10203926;font:13px/1.6 system-ui;padding:18px;box-sizing:border-box}#nwpu-calendar-panel *{box-sizing:border-box}#nwpu-calendar-panel button,#nwpu-calendar-panel select,#nwpu-calendar-panel input{font:inherit}#nwpu-calendar-panel button{border:1px solid #dce3eb;border-radius:8px;background:#fff;color:#26384f;padding:7px 10px;cursor:pointer}#nwpu-calendar-panel button:disabled{opacity:.5;cursor:default}#nwpu-calendar-panel .primary{background:#2366d1;color:#fff;border-color:#2366d1;flex:1}#nwpu-calendar-panel .row{display:flex;gap:8px;align-items:center;margin-top:10px}#nwpu-calendar-panel .muted{color:#687588;font-size:12px}#nwpu-calendar-panel .box{background:#f4f7fb;border-radius:9px;padding:10px;margin-top:12px}#nwpu-calendar-panel label{display:block;margin-top:10px}#nwpu-calendar-panel input[type=url],#nwpu-calendar-panel input[type=password]{width:100%;padding:7px;border:1px solid #ccd6e2;border-radius:6px}#nwpu-calendar-panel details{margin-top:12px}#nwpu-calendar-panel summary{cursor:pointer;color:#4b617c}#nwpu-calendar-panel select{padding:5px;border:1px solid #dce3eb;border-radius:6px;background:#fff}#nwpu-calendar-panel [hidden]{display:none!important}`;
        document.head.append(style);
        const el=(tag,label,parent=panel)=>{const node=document.createElement(tag);if(label)node.textContent=label;parent.append(node);return node;};
        const header=el('div');header.className='row';header.style.marginTop='0';
        el('strong','西工大日历',header).style.flex='1';
        const minimize=el('button','收起',header);minimize.setAttribute('aria-label','收起日历面板');
        const body=el('div');
        minimize.onclick=()=>{body.hidden=!body.hidden;minimize.textContent=body.hidden?'展开':'收起';minimize.setAttribute('aria-label',body.hidden?'展开日历面板':'收起日历面板');};
        el('div','打开课表或考试页面，读取后即可同步。',body).className='muted';
        const sourceRow=el('div','',body);sourceRow.className='row';
        el('span','当前内容',sourceRow);
        const source=el('select','',sourceRow);source.setAttribute('aria-label','日历内容');
        for(const [value,label] of [['course','课表'],['exams','考试安排']]){const option=el('option',label,source);option.value=value;}
        const stateBox=el('div','',body);stateBox.className='box';
        const ready=el('div','',stateBox);
        const hint=el('div','',stateBox);hint.className='muted';
        const actions=el('div','',body);actions.className='row';
        const sync=el('button','同步到日历',actions);sync.className='primary';
        const subscribe=el('button','添加订阅',actions);
        status=el('div','',body);status.className='muted';status.style.marginTop='10px';status.setAttribute('role','status');
        status.textContent='首次添加订阅后，无需反复导入。';
        const more=el('details','',body);el('summary','更多操作',more);
        const moreRow=el('div','',more);moreRow.className='row';
        const copy=el('button','复制订阅链接',moreRow);
        const exportButton=el('button','下载日历文件',moreRow);
        el('div','下载适合一次性导入，不会自动更新。',more).className='muted';
        const pairing=el('details','',body);el('summary','新设备配对',pairing);pairing.open=!config.uploadToken;
        el('div','向管理员领取配对码。有效期十分钟，每台设备分别配对。无需提供教务密码或验证码。',pairing).className='muted';
        const serverLabel=el('label','同步服务地址',pairing);const serverField=el('input','',serverLabel);serverField.type='url';serverField.value=config.courseUrl?new URL(config.courseUrl).origin:'https://cal.kingvamp.asia';
        const codeLabel=el('label','一次性配对码',pairing);const pairCode=el('input','',codeLabel);pairCode.type='password';pairCode.autocomplete='off';
        const deviceLabel=el('label','设备备注（可选）',pairing);const deviceName=el('input','',deviceLabel);deviceName.type='text';deviceName.placeholder='例如：我的笔记本';deviceName.style.width='100%';
        const pairButton=el('button','配对并获取订阅',pairing);pairButton.style.marginTop='10px';
        const settings=el('details','',body);el('summary','设置',settings);
        el('div','已有配置会自动保留。服务信息只需填写一次。',settings).className='muted';
        const fields={};
        for(const [key,label,type] of [['courseUrl','课表订阅链接','url'],['examUrl','考试订阅链接','url'],['uploadToken','同步密钥','password']]){
            const labelNode=el('label',label,settings);const input=el('input','',labelNode);input.type=type;input.value=config[key]||'';input.autocomplete='off';fields[key]=input;
        }
        const autoLabel=el('label','',settings);const auto=el('input','',autoLabel);auto.type='checkbox';auto.checked=!!config.autoUpload;autoLabel.append(document.createTextNode(' 读取后自动同步'));
        el('div','开启后，打开课表或考试页面即可更新服务器。',settings).className='muted';
        const saveButton=el('button','保存设置',settings);saveButton.style.marginTop='10px';
        const help=el('details','',body);el('summary','如何使用',help);
        for(const line of ['① 首次使用：在设置中填写服务信息。','② 打开教务系统的课表或考试信息，等待读取完成。','③ 点击“同步到日历”，或开启自动同步。','④ 点击“添加订阅”，在 Apple 日历中确认一次。','同步是将数据更新到服务器；Apple 日历会按自身刷新频率显示变化。','服务器每日检查课表；考试需打开考试页面才能更新。'])el('div',line,help).className='muted';
        const courseSlot=el('div');courseSlot.id='nwpu-course-slot';courseSlot.hidden=true;
        const courseSection=document.getElementById('nwpu-course-section');if(courseSection)courseSlot.append(courseSection);
        const run=action=>async()=>{try{await action();}catch(e){status.textContent=e.message;}};
        const key=()=>source.value==='course'?'course':'exam';
        refreshUI=()=>{
            const isCourse=source.value==='course';
            const ok=isCourse?!!(course&&semester):!!(exams.length&&!invalid.length);
            ready.textContent=isCourse?(ok?`课表已读取 · ${course.studentTableVm?.activities?.length||0} 个课表块`:'等待读取课表'):(ok?`考试已读取 · ${exams.filter(e=>!e.finished).length} 场未结束`:'等待读取完整考试安排');
            hint.textContent=ok?'可以同步，也可以下载日历文件。':(isCourse?'请在教务系统打开“我的课表”。':'请打开“考试信息”；时间不完整的记录无法同步。');
            sync.disabled=!ok;exportButton.disabled=!ok;
            subscribe.disabled=!config[key()+'Url'];copy.disabled=subscribe.disabled;
        };
        pairButton.onclick=run(async()=>{
            const server=new URL(serverField.value.trim());
            if(server.protocol!=='https:'||server.username||server.password||server.origin!=='https://cal.kingvamp.asia')throw new Error('当前安装版请使用 https://cal.kingvamp.asia');
            const code=pairCode.value.trim();if(!code)throw new Error('请填写管理员提供的一次性配对码');
            pairButton.disabled=true;status.textContent='正在配对…';
            try{
                const data=await new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'POST',url:server.origin+'/api/pair',headers:{'Content-Type':'application/json'},data:JSON.stringify({code,deviceName:deviceName.value.trim()}),timeout:20000,
                    onload:r=>{try{const d=JSON.parse(r.responseText);if(r.status!==200||!d.ok)throw new Error();resolve(d);}catch{reject(new Error('配对失败：配对码可能已使用或过期，请领取新码'));}},onerror:()=>reject(new Error('无法连接同步服务')),ontimeout:()=>reject(new Error('配对超时，请向管理员确认设备是否已创建后重新领取配对码'))}));
                if(!/^\/[A-Za-z0-9_-]{32,}\.ics$/.test(data.coursePath)||!/^\/[A-Za-z0-9_-]{32,}\.ics$/.test(data.examPath)||typeof data.uploadToken!=='string'||data.uploadToken.length<32)throw new Error('服务器返回了无效配置');
                config={...config,courseUrl:server.origin+data.coursePath,examUrl:server.origin+data.examPath,uploadToken:data.uploadToken,deviceId:data.deviceId};save();
                for(const key of Object.keys(fields))fields[key].value=config[key]||'';
                pairCode.value='';pairing.open=false;course=undefined;semester=undefined;exams=[];invalid=[];Object.values(pendingUpload).forEach(clearTimeout);refreshUI();status.textContent='配对成功。请重新打开课表或考试页面，读取后再同步。';
            }finally{pairButton.disabled=false;}
        });
        source.onchange=refreshUI;
        sync.onclick=run(async()=>{sync.disabled=true;status.textContent='正在同步…';try{await upload(source.value);}finally{refreshUI();}});
        subscribe.onclick=run(()=>{location.href=subscription(key()).href.replace(/^https:/,'webcal:');});
        copy.onclick=run(async()=>{await navigator.clipboard.writeText(subscription(key()).href);status.textContent='订阅链接已复制，请勿公开分享。';});
        exportButton.onclick=run(()=>{if(source.value==='exams')download();else{const button=document.querySelector('#nwpu-course-section button');if(!button||button.disabled)throw new Error('课表尚未准备好');button.click();}status.textContent='已下载日历文件；导入后不会自动更新。';});
        saveButton.onclick=run(()=>{
            const next={...config,autoUpload:auto.checked};for(const key of Object.keys(fields))next[key]=fields[key].value.trim();
            for(const value of [next.courseUrl,next.examUrl])if(value&&new URL(value).protocol!=='https:')throw new Error('订阅链接请填写 HTTPS 地址');
            if(next.courseUrl&&next.examUrl&&new URL(next.courseUrl).origin!==new URL(next.examUrl).origin)throw new Error('课表和考试请使用同一个同步服务');
            config=next;save();refreshUI();status.textContent='设置已保存';settings.open=false;
        });
        document.body.append(panel);refreshUI();
        // Follow the page just opened, without showing two parallel control panels.
        addEventListener('message',event=>{if(event.origin!==location.origin)return;const msg=event.data;if(msg?.channel===EXAMS)source.value='exams';if(msg?.channel===CHANNEL&&['course','semester'].includes(msg.type))source.value='course';refreshUI();});
    };
    const pendingUpload={};
    const scheduleUpload=kind=>{if(!config.autoUpload)return;clearTimeout(pendingUpload[kind]);pendingUpload[kind]=setTimeout(()=>upload(kind).catch(e=>{if(status)status.textContent=e.message;}),1500);};
    addEventListener('message',event=>{
        if(event.origin!==location.origin||event.source===window)return;
        const msg=event.data;if(!msg)return;
        if(msg.channel===EXAMS){exams=msg.exams||[];invalid=msg.invalid||[];}
        if(msg.channel===CHANNEL&&msg.type==='course')course=msg.data;
        if(msg.channel===CHANNEL&&msg.type==='semester')semester=msg.data;
        if(msg.channel===EXAMS&&exams.length&&!invalid.length)scheduleUpload('exams');
        if(msg.channel===CHANNEL&&course&&semester)scheduleUpload('course');
    });
    if(document.body)start();else addEventListener('DOMContentLoaded',start,{once:true});
})();


(function () {
    'use strict';

    const CHANNEL = 'NWPU_CALENDAR_V1';
    const isTop = window === window.top;

    if (!isTop) {
        const originalOpen = unsafeWindow.XMLHttpRequest.prototype.open;
        const originalSend = unsafeWindow.XMLHttpRequest.prototype.send;

        unsafeWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            try {
                this.__nwpuUrl = new URL(url, location.href).href;
            } catch {
                this.__nwpuUrl = String(url);
            }

            return originalOpen.call(this, method, url, ...rest);
        };

        unsafeWindow.XMLHttpRequest.prototype.send = function (...args) {
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
        panel.id = 'nwpu-course-section';
        panel.hidden = true;
        panel.style.cssText = 'font:13px/1.5 system-ui;';

        const title = document.createElement('div');
        title.textContent = '课表';
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
        downloadButton.textContent = '下载课表 ICS';
        downloadButton.disabled = true;
        downloadButton.style.cssText = `
            border: 0;
            border-radius: 7px;
            padding: 8px 12px;
            cursor: pointer;
        `;

        downloadButton.addEventListener('click', downloadICS);

        panel.append(title, status, detail, downloadButton);
        const slot = document.getElementById('nwpu-course-slot');
        (slot || document.body).appendChild(panel);
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
