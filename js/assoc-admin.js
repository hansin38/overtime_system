// ==========================================
// 🏛 협회 관리 (assoc-admin.js)
// 기술자 협회 가입·교육 현황 (전 직원 대상 · 사원정보와 별도 명단)
// 저장: association_members (관리자만 - firestore.rules)
// 처음 데이터: 직원명단.xlsx 의 '교육이수현황'·'교육신청현황' 두 시트에 있는 사람 전원
//   + '1기본정보'(직위·부서·입사일·전화·이메일·생년월일) + '2경력,학력'(분야·등급·회사등록·자격증)
//   ⚠️ 주민번호 전체·주소·비밀번호 칸은 읽지 않음 (생년월일만 주민번호 앞 6자리로)
// ==========================================

const ASSOCS = [
    { k: 'elec',  label: '전기기술인협회',   short: '전기',     re: /전기기술인|^전기$|\(전기[+,]|전기,|전기\+/ },
    { k: 'ict',   label: '정보통신공사협회', short: '정보통신', re: /정보통신|통신/ },
    { k: 'sig',   label: '철도신호협회',     short: '철도신호', re: /철도신호/ },
    { k: 'eng',   label: '엔지니어링협회',   short: '엔지니어링', re: /엔지니어링/ },
    { k: 'erail', label: '전기철도협회',     short: '전기철도', re: /전기철도/ },
    { k: 'drive', label: '철도운전협회',     short: '철도운전', re: /철도운전/ },
];
// 교육 칸 6개: 설계(1)(2) · 감리(1)(2) · 기타(전기철도/철도신호) · 철도운전
const EDU_SLOTS = [
    { k: 'd1', group: '설계', label: '설계 (1)' }, { k: 'd2', group: '설계', label: '설계 (2)' },
    { k: 's1', group: '감리', label: '감리 (1)' }, { k: 's2', group: '감리', label: '감리 (2)' },
    { k: 'etc', group: '기타', label: '기타 교육' }, { k: 'drive', group: '기타', label: '철도운전' },
];
const EDU_STATUSES = ['이수', '신청완료', '신청대기', '신청필요'];
const ASSOC_SOON_DAYS = 90;   // 다음 교육 기한이 이 안이면 '임박'

const AS = { members: [], filter: { assoc: '', due: '', q: '' }, sort: { key: 'name', dir: 1 }, editingId: null, loaded: false };

// ------------------------------------------
// 날짜·값 도우미
// ------------------------------------------
function asYmd(v) {
    if (typeof v === 'number' && v > 20000 && v < 80000) {   // 엑셀 날짜 일련번호
        const t = new Date(Math.round((v - 25569) * 86400000));
        return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
    }
    const m = String(v || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : '';
}
function asStatus(v) { const s = String(v || '').trim(); return EDU_STATUSES.includes(s) ? s : ''; }
function asText(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
function asShort(ymd) { return ymd ? ymd.slice(2).replace(/-/g, '.') : ''; }
function asToday() { return toYmd(new Date()); }
function asDaysTo(ymd) { return Math.round((parseYmd(ymd) - parseYmd(asToday())) / 86400000); }

// 주민번호 앞 6자리 + 성별자리 → 생년월일 (주민번호 자체는 저장 안 함)
function birthFromRrn(rrn) {
    const m = String(rrn || '').match(/^(\d{2})(\d{2})(\d{2})-?(\d)/);
    if (!m) return '';
    const century = ['1', '2', '5', '6'].includes(m[4]) ? '19' : ['3', '4', '7', '8'].includes(m[4]) ? '20' : '';
    return century ? `${century}${m[1]}-${m[2]}-${m[3]}` : '';
}

// '(전기+전기철도)' · '한국정보통신공사협회' · '전기,통신,철도신호' → 협회 키 목록
function assocKeysFrom(text) {
    const t = asText(text);
    if (!t) return [];
    const keys = new Set();
    t.split(/[+,/()]/).map(s => s.trim()).filter(Boolean).forEach(part => {
        if (/전기철도/.test(part)) keys.add('erail');
        else if (/철도신호/.test(part)) keys.add('sig');
        else if (/철도운전/.test(part)) keys.add('drive');
        else if (/엔지니어링/.test(part)) keys.add('eng');
        else if (/통신/.test(part)) keys.add('ict');
        else if (/전기/.test(part)) keys.add('elec');
    });
    return [...keys];
}

// 가장 가까운 다음 교육 기한 (설계·감리 다음 신청일, 기타·철도운전 유효기간)
function nextDueOf(m) {
    const dates = EDU_SLOTS.map(s => (m.edu && m.edu[s.k] && m.edu[s.k].next) || '').filter(Boolean).sort();
    return dates[0] || '';
}
function dueLevel(ymd) {
    if (!ymd) return '';
    const d = asDaysTo(ymd);
    return d < 0 ? 'over' : d <= ASSOC_SOON_DAYS ? 'soon' : 'ok';
}

// ------------------------------------------
// 📤 직원명단.xlsx 읽기 (필요한 칸만)
// ------------------------------------------
function parseAssocWorkbook(wb) {
    const sheet = (n) => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) : null;
    const done = sheet('교육이수현황'), apply = sheet('교육신청현황');
    if (!done && !apply) throw new Error("'교육이수현황'·'교육신청현황' 시트를 찾지 못했어요.");
    const base = sheet('1기본정보') || [], career = sheet('2경력,학력') || [];
    const byName = {};
    const person = (name) => (byName[name] = byName[name] || { name, assocs: [], edu: {} });
    const dataRows = (rows) => (rows || []).slice(4).filter(r => asText(r[1]) && !/^성명$/.test(asText(r[1])));

    // 교육이수현황: 수료일 · 다음 신청 일정 · 유효기간 (0~43열만 읽음)
    dataRows(done).forEach(r => {
        const p = person(asText(r[1]));
        p.scope = asText(r[3]);   // 설계만 · 통신 · 감리/기타 …
        const slot = (k, from, to, next, assoc) => {
            const e = p.edu[k] = p.edu[k] || {};
            if (asYmd(r[from])) e.from = asYmd(r[from]);
            if (asYmd(r[to])) e.to = asYmd(r[to]);
            if (next !== null && asYmd(r[next])) e.next = asYmd(r[next]);
            if (next !== null && asStatus(r[next]) && !e.status) e.status = asStatus(r[next]);
            if (assoc !== undefined && asText(r[assoc])) e.assoc = asText(r[assoc]);
        };
        slot('d1', 11, 13, 17, 10); slot('d2', 14, 16, 18, 10);
        slot('s1', 21, 23, 27, 20); slot('s2', 24, 26, 28, 20);
        slot('etc', 31, 33, 34, 30); slot('drive', 37, 39, 40, 36);
        if (!p.edu.etc.next && asYmd(r[42])) p.edu.etc.next = asYmd(r[42]);
        [r[10], r[20], r[30], r[36]].forEach(v => assocKeysFrom(v).forEach(k => p.assocs.includes(k) || p.assocs.push(k)));
    });
    // 교육신청현황: 상태 · 신청(교육) 기간 (0~32열만 읽음 - 그 오른쪽엔 비밀번호 메모가 있어 안 읽음)
    dataRows(apply).forEach(r => {
        const p = person(asText(r[1]));
        const slot = (k, st, from, to, assoc) => {
            const e = p.edu[k] = p.edu[k] || {};
            if (asStatus(r[st])) e.status = asStatus(r[st]);
            if (!e.from && asYmd(r[from])) e.from = asYmd(r[from]);
            if (!e.to && asYmd(r[to])) e.to = asYmd(r[to]);
            if (assoc !== undefined && asText(r[assoc]) && !e.assoc) e.assoc = asText(r[assoc]);
        };
        slot('d1', 4, 5, 7, 2); slot('d2', 8, 9, 11, 2);
        slot('s1', 13, 14, 16); slot('s2', 17, 18, 20);
        slot('etc', 23, 24, 26, 22); slot('drive', 29, 30, 32, 28);
        [r[2], r[22], r[28]].forEach(v => assocKeysFrom(v).forEach(k => p.assocs.includes(k) || p.assocs.push(k)));
    });
    // 1기본정보: 성명(1) 직급(2) 부서(3) 주민번호(4 → 생년월일만) 전화(5) 입사일(6) 이메일(8) - 주소(7)는 안 읽음
    base.slice(3).forEach(r => {
        const p = byName[asText(r[1])];
        if (!p) return;
        Object.assign(p, {
            position: asText(r[2]) === '-' ? '' : asText(r[2]), department: asText(r[3]),
            birth: birthFromRrn(r[4]), phone: asText(r[5]), hireDate: asYmd(r[6]), email: asText(r[8]),
        });
    });
    // 2경력,학력: 구분(5) 분야(6) 자격등급(7) 회사등록(8) 자격증(10) 합격일(12)
    career.slice(3).forEach(r => {
        const p = byName[asText(r[1])];
        if (!p) return;
        assocKeysFrom(r[5]).forEach(k => p.assocs.includes(k) || p.assocs.push(k));
        Object.assign(p, {
            field: asText(r[6]), grade: asText(r[7]), companyReg: /^y/i.test(asText(r[8])) ? true : /^n/i.test(asText(r[8])) ? false : null,
            license: asText(r[10]), licenseDate: asYmd(r[12]) || asText(r[12]),
        });
        if (!p.position && asText(r[2])) p.position = asText(r[2]);
        if (!p.department && asText(r[3])) p.department = asText(r[3]);
    });
    return Object.values(byName).map(p => {
        EDU_SLOTS.forEach(s => { const e = p.edu[s.k]; if (e && !Object.keys(e).length) delete p.edu[s.k]; });
        p.assocs = ASSOCS.map(a => a.k).filter(k => p.assocs.includes(k));
        return p;
    });
}

// ------------------------------------------
// 탭 열기 · 불러오기
// ------------------------------------------
function openAssocTab() {
    document.getElementById('assoc-tbody').innerHTML = `<tr><td colspan="9" style="color: #888;">불러오는 중...</td></tr>`;
    db.collection("association_members").get().then(snap => {
        AS.members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        AS.loaded = true;
        renderAssoc();
    }).catch(err => {
        console.error('협회 명단 불러오기 실패:', err);
        document.getElementById('assoc-tbody').innerHTML = `<tr><td colspan="9" style="color: var(--danger-color);">협회 명단을 불러오지 못했어요.${err && err.code === 'permission-denied' ? '<br><small>Firebase 콘솔 > Firestore > 규칙에 association_members 규칙을 게시했는지 확인해 주세요.</small>' : ''}</td></tr>`;
    });
}

function setAssocFilter(key, value) {
    AS.filter[key] = value;
    const el = document.getElementById('assoc-' + (key === 'q' ? 'search' : key));
    if (el && el.value !== value) el.value = value;
    renderAssoc();
}
function resetAssocFilter() {
    AS.filter = { assoc: '', due: '', q: '' };
    ['assoc-search', 'assoc-assoc', 'assoc-due'].forEach(id => { document.getElementById(id).value = ''; });
    renderAssoc();
}
function sortAssoc(key) { AS.sort = AS.sort.key === key ? { key, dir: -AS.sort.dir } : { key, dir: 1 }; renderAssoc(); }

// 교육 칸 한 개: 상태 칩 + 날짜(수료/교육 기간) + 다음 기한
function eduChip(e) {
    if (!e || (!e.status && !e.from && !e.next)) return '<span class="sub">-</span>';
    const st = e.status || (e.from ? '이수' : '');
    const cls = { '이수': 'ok', '신청완료': 'blue', '신청대기': 'gray', '신청필요': 'bad' }[st] || 'gray';
    const period = e.from ? `${asShort(e.from)}${e.to && e.to !== e.from ? '~' + asShort(e.to).slice(3) : ''}` : '';
    const lv = dueLevel(e.next);
    return `<div class="as-edu">${st ? `<span class="as-st ${cls}">${st}</span>` : ''}${period ? `<span class="as-dt">${period}</span>` : ''}${e.next ? `<span class="as-next ${lv}" title="다음 교육 기한(유효기간)">→ ${asShort(e.next)}</span>` : ''}</div>`;
}
// (1)·(2) 두 칸: 둘 다 비면 '-' 하나만
const eduEmpty = (e) => !e || (!e.status && !e.from && !e.next);
function eduPair(a, b) { return eduEmpty(a) && eduEmpty(b) ? '<span class="sub">-</span>' : (eduEmpty(a) ? '' : eduChip(a)) + (eduEmpty(b) ? '' : eduChip(b)); }
const hasNeed = (m) => EDU_SLOTS.some(s => m.edu && m.edu[s.k] && m.edu[s.k].status === '신청필요');

function renderAssoc() {
    const tbody = document.getElementById('assoc-tbody');
    if (!tbody) return;
    const all = AS.members.map(m => ({ m, due: nextDueOf(m) }));

    // 위쪽 요약: 협회별 인원(누르면 그 협회만) · 교육 기한 지남/임박 · 신청 필요
    const cnt = (k) => all.filter(r => (r.m.assocs || []).includes(k)).length;
    const over = all.filter(r => dueLevel(r.due) === 'over').length, soon = all.filter(r => dueLevel(r.due) === 'soon').length;
    const need = all.filter(r => hasNeed(r.m)).length;
    const kpi = (label, val, onclick, cls = '') => `<div class="staff-kpi click ${cls}" onclick="${onclick}"><small>${label}</small><b>${val}</b></div>`;
    document.getElementById('assoc-kpis').innerHTML =
        `<div class="as-kpi-row">${ASSOCS.map(a => kpi(a.label, `${cnt(a.k)}명`, `setAssocFilter('assoc','${AS.filter.assoc === a.k ? '' : a.k}')`, AS.filter.assoc === a.k ? 'on' : '')).join('')}</div>
         <div class="as-kpi-row small">${kpi('전체 기술자', `${all.length}명`, 'resetAssocFilter()')}
            ${kpi('교육 기한 지남', `${over}명`, "setAssocFilter('due','over')", over ? 'bad' : '')}
            ${kpi(`기한 ${ASSOC_SOON_DAYS}일 이내`, `${soon}명`, "setAssocFilter('due','soon')", soon ? 'warn' : '')}
            ${kpi('교육 신청 필요', `${need}명`, "setAssocFilter('due','need')", need ? 'warn' : '')}</div>`;

    // 거르기
    const q = AS.filter.q.trim();
    const list = all.filter(r =>
        (!AS.filter.assoc || (r.m.assocs || []).includes(AS.filter.assoc))
        && (!q || [r.m.name, r.m.department, r.m.position].some(v => String(v || '').includes(q)))
        && (!AS.filter.due
            || (AS.filter.due === 'need' ? hasNeed(r.m)
                : AS.filter.due === 'soon' ? ['over', 'soon'].includes(dueLevel(r.due)) : dueLevel(r.due) === AS.filter.due)));

    // 정렬 (빈 값은 맨 아래)
    const keyOf = { name: r => r.m.name || null, dept: r => r.m.department || null, grade: r => r.m.grade || null, due: r => r.due || null }[AS.sort.key];
    list.sort((a, b) => {
        const x = keyOf(a), y = keyOf(b), byName = (a.m.name || '').localeCompare(b.m.name || '', 'ko');
        if (x === null || y === null) return x === y ? byName : (x === null ? 1 : -1);
        return AS.sort.dir * String(x).localeCompare(String(y), 'ko') || byName;
    });
    const th = (k, label) => `<th class="sortable" onclick="sortAssoc('${k}')">${label} <span class="arr${AS.sort.key === k ? ' on' : ''}">${AS.sort.key === k ? (AS.sort.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
    document.getElementById('assoc-head').innerHTML = `${th('name', '이름')}${th('dept', '부서 · 직위')}<th>협회</th>${th('grade', '등급 · 분야')}<th>회사등록</th><th>설계 교육 (1) / (2)</th><th>감리 교육 (1) / (2)</th><th>기타 교육</th>${th('due', '가장 가까운 기한')}`;
    document.getElementById('assoc-count').innerText = `${list.length}명`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="9" style="color: #888;">${AS.members.length ? '조건에 맞는 기술자가 없어요' : '아직 명단이 없어요. [📤 직원명단 엑셀에서 가져오기]로 한 번에 넣을 수 있어요.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(({ m, due }) => {
        const e = m.edu || {};
        const chips = (m.assocs || []).map(k => { const a = ASSOCS.find(x => x.k === k); return a ? `<span class="as-assoc as-${k}" title="${a.label}">${a.short}</span>` : ''; }).join('');
        const lv = dueLevel(due);
        const etc = [e.etc, e.drive].filter(x => x && (x.status || x.from || x.next))
            .map(x => `${x.assoc ? `<small class="as-sub">${esc(x.assoc.replace(/^\(사\)/, ''))}</small>` : ''}${eduChip(x)}`).join('') || '<span class="sub">-</span>';
        return `<tr onclick="openAssocModal('${m.id}')" title="눌러서 수정">
            <td><b>${esc(m.name)}</b></td>
            <td>${esc(m.department || '-')}<small>${esc(m.position || '')}</small></td>
            <td class="l">${chips || '<span class="sub">-</span>'}</td>
            <td>${esc(m.grade || '-')}<small>${esc(m.field || '')}</small></td>
            <td>${m.companyReg === true ? '<span class="staff-chip ok">Y</span>' : m.companyReg === false ? '<span class="staff-chip gray">N</span>' : '<span class="sub">-</span>'}</td>
            <td class="l">${eduPair(e.d1, e.d2)}</td>
            <td class="l">${eduPair(e.s1, e.s2)}</td>
            <td class="l">${etc}</td>
            <td>${due ? `<span class="as-due ${lv}">${asShort(due)}</span><small>${lv === 'over' ? '기한 지남' : `${asDaysTo(due)}일 남음`}</small>` : '<span class="sub">-</span>'}</td>
        </tr>`;
    }).join('');
}

// ------------------------------------------
// 수정 창 (기술자 한 명)
// ------------------------------------------
function openAssocModal(id = null) {
    AS.editingId = id;
    const m = id ? AS.members.find(x => x.id === id) : { assocs: [], edu: {} };
    if (!m) return;
    const v = (x) => esc(x || '');
    const grades = ['초급', '중급', '고급', '특급'];
    const eduRow = (s) => {
        const e = (m.edu || {})[s.k] || {};
        return `<tr><td>${s.label}</td>
            <td><input id="ae-${s.k}-assoc" value="${v(e.assoc)}" placeholder="협회"></td>
            <td><select id="ae-${s.k}-status"><option value="">-</option>${EDU_STATUSES.map(st => `<option ${e.status === st ? 'selected' : ''}>${st}</option>`).join('')}</select></td>
            <td><input type="date" id="ae-${s.k}-from" value="${v(e.from)}"></td>
            <td><input type="date" id="ae-${s.k}-to" value="${v(e.to)}"></td>
            <td><input type="date" id="ae-${s.k}-next" value="${v(e.next)}"></td></tr>`;
    };
    document.getElementById('assoc-modal-title').innerText = id ? `기술자 정보 · ${m.name}` : '기술자 추가';
    document.getElementById('assoc-modal-body').innerHTML = `
        <div class="pay-grp"><div class="gh">기본 정보</div><div class="pay-fg c3">
            <div><label>이름</label><input id="ae-name" value="${v(m.name)}"></div>
            <div><label>부서</label><input id="ae-department" value="${v(m.department)}"></div>
            <div><label>직위</label><input id="ae-position" value="${v(m.position)}"></div>
            <div><label>입사일</label><input type="date" id="ae-hireDate" value="${v(m.hireDate)}"></div>
            <div><label>생년월일</label><input type="date" id="ae-birth" value="${v(m.birth)}"></div>
            <div><label>전화번호</label><input id="ae-phone" value="${v(m.phone)}"></div>
            <div style="grid-column: span 3;"><label>이메일</label><input id="ae-email" value="${v(m.email)}"></div>
        </div></div>
        <div class="pay-grp"><div class="gh">협회 · 자격</div>
            <div class="as-assoc-picks">${ASSOCS.map(a => `<label class="lvimp-emp"><input type="checkbox" id="ae-assoc-${a.k}" ${(m.assocs || []).includes(a.k) ? 'checked' : ''}> ${a.label}</label>`).join('')}</div>
            <div class="pay-fg c3">
                <div><label>분야</label><input id="ae-field" value="${v(m.field)}" placeholder="설계/감리"></div>
                <div><label>자격 등급</label><select id="ae-grade"><option value="">-</option>${grades.map(gr => `<option ${m.grade === gr ? 'selected' : ''}>${gr}</option>`).join('')}${m.grade && !grades.includes(m.grade) ? `<option selected>${v(m.grade)}</option>` : ''}</select></div>
                <div><label>회사 등록</label><select id="ae-companyReg"><option value="">-</option><option value="Y" ${m.companyReg === true ? 'selected' : ''}>Y</option><option value="N" ${m.companyReg === false ? 'selected' : ''}>N</option></select></div>
                <div style="grid-column: span 2;"><label>자격증</label><input id="ae-license" value="${v(m.license)}"></div>
                <div><label>합격일</label><input id="ae-licenseDate" value="${v(m.licenseDate)}" placeholder="2021-06-02"></div>
            </div></div>
        <div class="pay-grp"><div class="gh">교육 <small class="sub" style="font-weight: normal;">다음 기한 = 설계·감리는 다음 신청 일정, 기타는 유효기간</small></div>
            <table class="as-edu-tbl"><tr><th></th><th>협회</th><th>상태</th><th>시작(수료)</th><th>종료</th><th>다음 기한</th></tr>${EDU_SLOTS.map(eduRow).join('')}</table></div>
        <div class="pay-grp"><div class="gh">메모</div><textarea id="ae-memo" class="as-memo" placeholder="예: 엔지니어링협회 퇴직 처리 함">${v(m.memo)}</textarea></div>`;
    document.getElementById('assoc-del-btn').style.display = id ? '' : 'none';
    document.getElementById('assoc-modal').style.display = 'flex';
}
function closeAssocModal() { document.getElementById('assoc-modal').style.display = 'none'; }

function saveAssocMember() {
    const g = (k) => (document.getElementById('ae-' + k).value || '').trim();
    const name = g('name');
    if (!name) { alert('이름을 입력해 주세요.'); return; }
    const edu = {};
    EDU_SLOTS.forEach(s => {
        const e = { assoc: g(`${s.k}-assoc`), status: g(`${s.k}-status`), from: g(`${s.k}-from`), to: g(`${s.k}-to`), next: g(`${s.k}-next`) };
        Object.keys(e).forEach(k => { if (!e[k]) delete e[k]; });
        if (Object.keys(e).length) edu[s.k] = e;
    });
    const reg = g('companyReg');
    const doc = {
        name, department: g('department'), position: g('position'), hireDate: g('hireDate'), birth: g('birth'), phone: g('phone'), email: g('email'),
        assocs: ASSOCS.map(a => a.k).filter(k => document.getElementById('ae-assoc-' + k).checked),
        field: g('field'), grade: g('grade'), companyReg: reg === 'Y' ? true : reg === 'N' ? false : null,
        license: g('license'), licenseDate: g('licenseDate'), edu, memo: g('memo'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    const ref = AS.editingId ? db.collection("association_members").doc(AS.editingId) : db.collection("association_members").doc();
    ref.set(doc).then(() => { closeAssocModal(); openAssocTab(); })
        .catch(err => { console.error('협회 정보 저장 실패:', err); alert('저장 중 오류가 발생했어요.'); });
}

function deleteAssocMember() {
    const m = AS.members.find(x => x.id === AS.editingId);
    if (!m || !confirm(`${m.name} 님을 협회 명단에서 지울까요?\n(직원 관리의 사원 정보와는 별개라 그쪽은 그대로예요)`)) return;
    db.collection("association_members").doc(m.id).delete().then(() => { closeAssocModal(); openAssocTab(); })
        .catch(err => { console.error(err); alert('지우는 중 오류가 발생했어요.'); });
}

// ------------------------------------------
// 📤 직원명단 엑셀에서 가져오기 (이름으로 맞춰서 새로 추가 / 엑셀 내용으로 갱신, 메모는 유지)
// ------------------------------------------
let assocImportRows = [];
function openAssocImport() {
    assocImportRows = [];
    document.getElementById('assoc-imp-file').value = '';
    document.getElementById('assoc-imp-result').innerHTML = '';
    document.getElementById('assoc-imp-save').disabled = true;
    document.getElementById('assoc-imp-modal').style.display = 'flex';
}
function closeAssocImport() { document.getElementById('assoc-imp-modal').style.display = 'none'; }

function onAssocImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
            renderAssocImport(parseAssocWorkbook(wb));
        } catch (e) {
            console.error(e);
            alert(e.message || '엑셀을 읽지 못했어요.');
        }
    };
    reader.readAsArrayBuffer(file);
}
function renderAssocImport(rows) {
    assocImportRows = rows.map(p => ({ p, old: AS.members.find(m => m.name === p.name) || null }));
    const add = assocImportRows.filter(r => !r.old).length, upd = assocImportRows.length - add;
    document.getElementById('assoc-imp-result').innerHTML = `
        <div class="lvimp-sum"><span>읽은 기술자 <b>${rows.length}</b>명</span><span class="ok">새로 추가 <b>${add}</b></span><span class="warn">엑셀 내용으로 갱신 <b>${upd}</b></span></div>
        <div class="lvimp-wrap"><table class="lvimp-tbl"><thead><tr><th>이름</th><th>부서 · 직위</th><th>협회</th><th>등급</th><th>교육 기록</th><th></th></tr></thead><tbody>
        ${assocImportRows.map(({ p, old }) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.department || '-')} · ${esc(p.position || '-')}</td>
            <td>${(p.assocs || []).map(k => ASSOCS.find(a => a.k === k).short).join(', ') || '-'}</td><td>${esc(p.grade || '-')}</td>
            <td>${EDU_SLOTS.filter(s => p.edu[s.k] && (p.edu[s.k].status || p.edu[s.k].from || p.edu[s.k].next)).length}건</td>
            <td>${old ? '<span class="as-st gray">갱신</span>' : '<span class="as-st ok">추가</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="pay-note" style="margin-top: 10px;">🔒 주민번호(생년월일만 사용)·주소·비밀번호 칸은 읽지 않았어요. 이미 있는 사람은 엑셀 내용으로 바뀌고, 화면에서 적은 <b>메모는 그대로</b> 남아요.</div>`;
    const btn = document.getElementById('assoc-imp-save');
    btn.disabled = !rows.length;
    btn.innerText = `${rows.length}명 저장`;
}

function saveAssocImport() {
    if (!assocImportRows.length) return;
    if (!confirm(`${assocImportRows.length}명을 협회 명단에 저장할까요?`)) return;
    const batch = db.batch();
    assocImportRows.forEach(({ p, old }) => {
        const ref = old ? db.collection("association_members").doc(old.id) : db.collection("association_members").doc();
        batch.set(ref, { ...p, memo: old ? (old.memo || '') : '', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    batch.commit().then(() => { alert('저장했어요.'); closeAssocImport(); openAssocTab(); })
        .catch(err => {
            console.error('협회 명단 저장 실패:', err);
            alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요.\nFirebase 콘솔 > Firestore > 규칙에 association_members 규칙을 게시해 주세요.' : '저장 중 오류가 발생했어요.');
        });
}

// ⬇ 협회 명단 엑셀로 받기
function downloadAssocExcel() {
    const head = ['이름', '부서', '직위', '입사일', '협회', '분야', '등급', '회사등록', '자격증',
        ...EDU_SLOTS.flatMap(s => [`${s.label} 상태`, `${s.label} 시작`, `${s.label} 종료`, `${s.label} 다음 기한`]), '가장 가까운 기한', '메모'];
    const rows = AS.members.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')).map(m => [
        m.name, m.department || '', m.position || '', m.hireDate || '',
        (m.assocs || []).map(k => (ASSOCS.find(a => a.k === k) || {}).label).join(', '), m.field || '', m.grade || '',
        m.companyReg === true ? 'Y' : m.companyReg === false ? 'N' : '', m.license || '',
        ...EDU_SLOTS.flatMap(s => { const e = (m.edu || {})[s.k] || {}; return [e.status || '', e.from || '', e.to || '', e.next || '']; }),
        nextDueOf(m), m.memo || '']);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '협회 명단');
    XLSX.writeFile(wb, `협회명단_${asToday()}.xlsx`);
}
