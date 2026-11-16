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
