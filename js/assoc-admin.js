// ==========================================
// 🏛 협회 관리 (assoc-admin.js)
// 기술자 협회 가입·교육 현황 - 사람은 직원정보 명단(hr_staff), 교육 기록·메모만 hr_edu 에 저장 (2026-11-24 구조 변경)
// 저장: hr_edu (교육 기록·메모, 문서 ID = 직원정보 ID · 관리자만 - firestore.rules 의 hr_ 규칙) · 예전 association_members 는 보관만
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
const EDU_VALID_YEARS = 3;    // 교육은 종료일부터 3년 - 1일까지 유효 (예: 23.11.14 종료 → 26.11.13까지, 11.14부터 무효)
const EDU_KEEP_YEARS = 10;    // 교육 기록은 종료일부터 10년 보관, 지나면 저장할 때 지움

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

// ------------------------------------------
// 교육 기록: 칸마다 여러 건(이력) 보관 - edu[칸] = { records: [{ assoc, status, from, to, next }] }
// (예전 저장 모양 edu[칸] = { assoc, status, from, to, next } 한 건도 그대로 읽음)
// ------------------------------------------
const validYmd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';
const recEnd = (r) => r.to || r.from || '';
function addYearsYmd(ymd, years, days = 0) {
    const d = parseYmd(ymd);
    d.setFullYear(d.getFullYear() + years);
    d.setDate(d.getDate() + days);
    return toYmd(d);
}
const eduKeepFrom = () => addYearsYmd(asToday(), -EDU_KEEP_YEARS);
const recEmpty = (r) => !r.from && !r.to && !r.next && !['신청완료', '신청대기', '신청필요'].includes(r.status);
// 칸의 기록 목록 (최신순, 종료일 10년 지난 기록 제외)
function eduRecs(m, k) {
    const e = (m && m.edu && m.edu[k]) || null;
    if (!e) return [];
    const list = Array.isArray(e.records) ? e.records : [e];
    return list
        // 날짜 칸은 'YYYY-MM-DD' 글자만 인정 (엑셀의 0·1006 같은 값이 들어와도 화면이 멈추지 않게)
        .map(r => ({ assoc: asText(r.assoc), status: asStatus(r.status), from: validYmd(r.from), to: validYmd(r.to), next: validYmd(r.next) }))
        .filter(r => !recEmpty(r) && (!recEnd(r) || recEnd(r) >= eduKeepFrom()))
        .sort((a, b) => (recEnd(b) || b.next || '9999').localeCompare(recEnd(a) || a.next || '9999'));
}
const isDone = (r) => (r.status === '이수' || !r.status) && !!recEnd(r);
// 기록 한 건의 유효 기한: 종료일 + 3년 - 1일 (기타·철도운전은 유효기간을 직접 적었으면 그 날짜)
function recExpiry(r, k) {
    if (['etc', 'drive'].includes(k) && r.next) return r.next;
    return recEnd(r) ? addYearsYmd(recEnd(r), EDU_VALID_YEARS, -1) : (r.next || '');
}
// 칸의 현재 유효 기한 = 가장 최근 이수 기록의 유효 기한 (이수 기록이 없으면 예전 '다음 기한' 값)
function slotExpiry(m, k) {
    const recs = eduRecs(m, k);
    const done = recs.find(isDone);
    if (done) return recExpiry(done, k);
    const legacy = recs.find(r => r.next);
    return legacy ? legacy.next : '';
}
// 가장 가까운 교육 기한 (모든 칸 중)
function nextDueOf(m) {
    const dates = EDU_SLOTS.map(s => slotExpiry(m, s.k)).filter(Boolean).sort();
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
// 👤 협회 관리 = 직원정보 명단 기반 (2026-11-24 구조 변경)
//   사람 · 이름 · 부서 · 직급 · 연락처 ← 직원정보(hr_staff.info) / 가입 협회 · 분야 · 등급 · 회사등록 · 자격증 ← 직원경력(hr_staff.career)
//   여기서 저장하는 것은 교육 기록 · 메모뿐 → hr_edu 컬렉션 (문서 ID = 직원정보 문서 ID, 이름을 고쳐도 그대로 연결)
//   보이는 사람: 퇴사 안 했고, 직원경력에 협회가 있거나 교육 기록이 있는 사람
//   예전 협회 명단(association_members)은 지우지 않고 보관 · 처음 한 번 「교육 기록 옮기기」로 hr_edu 에 옮김(hr_meta/assoc 에 표시)
function loadHrForAssoc() {
    if (typeof HR !== 'undefined' && HR.loaded) return Promise.resolve(HR.people);
    return db.collection('hr_staff').get()
        .then(snap => { const people = snap.docs.map(d => ({ id: d.id, ...d.data() })); if (typeof HR !== 'undefined') { HR.people = people; HR.loaded = true; } return people; });
}
function buildAssocMembers(people, eduById) {
    return people.filter(p => !p.resigned).map(p => {
        const i = p.info || {}, c = p.career || {}, e = eduById[p.id] || {};
        const keys = assocKeysFrom(c.group);
        return {
            id: p.id, name: p.name, department: i.department || c.department || '', position: i.position || c.position || '',
            hireDate: i.hireDate || '', birth: i.birth || '', phone: i.phone || '', email: i.email || '',
            assocs: ASSOCS.map(a => a.k).filter(k => keys.includes(k)),
            field: c.field || '', grade: c.grade || '', companyReg: c.companyReg ?? null, license: c.license || '', licenseDate: c.licenseDate || '',
            edu: e.edu || {}, memo: e.memo || '',
        };
    }).filter(m => m.assocs.length || EDU_SLOTS.some(s => eduRecs(m, s.k).length));
}
function assocLoadError(err) {
    console.error('협회 관리 불러오기 실패:', err);
    document.getElementById('assoc-tbody').innerHTML = `<tr><td colspan="5" style="color: var(--danger-color);">협회 관리를 불러오지 못했어요.${err && err.code === 'permission-denied' ? '<br><small>Firebase 콘솔 > Firestore > 규칙에 hr_ 규칙(관리자만)을 게시했는지 확인해 주세요.</small>' : ''}</td></tr>`;
}
function openAssocTab() {
    document.getElementById('assoc-tbody').innerHTML = `<tr><td colspan="5" style="color: #888;">불러오는 중...</td></tr>`;
    Promise.all([loadHrForAssoc(), db.collection('hr_edu').get(), db.collection('hr_meta').doc('assoc').get()]).then(([people, eduSnap, meta]) => {
        AS.people = people;
        AS.eduById = {};
        eduSnap.docs.forEach(d => { AS.eduById[d.id] = d.data(); });
        const migrated = meta.exists;
        if (!migrated) {
            // 처음: 예전 협회 명단이 있으면 옮기기 화면부터
            return db.collection('association_members').get().then(old => {
                if (old.empty) { showAssocMain(people); return; }
                AS.oldMembers = old.docs.map(d => ({ id: d.id, ...d.data() }));
                renderAssocMigration();
            }).catch(() => showAssocMain(people));
        }
        showAssocMain(people);
    }).catch(assocLoadError);
}
function showAssocMain(people) {
    document.getElementById('assoc-migrate').style.display = 'none';
    document.querySelector('#assoc-admin-section .lv-subtabs').style.display = '';
    AS.members = buildAssocMembers(people, AS.eduById || {});
    AS.loaded = true;
    renderAssoc();
    switchAssocSubTab(AS.subTab || localStorage.getItem('assocSubTab') || 'apply');
}

// ------------------------------------------
// 🔁 처음 한 번: 예전 협회 명단의 교육 기록 → 직원정보의 사람에게 옮기기 (이름이 같으면 자동, 다르면 골라서)
// ------------------------------------------
function renderAssocMigration() {
    ['list', 'byassoc', 'apply'].forEach(t => { document.getElementById(`assoc-${t}-pane`).style.display = 'none'; });
    document.querySelector('#assoc-admin-section .lv-subtabs').style.display = 'none';
    const box = document.getElementById('assoc-migrate');
    box.style.display = '';
    const people = AS.people.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
    const rows = AS.oldMembers.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko')).map(o => {
        const match = people.find(p => (p.name || '').trim() === (o.name || '').trim());
        const nEdu = EDU_SLOTS.reduce((n, s) => n + eduRecs(o, s.k).length, 0);
        return { o, match, nEdu };
    });
    const auto = rows.filter(r => r.match).length;
    box.innerHTML = `
        <div class="as-guide" style="background: #fff9db; border-color: #ffe066;"><div class="as-guide-b" style="padding-top: 12px;">
            <b>🔁 협회 관리가 직원정보 명단을 쓰도록 바뀌었어요 — 처음 한 번만 교육 기록을 옮겨 주세요</b><br>
            예전 협회 명단 <b>${rows.length}명</b> 중 <b>${auto}명</b>은 직원정보에 같은 이름이 있어 자동으로 연결했어요.
            ${rows.length - auto ? `<b class="red">${rows.length - auto}명</b>은 누구인지 골라 주세요(직원정보에 없으면 「옮기지 않음」).` : ''}<br>
            <small>옮기는 것: 교육 기록 · 메모 · (직원경력에 협회가 비어 있는 사람은) 가입 협회 · 예전 협회 명단은 지우지 않고 그대로 보관해요.</small>
        </div></div>
        <div class="staff-wrap hr-wrap" style="max-height: 60vh;"><table class="staff-tbl hr-tbl">
            <thead><tr><th class="l" style="width: 140px;">예전 협회 명단</th><th style="width: 90px;">교육 기록</th><th class="l">연결할 직원 (직원정보)</th></tr></thead>
            <tbody>${rows.map(({ o, match, nEdu }) => `<tr class="${match ? '' : 'as-mig-need'}">
                <td class="l"><b>${esc(o.name)}</b><small>${esc([o.department, o.position].filter(Boolean).join(' · '))}</small></td>
                <td>${nEdu}건</td>
                <td class="l"><select class="hr-sel as-mig-sel" data-old="${o.id}" style="min-width: 240px;">
                    <option value="">— 옮기지 않음 —</option>
                    ${people.map(p => `<option value="${p.id}" ${match && match.id === p.id ? 'selected' : ''}>${esc(p.name)} · ${esc(((p.info || {}).department) || '')}${p.resigned ? ' (퇴사)' : ''}</option>`).join('')}
                </select>${match ? ' <span class="as-pill ok">자동 연결</span>' : ' <span class="as-pill bad">골라 주세요</span>'}</td></tr>`).join('')}</tbody>
        </table></div>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;">
            <button class="pay-btn blue" onclick="runAssocMigration()">교육 기록 옮기기</button>
        </div>`;
}
function mergeEduDocs(list) {
    const edu = {};
    EDU_SLOTS.forEach(s => {
        const seen = new Set(), records = [];
        list.forEach(m => eduRecs(m, s.k).forEach(r => {
            const key = `${r.from}|${r.to}|${r.status}|${r.next}`;
            if (seen.has(key)) return;
            seen.add(key);
            const o = { ...r }; Object.keys(o).forEach(x => { if (!o[x]) delete o[x]; });
            records.push(o);
        }));
        if (records.length) edu[s.k] = { records };
    });
    return edu;
}
function runAssocMigration() {
    const picks = Array.from(document.querySelectorAll('.as-mig-sel')).map(sel => ({ old: AS.oldMembers.find(o => o.id === sel.dataset.old), to: sel.value }));
    const skipped = picks.filter(x => !x.to).length;
    if (!confirm(`교육 기록을 옮길까요?\n연결 ${picks.length - skipped}명 · 옮기지 않음 ${skipped}명\n(예전 협회 명단은 지우지 않고 보관해요)`)) return;
    const byTo = {};
    picks.filter(x => x.to).forEach(x => { (byTo[x.to] = byTo[x.to] || []).push(x.old); });
    const batch = db.batch();
    Object.entries(byTo).forEach(([hrId, olds]) => {
        const cur = AS.eduById[hrId] || {};
        const edu = mergeEduDocs([cur, ...olds]);
        const memo = [cur.memo, ...olds.map(o => o.memo)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
        batch.set(db.collection('hr_edu').doc(hrId), { edu, memo, migratedFrom: olds.map(o => o.id), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        // 직원경력에 협회가 비어 있으면 예전 협회 명단의 가입 협회를 채워 둠 (협회 관리에서 빠지지 않게)
        const p = AS.people.find(x => x.id === hrId);
        const oldAssocs = [...new Set(olds.flatMap(o => o.assocs || []))];
        if (p && oldAssocs.length && !assocKeysFrom((p.career || {}).group).length) {
            const group = ASSOCS.filter(a => oldAssocs.includes(a.k)).map(a => a.label).join(', ');
            const career = { ...(p.career || {}), group };
            const history = (p.history || []).concat([{ at: hrNow(), changes: [{ label: '[경력] 구분(협회)', from: '', to: `${group} (협회 명단에서 옮김)` }] }]).slice(-50);
            batch.update(db.collection('hr_staff').doc(hrId), { career, history });
            p.career = career; p.history = history;
        }
    });
    batch.set(db.collection('hr_meta').doc('assoc'), { migratedAt: firebase.firestore.FieldValue.serverTimestamp(), moved: Object.keys(byTo).length, skipped });
    batch.commit().then(() => { alert('옮겼어요. 이제 협회 관리는 직원정보 명단을 써요.'); openAssocTab(); })
        .catch(err => { console.error('교육 기록 옮기기 실패:', err); alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요. Firebase 규칙(hr_)을 확인해 주세요.' : '옮기는 중 오류가 발생했어요.'); });
}

function setAssocFilter(key, value) {
    AS.filter[key] = value;
    const el = document.getElementById('assoc-' + (key === 'q' ? 'search' : key));
    if (el && el.value !== value) el.value = value;
    renderAssoc();
}
function resetAssocFilter() {
    AS.filter = { assoc: '', due: '', q: AS.filter.q };   // 검색어는 그대로, 협회·상태 필터만 풂
    renderAssoc();
}
function sortAssoc(key) { AS.sort = AS.sort.key === key ? { key, dir: -AS.sort.dir } : { key, dir: 1 }; renderAssoc(); }

const eduEmpty = (m, k) => !eduRecs(m, k).length;
const hasNeed = (m) => EDU_SLOTS.some(s => { const r = eduRecs(m, s.k)[0]; return r && r.status === '신청필요'; });

// ------------------------------------------
// 📅 다음 교육 신청 (교육 신청 탭 · 명단 맨 오른쪽 칸)
//  - 설계 1·2 · 감리 1·2 (전기기술인협회 · 정보통신공사협회): 연초 일괄 접수 → 유효기간 만료 6개월 전이 속한 해의 1월 접수
//  - 기타 교육 · 철도운전: 수시 → 유효기간 만료 6개월 전까지 신청
//  - 무효(유효기간 지남)면 '지금 신청' · 원래 1월 접수가 지났으면 다음 1월 접수에 '촉박', 그 전에 만료되면 '접수 놓침'
// ------------------------------------------
const EDU_APPLY_MONTHS = 6;
const JAN_BATCH_SLOTS = ['d1', 'd2', 's1', 's2'];
function addMonthsYmd(ymd, months) {
    const d = parseYmd(ymd), day = d.getDate();
    d.setDate(1); d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    return toYmd(d);
}
// 교육 칸이 어느 협회 것인지 (설계·감리 = 전기기술인협회, 기타·철도운전 = 기록에 적힌 협회)
function slotAssocLabel(m, k) {
    // 설계·감리: 기록에 적힌 협회 (통신이면 정보통신공사협회, 없으면 전기기술인협회) - 둘 다 1월 일괄 접수
    if (JAN_BATCH_SLOTS.includes(k)) {
        const recs = eduRecs(m, k);
        const text = (recs.find(x => x.assoc) || {}).assoc || '';
        return assocKeysFrom(text).includes('ict') ? '정보통신공사협회' : '전기기술인협회';
    }
    const text = (eduRecs(m, k)[0] || {}).assoc || '';
    const key = assocKeysFrom(text)[0] || (k === 'drive' ? 'drive' : '');
    const a = ASSOCS.find(x => x.k === key);
    return a ? a.label : (asText(text).replace(/^\(사\)/, '') || (k === 'drive' ? '철도운전협회' : '기타 협회'));
}
// 협회별 과정 이름 (화면에 보이는 이름) - 칸 기본 이름은 EDU_SLOTS.label
//   전기기술인협회: 설계기본과정·설계심화과정·감리기본과정·감리심화과정 (1 = 기본) · 정보통신공사협회: 설계 (1)·(2) 그대로
//   전기철도협회·철도운전협회·철도신호협회: 정기교육
const COURSE_NAMES = {
    '전기기술인협회': { d1: '설계기본과정', d2: '설계심화과정', s1: '감리기본과정', s2: '감리심화과정' },
    '전기철도협회': { etc: '정기교육', drive: '정기교육' },
    '철도운전협회': { etc: '정기교육', drive: '정기교육' },
    '철도신호협회': { etc: '정기교육', drive: '정기교육' },
};
function courseName(assocLabel, k) {
    return (COURSE_NAMES[assocLabel] || {})[k] || EDU_SLOTS.find(s => s.k === k).label;
}
// 칸 하나의 다음 신청 정보: { k, kind: now|missed|jan|any, year, date, applied, sortKey, text, cls }
// 📌 필수 과정: 직원경력의 협회 · 분야로 정해짐 → 이수 기록이 없으면 '신청필요(미이수)'
//   전기기술인협회: 분야에 '설계' → 설계기본·설계심화 / '감리' → 감리기본·감리심화 (설계/감리면 넷 다)
//   정보통신공사협회: 분야에 '설계' → 설계 (1)·(2) / '감리' → 감리 (1)·(2)
//   (협회에 기술자로 등록됐으면 그 분야 교육 2개는 무조건 이수 - 2026-11-24 확인)
function requiredSlotsOf(m) {
    const out = {}, field = String(m.field || ''), assocs = m.assocs || [];
    const design = /설계/.test(field), supervise = /감리/.test(field);
    if (assocs.includes('elec')) {
        if (design) { out.d1 = '전기기술인협회'; out.d2 = '전기기술인협회'; }
        if (supervise) { out.s1 = '전기기술인협회'; out.s2 = '전기기술인협회'; }
    }
    if (assocs.includes('ict')) {
        if (design) { out.d1 = out.d1 || '정보통신공사협회'; out.d2 = out.d2 || '정보통신공사협회'; }
        if (supervise) { out.s1 = out.s1 || '정보통신공사협회'; out.s2 = out.s2 || '정보통신공사협회'; }
    }
    return out;
}
// 이수 기록이 없는데 필수이거나 '신청필요'로 적힌 칸 → 다가오는 1월 접수 대상 (신청완료·대기면 이미 신청함)
function missingInfoOf(m, k) {
    const recs = eduRecs(m, k), latest = recs[0] || {};
    if (recs.some(isDone)) return null;
    const req = requiredSlotsOf(m)[k];
    if (!req && latest.status !== '신청필요' && !['신청완료', '신청대기'].includes(latest.status)) return null;
    if (!req && !recs.length) return null;
    const assoc = req || slotAssocLabel(m, k);
    const year = assocApplyYears()[0];
    const applied = ['신청완료', '신청대기'].includes(latest.status);
    return { k, exp: '', applied, missing: true, assoc, label: courseName(assoc, k), kind: JAN_BATCH_SLOTS.includes(k) ? 'jan' : 'any',
        year, sortKey: `${year}-01-00`, date: JAN_BATCH_SLOTS.includes(k) ? '' : asToday(), window: '1월~12월',
        text: JAN_BATCH_SLOTS.includes(k) ? `${String(year).slice(2)}년 1월 접수 (미이수)` : '신청필요 (미이수)', cls: 'soon' };
}
function applyInfoOf(m, k) {
    const exp = slotExpiry(m, k);
    if (!exp) return missingInfoOf(m, k);
    const recs = eduRecs(m, k);
    const latest = recs[0] || {};
    const applied = !isDone(latest) && ['신청완료', '신청대기'].includes(latest.status);
    const today = asToday(), thisYear = Number(today.slice(0, 4));
    const applyBy = addMonthsYmd(exp, -EDU_APPLY_MONTHS);
    const assoc = slotAssocLabel(m, k);
    const base = { k, exp, applied, assoc, label: courseName(assoc, k) };
    if (exp < today) return { ...base, kind: 'now', year: thisYear, sortKey: '0', text: '지금 신청 (무효)', cls: 'bad' };
    if (JAN_BATCH_SLOTS.includes(k)) {
        const year = Number(applyBy.slice(0, 4));
        // 교육 받을 기간(window): 그 해 1월(접수 열림) ~ 만료 6개월 전 달
        // 원래 접수할 1월이 이미 지났으면(올해 2월 이후 포함) → 다음 1월 접수로 넘기고 기간은 1월 ~ 만료되는 달(다음 해면 12월)
        //   다음 1월 접수가 만료일보다 늦으면 '접수 놓침'(빨강)
        if (year < thisYear || (year === thisYear && Number(today.slice(5, 7)) > 1)) {
            const nextBatch = Number(today.slice(5, 7)) > 1 ? thisYear + 1 : thisYear;
            if (exp >= `${nextBatch}-01-01`) {
                const toM = Number(exp.slice(0, 4)) > nextBatch ? 12 : Number(exp.slice(5, 7));
                return { ...base, kind: 'jan', tight: true, year: nextBatch, sortKey: `${nextBatch}-01-00`, window: toM > 1 ? `1월~${toM}월` : '1월', text: `${String(nextBatch).slice(2)}년 1월 접수`, cls: 'soon' };
            }
            return { ...base, kind: 'missed', year: thisYear, sortKey: '1', text: '1월 접수 놓침 · 추가 접수 확인', cls: 'bad' };
        }
        const toM = Number(applyBy.slice(5, 7));
        return { ...base, kind: 'jan', year, sortKey: `${year}-01-${pad2(toM)}`, window: toM > 1 ? `1월~${toM}월` : '1월', text: `${String(year).slice(2)}년 1월 접수`, cls: year === thisYear ? 'soon' : 'ok' };
    }
    const late = applyBy < today;
    return { ...base, kind: 'any', year: late ? thisYear : Number(applyBy.slice(0, 4)), date: applyBy, sortKey: late ? '2' : applyBy,
        text: late ? `${asShort(applyBy)}까지 (지남)` : `${asShort(applyBy)}까지 신청`, cls: late ? 'bad' : asDaysTo(applyBy) <= ASSOC_SOON_DAYS ? 'soon' : 'ok' };
}
function applyInfosOf(m) {
    // 아직 신청 안 한 것 먼저 (신청완료·대기는 뒤로), 그 안에서 급한 순
    return EDU_SLOTS.map(s => applyInfoOf(m, s.k)).filter(Boolean).sort((a, b) => (a.applied - b.applied) || a.sortKey.localeCompare(b.sortKey));
}
// 명단 맨 오른쪽 칸: 가장 급한 것 하나 (+ 나머지 수)
function nextApplyCell(m) {
    const list = applyInfosOf(m);
    if (!list.length) return '<span class="sub">-</span>';
    const a = list[0];
    return `<span class="as-apply ${a.applied ? 'applied' : a.cls}">${a.applied ? '신청완료' : a.text}</span><small>${a.label}${a.window && !a.applied ? ` · 교육 ${a.window}` : ''}${list.length > 1 ? ` · +${list.length - 1}` : ''}</small>`;
}

// 교육 신청 탭 (1안: 협회별 → 과정별 → 신청할 사람)
// 고를 수 있는 해: 1월이면 올해부터, 2월 이후면 다가오는 내년 접수부터 (4년치)
function assocApplyYears() {
    const t = asToday(), y = Number(t.slice(0, 4)) + (Number(t.slice(5, 7)) > 1 ? 1 : 0);
    return [y, y + 1, y + 2, y + 3];
}
const isUrgent = (a) => ['now', 'missed'].includes(a.kind) || (a.kind === 'any' && a.sortKey === '2');
// 그 해 신청할 것: 지금 바로(무효·놓침·수시 기한 지남)는 어느 해를 골라도 항상 + 그 해 1월 접수 + 그 해 수시(첫 해는 그 전 것까지)
function assocApplyItems(year) {
    const first = assocApplyYears()[0];
    const items = [];
    AS.members.forEach(m => applyInfosOf(m).forEach(a => {
        const show = isUrgent(a) || a.year === year || (year === first && a.kind === 'any' && a.year < year);
        if (show) items.push({ m, ...a });
    }));
    return items;
}
// 작은 탭 3개: 📌 할 일(apply) · 🏛 협회별 현황(byassoc) · 📋 전체 명단(list) - 새로고침해도 보던 탭 기억
function switchAssocSubTab(tab) {
    if (!['list', 'byassoc', 'apply'].includes(tab)) tab = 'apply';
    AS.subTab = tab;
    localStorage.setItem('assocSubTab', tab);
    ['list', 'byassoc', 'apply'].forEach(t => {
        document.getElementById(`assoc-${t}-pane`).style.display = tab === t ? '' : 'none';
        document.getElementById(`as-subtab-${t}`).classList.toggle('on', tab === t);
    });
    if (tab === 'apply') renderAssocApply();
    if (tab === 'byassoc') renderAssocByAssoc();
}
// ------------------------------------------
// 🏛 협회별 탭: 협회 카드 → 누르면 그 협회 사람만, 그 협회 과정 칸만 있는 표
// ------------------------------------------
const ASSOC_DEFAULT_SLOTS = { elec: ['d1', 'd2', 's1', 's2'], ict: ['d1', 'd2'] };
// 그 협회에 속한 사람 (협회 체크 또는 그 협회 교육 기록이 있는 사람)
function assocMembersOf(a) {
    return AS.members.filter(m => (m.assocs || []).includes(a.k) || EDU_SLOTS.some(s => eduRecs(m, s.k).length && slotAssocLabel(m, s.k) === a.label));
}
// 그 협회 표에 보일 과정 칸 (기본 칸 + 실제로 그 협회 기록이 있는 칸)
function assocSlotsOf(a, members) {
    const keys = new Set(ASSOC_DEFAULT_SLOTS[a.k] || []);
    members.forEach(m => EDU_SLOTS.forEach(s => { if (eduRecs(m, s.k).length && slotAssocLabel(m, s.k) === a.label) keys.add(s.k); }));
    return EDU_SLOTS.filter(s => keys.has(s.k));
}
function assocStats(a) {
    const members = assocMembersOf(a), first = assocApplyYears()[0];
    const mine = (m) => applyInfosOf(m).filter(x => x.assoc === a.label);
    const over = members.filter(m => mine(m).some(x => x.kind === 'now')).length;
    const target = members.filter(m => mine(m).some(x => !x.applied && (isUrgent(x) || x.year === first || (x.kind === 'any' && x.year < first)))).length;
    const need = members.filter(m => EDU_SLOTS.some(s => slotAssocLabel(m, s.k) === a.label && slotState(m, s.k) === 'need')).length;
    return { members, over, target, need, first };
}
function openAssocView(k) { AS.assocView = k || null; renderAssocByAssoc(); }
function renderAssocByAssoc() {
    const box = document.getElementById('assoc-byassoc-body');
    if (!box) return;
    const sel = ASSOCS.find(x => x.k === AS.assocView);
    // 위쪽: 협회 카드 (누르면 그 협회만, 다시 누르면 전체) · 아래: 협회마다 표를 이어서 (기술자가 바로 다 보이게)
    const cards = `<div class="as-agrid">${ASSOCS.map(x => {
        const st = assocStats(x), n = st.members.length;
        const pills = !n ? '<span class="as-pill gray">-</span>' : [
            st.over && `<span class="as-pill bad">무효 ${st.over}</span>`,
            st.target && `<span class="as-pill warn">${st.first}년 신청 대상 ${st.target}</span>`,
            st.need && `<span class="as-pill gray">신청필요 표시 ${st.need}</span>`,
        ].filter(Boolean).join('') || '<span class="as-pill ok">모두 유효</span>';
        return `<div class="as-acard2${n ? '' : ' empty'}${sel && sel.k === x.k ? ' on' : ''}" ${n ? `onclick="openAssocView('${sel && sel.k === x.k ? '' : x.k}')"` : ''}>
            <div class="t">${x.label}<span class="c">${n}<small>명</small></span></div><div class="s">${pills}</div></div>`;
    }).join('')}</div>`;
    const shown = (sel ? [sel] : ASSOCS).filter(a => assocMembersOf(a).length);
    box.innerHTML = cards + (shown.map(assocTableHtml).join('') || '<div class="pay-empty">협회 기술자가 없어요</div>')
        + `<div class="staff-foot">위쪽 협회 카드를 누르면 그 협회만, 다시 누르면 전체 · 줄을 누르면 수정 창 · 날짜 아래 ~날짜 = 유효기간 끝 · 빨강 = 무효</div>`;
}
// 협회 한 개의 표 (그 협회 사람만, 그 협회 과정 칸만)
function assocTableHtml(a) {
    const st = assocStats(a), slots = assocSlotsOf(a, st.members);
    const members = st.members.slice().sort((x, y) => (x.name || '').localeCompare(y.name || '', 'ko'));
    const cell = (m, k) => {
        const recs = eduRecs(m, k);
        if (!recs.length) return requiredSlotsOf(m)[k] === a.label ? '<span class="as-pill warn" title="필수 과정인데 이수 기록이 없어요">신청필요 · 미이수</span>' : '<span class="sub">-</span>';
        if (slotAssocLabel(m, k) !== a.label) return '<span class="sub">-</span>';
        const r = recs[0], state = slotState(m, k), exp = slotExpiry(m, k);
        const period = r.from ? `${asShort(r.from)}${r.to && r.to !== r.from ? '~' + asShort(r.to).slice(3) : ''}` : '';
        if (state === 'need') return '<span class="as-pill bad">신청필요</span>';
        if (state === 'applied') return `<span class="as-pill blue">${r.status}</span>${period ? `<small>${period}</small>` : ''}`;
        return `<span class="${state === 'over' ? 'as-red' : ''}">${period || r.status || '-'}</span>${exp ? `<small class="${state === 'over' ? 'as-red' : ''}">${state === 'over' ? '무효 · ' : '~'}${asShort(exp)}</small>` : ''}`;
    };
    const next = (m) => {
        const x = applyInfosOf(m).find(i => i.assoc === a.label);
        if (!x) return '<span class="sub">-</span>';
        return `<span class="as-apply ${x.applied ? 'applied' : x.cls}">${x.applied ? '신청완료' : x.text}</span><small>${x.label}${x.window && !x.applied ? ` · 교육 ${x.window}` : ''}</small>`;
    };
    return `<div class="as-asec">
        <div class="as-vhead"><b>${a.label} · ${members.length}명</b>
            ${st.over ? `<span class="as-pill bad">무효 ${st.over}</span>` : ''}${st.target ? `<span class="as-pill warn">${st.first}년 신청 대상 ${st.target}</span>` : ''}
            <button type="button" class="pay-btn sm" style="margin-left: auto;" onclick="downloadAssocViewExcel('${a.k}')">⬇ 엑셀 받기</button></div>
        <div class="staff-wrap"><table class="staff-tbl as-tbl">
            <thead><tr><th>이름</th><th>부서 · 직위</th><th>등급 · 분야</th>${slots.map(s => `<th>${courseName(a.label, s.k)}</th>`).join('')}<th>다음 교육 신청</th></tr></thead>
            <tbody>${members.map(m => `<tr onclick="openAssocModal('${m.id}')" title="눌러서 수정">
                <td><b>${esc(m.name)}</b></td><td>${esc(m.department || '-')}<small>${esc(m.position || '')}</small></td>
                <td>${esc(m.grade || '-')}<small>${esc(m.field || '')}</small></td>
                ${slots.map(s => `<td>${cell(m, s.k)}</td>`).join('')}<td>${next(m)}</td></tr>`).join('')}</tbody>
        </table></div></div>`;
}
function downloadAssocViewExcel(k) {
    const a = ASSOCS.find(x => x.k === k);
    if (!a) return;
    const st = assocStats(a), slots = assocSlotsOf(a, st.members);
    const head = ['이름', '부서', '직위', '등급', '분야', ...slots.flatMap(s => [`${courseName(a.label, s.k)} 최근 교육`, `${courseName(a.label, s.k)} 유효기간`]), '다음 교육 신청'];
    const rows = st.members.slice().sort((x, y) => (x.name || '').localeCompare(y.name || '', 'ko')).map(m => {
        const x = applyInfosOf(m).find(i => i.assoc === a.label);
        return [m.name, m.department || '', m.position || '', m.grade || '', m.field || '',
            ...slots.flatMap(s => { const own = slotAssocLabel(m, s.k) === a.label, r = own ? eduRecs(m, s.k)[0] : null;
                return r ? [`${r.from || ''}~${r.to || ''} ${r.status || ''}`.trim(), slotExpiry(m, s.k)] : ['', '']; }),
            x ? `${x.label} · ${x.applied ? '신청완료' : x.text}${x.window ? ` (${x.window})` : ''}` : ''];
    });
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, a.short);
    XLSX.writeFile(wb, `${a.label}_${asToday()}.xlsx`);
}

// 📌 할 일 탭 (문장형): 한 사람 · 한 교육마다 카드 한 장 - "누가 · 무슨 교육 → 언제 신청 · 언제까지 교육"
// 묶음 순서: 지금 바로 신청 → 그 해 1월 접수 → 날짜 전까지 신청(수시) → 이미 신청함
const fullDate = (ymd) => ymd ? `${Number(ymd.slice(0, 4))}년 ${Number(ymd.slice(5, 7))}월 ${Number(ymd.slice(8, 10))}일` : '';
const monthDay = (ymd) => ymd ? `${Number(ymd.slice(5, 7))}월 ${Number(ymd.slice(8, 10))}일` : '';
const windowText = (w) => (w || '').replace(/^1월~(\d+)월$/, '1~$1월');   // '1월~2월' → '1~2월'
function todoGroupOf(i) {
    if (i.applied) return 'done';
    if (isUrgent(i)) return 'now';
    return i.kind === 'jan' ? 'jan' : 'any';
}
function todoCardHtml(i) {
    const m = i.m, course = `${esc(i.assoc)} ${esc(i.label)}`;
    let what, why;
    if (i.applied) {
        const r = eduRecs(m, i.k)[0] || {};
        const period = r.from ? `${fullDate(r.from)}${r.to && r.to !== r.from ? `~${monthDay(r.to)}` : ''} 교육` : '';
        what = `${course} → ${esc(r.status || '신청완료')}${period ? ` (${period})` : ''}`;
        why = i.exp ? `지금 교육은 ${fullDate(i.exp)}까지 유효` : '';
    } else if (i.missing) {
        what = i.kind === 'jan' ? `${course} → <b>${i.year}년 1월 접수</b>에 신청` : `${course} → <b>신청 필요</b>`;
        why = '필수 과정인데 아직 이수 기록이 없어요';
    } else if (i.kind === 'now') {
        what = `${course} → <b>지금 바로 신청</b>`;
        why = `유효기간이 ${fullDate(i.exp)}에 이미 지났어요`;
    } else if (i.kind === 'missed') {
        what = `${course} → <b>지금 바로 협회에 추가 접수 확인</b>`;
        why = `${fullDate(i.exp)}까지 유효 · 1월 접수로는 끝나기 전에 교육을 받기 어려워요`;
    } else if (i.kind === 'any' && isUrgent(i)) {
        what = `${course} → <b>지금 바로 신청</b> (신청 권장일 ${monthDay(i.date)} 지남)`;
        why = `${fullDate(i.exp)}까지 유효 · 끝나기 6개월 전에 신청해 두는 게 좋아요`;
    } else if (i.kind === 'jan') {
        what = `${course} → <b>${i.year}년 1월 접수</b>, ${windowText(i.window)} 중 교육 받기`;
        why = `지금 교육은 ${fullDate(i.exp)}까지 유효`;
    } else {
        what = `${course} → <b>${fullDate(i.date)}까지 신청</b>`;
        why = `지금 교육은 ${fullDate(i.exp)}까지 유효`;
    }
    const g = todoGroupOf(i);
    return `<div class="as-todo ${g}" onclick="openAssocModal('${m.id}')" title="눌러서 수정">
        <div class="who">${esc(m.name)}<small>${[m.department, m.position].filter(Boolean).map(esc).join(' · ')}</small></div>
        <div class="what">${what}</div>${why ? `<div class="why">${why}</div>` : ''}</div>`;
}
function toggleAssocGuide() {
    const box = document.getElementById('assoc-guide');
    const closed = !box.classList.contains('closed');
    box.classList.toggle('closed', closed);
    localStorage.setItem('assocGuideClosed', closed ? '1' : '');
}
function renderAssocApply() {
    const sel = document.getElementById('assoc-apply-year');
    if (!sel) return;
    const guide = document.getElementById('assoc-guide');
    if (guide && !guide.dataset.init) { guide.dataset.init = '1'; guide.classList.toggle('closed', !!localStorage.getItem('assocGuideClosed')); }
    const years = assocApplyYears();
    if (!sel.options.length) sel.innerHTML = years.map(y => `<option value="${y}">${y}년</option>`).join('');
    const year = Number(sel.value) || years[0];
    const items = assocApplyItems(year);
    const nThis = assocApplyItems(years[0]).filter(i => !i.applied).length;
    document.getElementById('as-apply-count').innerText = nThis ? nThis : '';
    const order = { now: 0, missed: 1 };
    const sortIn = (a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2) || a.sortKey.localeCompare(b.sortKey) || a.m.name.localeCompare(b.m.name, 'ko');
    const groups = [
        { g: 'now', title: '지금 바로 신청', note: '유효기간이 지났거나 신청 시기를 놓친 교육' },
        { g: 'jan', title: `${year}년 1월 접수 때 신청`, note: '전기기술인협회 · 정보통신공사협회 (1년치를 1월에 한 번에)' },
        { g: 'any', title: '날짜 전까지 신청', note: '그 외 협회 정기교육 (유효기간 끝나기 6개월 전까지)' },
        { g: 'done', title: '이미 신청함', note: '' },
    ];
    const box = document.getElementById('assoc-apply-cards');
    if (!items.length) { box.innerHTML = `<div class="pay-empty">${year}년에 신청할 교육이 없어요.</div>`; return; }
    box.innerHTML = groups.map(({ g, title, note }) => {
        const list = items.filter(i => todoGroupOf(i) === g).sort(sortIn);
        if (!list.length) return '';
        return `<div class="as-todo-grp ${g}"><i class="dot"></i>${title}<b>${list.length}건</b>${note ? `<small>${note}</small>` : ''}</div>${list.map(todoCardHtml).join('')}`;
    }).join('');
}
// 신청 명단 엑셀 (고른 해) - 화면과 같은 묶음 순서 · 쉬운 칸 이름
function downloadAssocApplyExcel() {
    const year = Number(document.getElementById('assoc-apply-year').value);
    const gName = { now: '지금 바로 신청', jan: `${year}년 1월 접수 때 신청`, any: '날짜 전까지 신청', done: '이미 신청함' };
    const gOrder = { now: 0, jan: 1, any: 2, done: 3 };
    const items = assocApplyItems(year).sort((a, b) => gOrder[todoGroupOf(a)] - gOrder[todoGroupOf(b)] || a.sortKey.localeCompare(b.sortKey) || a.m.name.localeCompare(b.m.name, 'ko'));
    const when = (i) => i.applied ? '신청완료' : i.kind === 'now' ? '지금 바로' : i.kind === 'missed' ? '지금 바로 (협회에 추가 접수 확인)' : i.kind === 'jan' ? `${i.year}년 1월 접수` : isUrgent(i) ? `지금 바로 (권장일 ${i.date} 지남)` : `${i.date}까지`;
    const until = (i) => i.kind === 'jan' ? `${windowText(i.window)} 중` : i.exp ? `${i.exp} 전` : '';
    const rows = items.map(i => [gName[todoGroupOf(i)], i.m.name, i.m.department || '', i.m.position || '', i.assoc, i.label, when(i), until(i), i.exp]);
    const ws = XLSX.utils.aoa_to_sheet([['구분', '이름', '부서', '직위', '협회', '과정', '언제 신청', '언제까지 교육', '지금 유효기간'], ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `${year}년 신청 명단`);
    XLSX.writeFile(wb, `교육신청명단_${year}년_${asToday()}.xlsx`);
}

// 📋 기술자 명단 (2안): 필터 버튼 한 줄 + 5칸 표(이름 · 부서 · 협회 · 교육 상태 · 다음 신청) + 줄 누르면 아래로 펼쳐보기
// 교육 칸 하나의 지금 상태: need(신청필요) · applied(신청완료/대기) · over(무효) · ok(유효)
function slotState(m, k) {
    const recs = eduRecs(m, k);
    if (!recs.length) return requiredSlotsOf(m)[k] ? 'need' : '';
    const latest = recs[0];
    if (latest.status === '신청필요') return 'need';
    if (!isDone(latest) && ['신청완료', '신청대기'].includes(latest.status)) return 'applied';
    const exp = slotExpiry(m, k);
    return exp && exp < asToday() ? 'over' : 'ok';
}
function eduStateCell(m) {
    const cnt = { over: 0, need: 0, applied: 0, ok: 0 };
    EDU_SLOTS.forEach(s => { const st = slotState(m, s.k); if (st) cnt[st]++; });
    const pill = { over: ['bad', '무효'], need: ['bad', '신청필요'], applied: ['blue', '신청완료'], ok: ['ok', '유효'] };
    const html = Object.keys(pill).filter(k => cnt[k]).map(k => `<span class="as-pill ${pill[k][0]}">${pill[k][1]} ${cnt[k]}</span>`).join('');
    return html || '<span class="sub">-</span>';
}
// 펼쳐보기: 기본 정보 한 줄 + 교육 칸마다 최근 기록 · 유효기간 · 다음 신청
function assocDetailHtml(m) {
    const ap = applyInfosOf(m);
    const rows = EDU_SLOTS.filter(s => eduRecs(m, s.k).length).map(s => {
        const recs = eduRecs(m, s.k), r = recs[0], st = slotState(m, s.k), exp = slotExpiry(m, s.k);
        const period = r.from ? `${asShort(r.from)}${r.to && r.to !== r.from ? '~' + asShort(r.to).slice(3) : ''}` : '';
        const status = r.status || (r.from ? '이수' : '');
        const valid = st === 'over' ? `<span class="red">${asShort(exp)} 만료 (무효)</span>` : exp && st === 'ok' ? `~${asShort(exp)} 유효` : '';
        const a = ap.find(x => x.k === s.k);
        const apText = !a ? '' : a.applied ? '<span class="as-pill blue">신청완료</span>'
            : `<span class="as-pill ${a.cls === 'bad' ? 'bad' : a.cls === 'soon' ? 'warn' : 'gray'}">${a.text}${a.window ? ` · ${a.window}` : ''}</span>`;
        return `<div class="as-drow"><span class="k">${courseName(slotAssocLabel(m, s.k), s.k)}<small>${esc(slotAssocLabel(m, s.k))}</small></span>
            <span>${period ? `${period} ` : ''}${status}${valid ? ` · ${valid}` : ''}${recs.length > 1 ? ` <small class="sub">이전 ${recs.length - 1}건</small>` : ''}</span>${apText}</div>`;
    }).join('') || '<div class="as-drow"><span class="sub">교육 기록이 없어요</span></div>';
    const info = [m.grade && `${esc(m.grade)}${m.field ? ` · ${esc(m.field)}` : ''}`, m.companyReg === true ? '회사등록 Y' : m.companyReg === false ? '회사등록 N' : '', m.license && esc(m.license), m.memo && `📝 ${esc(m.memo)}`].filter(Boolean).join('　·　');
    return `<div class="as-drawer"><div class="as-dh"><b>${esc(m.name)}</b><span class="sub">${info}</span>
        <button type="button" class="pay-btn sm" onclick="event.stopPropagation(); openAssocModal('${m.id}')">✏️ 수정</button></div>${rows}</div>`;
}
function toggleAssocRow(id) { AS.openId = AS.openId === id ? null : id; renderAssoc(); }
function toggleAssocMenu(ev) {
    ev.stopPropagation();
    const menu = document.getElementById('assoc-more-menu');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
document.addEventListener('click', () => { const menu = document.getElementById('assoc-more-menu'); if (menu) menu.style.display = 'none'; });

function renderAssoc() {
    const tbody = document.getElementById('assoc-tbody');
    if (!tbody) return;
    // '신청 대상' = 교육 신청 탭 첫 해(다가오는 1월 접수)에 신청할 사람 (이미 신청한 건 제외)
    const thisYear = assocApplyYears()[0];
    const all = AS.members.map(m => ({ m, ap: applyInfosOf(m) }));
    const isOver = (r) => r.ap.some(a => a.kind === 'now');
    const isThisYear = (r) => r.ap.some(a => !a.applied && (isUrgent(a) || a.year === thisYear || (a.kind === 'any' && a.year < thisYear)));
    // 「교육 신청」 탭 이름 옆 숫자 (명단 탭에 있어도 보이게)
    const badge = document.getElementById('as-apply-count');
    if (badge) { const n = assocApplyItems(thisYear).filter(i => !i.applied).length; badge.innerText = n || ''; }

    // 필터 버튼 한 줄: 전체 · 협회별 인원 | 무효 · 신청 대상 · 신청필요 (다시 누르면 풀림)
    const cnt = (k) => all.filter(r => (r.m.assocs || []).includes(k)).length;
    const over = all.filter(isOver).length, soon = all.filter(isThisYear).length, need = all.filter(r => hasNeed(r.m)).length;
    const f = AS.filter;
    const chip = (label, n, on, onclick, cls = '') => `<button type="button" class="as-fc ${cls}${on ? ' on' : ''}" onclick="${onclick}">${label}<b>${n}</b></button>`;
    document.getElementById('assoc-kpis').innerHTML = `<div class="as-fchips">
        ${chip('전체', all.length, !f.assoc && !f.due, 'resetAssocFilter()')}
        ${ASSOCS.filter(a => cnt(a.k)).map(a => chip(a.short, cnt(a.k), f.assoc === a.k, `setAssocFilter('assoc','${f.assoc === a.k ? '' : a.k}')`)).join('')}
        <span class="as-fsep"></span>
        ${chip('무효', over, f.due === 'over', `setAssocFilter('due','${f.due === 'over' ? '' : 'over'}')`, over ? 'bad' : '')}
        ${chip(`${thisYear}년 신청 대상`, soon, f.due === 'soon', `setAssocFilter('due','${f.due === 'soon' ? '' : 'soon'}')`, soon ? 'warn' : '')}
        ${need ? chip('신청필요 표시', need, f.due === 'need', `setAssocFilter('due','${f.due === 'need' ? '' : 'need'}')`, 'warn') : ''}</div>`;

    // 거르기
    const q = f.q.trim();
    const list = all.filter(r =>
        (!f.assoc || (r.m.assocs || []).includes(f.assoc))
        && (!q || [r.m.name, r.m.department, r.m.position].some(v => String(v || '').includes(q)))
        && (!f.due || (f.due === 'need' ? hasNeed(r.m) : f.due === 'soon' ? isThisYear(r) : isOver(r))));

    // 정렬 (빈 값은 맨 아래)
    const keyOf = { name: r => r.m.name || null, dept: r => r.m.department || null, due: r => (r.ap[0] && r.ap[0].sortKey) || null }[AS.sort.key] || (r => r.m.name || null);
    list.sort((a, b) => {
        const x = keyOf(a), y = keyOf(b), byName = (a.m.name || '').localeCompare(b.m.name || '', 'ko');
        if (x === null || y === null) return x === y ? byName : (x === null ? 1 : -1);
        return AS.sort.dir * String(x).localeCompare(String(y), 'ko') || byName;
    });
    const th = (k, label) => `<th class="sortable" onclick="sortAssoc('${k}')">${label} <span class="arr${AS.sort.key === k ? ' on' : ''}">${AS.sort.key === k ? (AS.sort.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
    document.getElementById('assoc-head').innerHTML = `${th('name', '이름')}${th('dept', '부서 · 직위')}<th>협회</th><th>교육 상태</th>${th('due', '다음 교육 신청')}`;
    document.getElementById('assoc-count').innerText = `${list.length}명`;

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="color: #888;">${AS.members.length ? '조건에 맞는 기술자가 없어요' : '아직 명단이 없어요. [⋯] → 직원명단 엑셀에서 가져오기로 한 번에 넣을 수 있어요.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(({ m }) => {
        const chips = (m.assocs || []).map(k => { const a = ASSOCS.find(x => x.k === k); return a ? `<span class="as-assoc as-${k}" title="${a.label}">${a.short}</span>` : ''; }).join('');
        const open = AS.openId === m.id;
        return `<tr class="as-row${open ? ' open' : ''}" onclick="toggleAssocRow('${m.id}')" title="눌러서 교육 자세히 보기">
            <td><b>${esc(m.name)}</b></td>
            <td>${esc(m.department || '-')}<small>${esc(m.position || '')}</small></td>
            <td class="l">${chips || '<span class="sub">-</span>'}</td>
            <td class="l">${eduStateCell(m)}</td>
            <td>${nextApplyCell(m)}</td>
        </tr>${open ? `<tr class="as-detail"><td colspan="5">${assocDetailHtml(m)}</td></tr>` : ''}`;
    }).join('');
}

// ------------------------------------------
// 수정 창 (기술자 한 명)
// ------------------------------------------
// 수정 창 교육 카드 (1안): 칸마다 카드 하나, 기록은 최신순으로 전부 · 최근 교육이 무효면 노란 「새 교육 입력」 줄 자동 표시
function eduValidText(m, k) {
    const recs = eduRecs(m, k);
    if (!recs.length) return { cls: 'gray', text: '기록 없음' };
    const exp = slotExpiry(m, k);
    if (!exp) return { cls: 'gray', text: recs[0].status || '-' };
    const d = asDaysTo(exp);
    if (d < 0) return { cls: 'bad', text: `무효 · ${-d}일 지남` };
    return { cls: d <= ASSOC_SOON_DAYS ? 'soon' : 'ok', text: `유효 · ${asShort(exp)}까지${d <= ASSOC_SOON_DAYS ? ` (${d}일 남음)` : ''}` };
}
function eduRecRowHtml(k, r, kind) {
    const v = (x) => esc(x || '');
    const exp = kind === 'new' ? '' : (isDone(r) ? recExpiry(r, k) : '');
    const expTxt = exp ? (asDaysTo(exp) < 0 ? `${asShort(exp)} 만료` : `${asShort(exp)}까지`) : '';
    const label = { new: '＋ 새 교육', cur: '최근', old: '이전' }[kind];
    const hasNext = ['etc', 'drive'].includes(k);
    return `<div class="as-rec ${kind}${exp && asDaysTo(exp) < 0 ? ' expired' : ''}">
        <span class="k">${label}</span>
        <span class="row"><input type="date" class="r-from" value="${v(r.from)}" title="시작(수료)일"> ~ <input type="date" class="r-to" value="${v(r.to)}" title="종료일"></span>
        <input class="r-assoc" value="${v(r.assoc)}" placeholder="협회">
        <select class="r-status">${EDU_STATUSES.map(st => `<option ${(r.status || '이수') === st ? 'selected' : ''}>${st}</option>`).join('')}</select>
        ${hasNext ? `<input type="date" class="r-next" value="${v(r.next)}" title="유효기간 (비우면 종료일 + 3년 - 1일)">` : ''}
        <span class="exp${hasNext ? '' : ' wide'}">${expTxt}</span>
        <button type="button" class="x" title="이 기록 지우기" onclick="this.closest('.as-rec').remove()">×</button>
    </div>`;
}
// 카드 제목: 기록이 있으면 그 협회의 과정 이름, 없으면 (전기기술인협회 회원의 설계·감리는 전기 과정 이름) 기본 이름
function eduSlotTitle(m, s) {
    if (eduRecs(m, s.k).length) return courseName(slotAssocLabel(m, s.k), s.k);
    return JAN_BATCH_SLOTS.includes(s.k) && (m.assocs || []).includes('elec') ? courseName('전기기술인협회', s.k) : s.label;
}
function eduSlotHtml(m, s) {
    const recs = eduRecs(m, s.k);
    const vt = eduValidText(m, s.k);
    const latestPending = recs[0] && !isDone(recs[0]);
    const needNew = recs.length && vt.cls === 'bad' && !latestPending;
    const lastAssoc = (recs[0] && recs[0].assoc) || '';
    return `<div class="as-slot" data-k="${s.k}">
        <div class="as-slot-h"><b>${eduSlotTitle(m, s)}</b>${eduRecs(m, s.k).length ? `<small class="sub">${esc(slotAssocLabel(m, s.k))}</small>` : ''}<span class="as-valid ${vt.cls}">${vt.text}</span>
            <button type="button" class="as-add" onclick="addEduRow('${s.k}')">＋ 교육 추가</button></div>
        <div class="as-recs">
            ${needNew ? eduRecRowHtml(s.k, { assoc: lastAssoc, status: '이수' }, 'new') : ''}
            ${recs.map((r, i) => eduRecRowHtml(s.k, r, i === 0 ? 'cur' : 'old')).join('')}
        </div></div>`;
}
function addEduRow(k) {
    const box = document.querySelector(`.as-slot[data-k="${k}"] .as-recs`);
    if (!box) return;
    if (box.querySelector('.as-rec.new')) { box.querySelector('.as-rec.new .r-from').focus(); return; }
    const first = box.querySelector('.r-assoc');
    box.insertAdjacentHTML('afterbegin', eduRecRowHtml(k, { assoc: first ? first.value : '', status: '이수' }, 'new'));
    box.querySelector('.as-rec.new .r-from').focus();
}
// 수정 창의 교육 카드 → 저장할 모양 { 칸: { records: [...] } } (빈 줄·10년 지난 기록은 뺌)
function collectEduFromModal() {
    const edu = {};
    document.querySelectorAll('#assoc-modal-body .as-slot').forEach(slot => {
        const k = slot.dataset.k;
        const records = Array.from(slot.querySelectorAll('.as-rec')).map(row => {
            const val = (c) => ((row.querySelector('.' + c) || {}).value || '').trim();
            const r = { assoc: val('r-assoc'), status: val('r-status'), from: val('r-from'), to: val('r-to'), next: val('r-next') };
            if (r.from && r.to && r.to < r.from) [r.from, r.to] = [r.to, r.from];
            return r;
        }).filter(r => !recEmpty(r) && (!recEnd(r) || recEnd(r) >= eduKeepFrom()))
            .map(r => { Object.keys(r).forEach(x => { if (!r[x]) delete r[x]; }); return r; });
        if (records.length) edu[k] = { records };
    });
    return edu;
}
// 엑셀 가져오기: 이미 있는 이력은 그대로 두고, 같은 기간 기록은 엑셀 값으로 갱신 · 새 기간이면 추가
function mergeEduImport(oldMember, newEdu) {
    const edu = {};
    EDU_SLOTS.forEach(s => {
        const recs = oldMember ? eduRecs(oldMember, s.k) : [];
        const imp = newEdu[s.k] ? eduRecs({ edu: { [s.k]: newEdu[s.k] } }, s.k)[0] : null;
        if (imp) {
            const same = recs.find(r => (r.from && r.from === imp.from) || (r.to && r.to === imp.to) || (!recEnd(r) && !recEnd(imp)));
            if (same) Object.keys(imp).forEach(x => { if (imp[x]) same[x] = imp[x]; });
            else recs.push(imp);
        }
        const records = recs.map(r => { const o = { ...r }; Object.keys(o).forEach(x => { if (!o[x]) delete o[x]; }); return o; });
        if (records.length) edu[s.k] = { records };
    });
    return edu;
}

// 수정 창: 사람 정보는 보기만(고치기는 직원정보·직원경력 창으로 바로 이동) · 여기서는 교육 기록 · 메모만 고침
function openAssocModal(id) {
    AS.editingId = id;
    const m = AS.members.find(x => x.id === id);
    if (!m) return;
    const v = (x) => esc(x || '') || '<span class="sub">-</span>';
    const chips = (m.assocs || []).map(k => { const a = ASSOCS.find(x => x.k === k); return `<span class="as-assoc as-${k}">${a.short}</span>`; }).join('') || '<span class="sub">-</span>';
    document.getElementById('assoc-modal-title').innerText = `기술자 정보 · ${m.name}`;
    document.getElementById('assoc-modal-body').innerHTML = `
        <div class="pay-grp"><div class="gh" style="display: flex; align-items: center;">기본 정보 <span class="sub" style="font-weight: normal; font-size: 12px; margin-left: 8px;">직원정보 관리</span>
            <button type="button" class="pay-btn sm" style="margin-left: auto;" onclick="goHrFromAssoc('${m.id}', 'info')">✏️ 직원정보에서 고치기</button></div>
            <div class="as-ro">
                <div><label>이름</label><b>${esc(m.name)}</b></div><div><label>부서 · 직급</label>${v([m.department, m.position].filter(Boolean).join(' · '))}</div><div><label>입사일</label>${v(m.hireDate)}</div>
                <div><label>생년월일</label>${v(m.birth)}</div><div><label>전화</label>${v(m.phone)}</div><div><label>이메일</label>${v(m.email)}</div>
            </div></div>
        <div class="pay-grp"><div class="gh" style="display: flex; align-items: center;">협회 · 자격 <span class="sub" style="font-weight: normal; font-size: 12px; margin-left: 8px;">직원경력 관리</span>
            <button type="button" class="pay-btn sm" style="margin-left: auto;" onclick="goHrFromAssoc('${m.id}', 'career')">✏️ 직원경력에서 고치기</button></div>
            <div class="as-ro">
                <div style="grid-column: span 3;"><label>가입 협회</label>${chips}</div>
                <div><label>분야</label>${v(m.field)}</div><div><label>자격등급</label>${v(m.grade)}</div><div><label>회사등록</label>${m.companyReg === true ? 'Y' : m.companyReg === false ? 'N' : '<span class="sub">-</span>'}</div>
                <div style="grid-column: span 2;"><label>자격증</label>${v(m.license)}</div><div><label>합격일</label>${v(m.licenseDate)}</div>
            </div></div>
        <div class="pay-grp"><div class="gh">교육</div>
            <div class="as-rule">✅ 교육 <b>종료일부터 3년 - 1일</b>까지 유효, 하루라도 지나면 <b>무효</b> (예: 23.11.14 종료 → 26.11.13까지) · 기록은 종료일부터 <b>10년</b> 보관
                <br><small>최근 교육이 무효가 되면 노란 「＋ 새 교육」 줄이 나타나요. 기타·철도운전은 유효기간을 따로 적으면 그 날짜를 써요.</small></div>
            ${EDU_SLOTS.map(s => eduSlotHtml(m, s)).join('')}</div>
        <div class="pay-grp"><div class="gh">메모</div><textarea id="ae-memo" class="as-memo" placeholder="예: 엔지니어링협회 퇴직 처리 함">${esc(m.memo || '')}</textarea></div>`;
    document.getElementById('assoc-del-btn').style.display = 'none';
    document.getElementById('assoc-modal').style.display = 'flex';
}
function closeAssocModal() { document.getElementById('assoc-modal').style.display = 'none'; }
// 사람 정보 고치기 → 직원정보·경력 수정 창 (저장하면 협회 관리도 새로 그림)
function goHrFromAssoc(id, tab) {
    closeAssocModal();
    HR.afterSave = () => { if (document.getElementById('assoc-admin-section').style.display === 'block') openAssocTab(); };
    openHrModal(id, tab);
}

function saveAssocMember() {
    const id = AS.editingId;
    if (!id) return;
    const edu = collectEduFromModal();
    const memo = (document.getElementById('ae-memo').value || '').trim();
    db.collection('hr_edu').doc(id).set({ edu, memo, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true })
        .then(() => { closeAssocModal(); openAssocTab(); })
        .catch(err => { console.error('교육 기록 저장 실패:', err); alert('저장 중 오류가 발생했어요.'); });
}
function deleteAssocMember() { /* 사람 추가·삭제는 직원정보 관리에서 (퇴사 처리하면 협회 관리에서도 빠짐) */ }

// ------------------------------------------
// 📤 직원명단 엑셀에서 교육 기록 가져오기 (이름으로 직원정보의 사람에게 연결 · 기존 이력은 유지, 같은 기간은 갱신)
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
    const people = AS.people || [];
    assocImportRows = rows.map(p => ({ p, hr: people.find(x => (x.name || '').trim() === (p.name || '').trim()) || null }))
        .filter(r => EDU_SLOTS.some(s => r.p.edu[s.k]));
    const ok = assocImportRows.filter(r => r.hr).length, miss = assocImportRows.length - ok;
    document.getElementById('assoc-imp-result').innerHTML = `
        <div class="lvimp-sum"><span>교육 기록이 있는 사람 <b>${assocImportRows.length}</b>명</span><span class="ok">직원정보와 연결 <b>${ok}</b></span>${miss ? `<span class="warn">직원정보에 없음(건너뜀) <b>${miss}</b></span>` : ''}</div>
        <div class="lvimp-wrap"><table class="lvimp-tbl"><thead><tr><th>이름</th><th>교육 기록</th><th></th></tr></thead><tbody>
        ${assocImportRows.map(({ p, hr }) => `<tr><td><b>${esc(p.name)}</b></td>
            <td>${EDU_SLOTS.filter(s => p.edu[s.k]).length}칸</td>
            <td>${hr ? '<span class="as-st ok">연결</span>' : '<span class="as-st gray">직원정보에 없음 · 건너뜀</span>'}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="pay-note" style="margin-top: 10px;">교육 기록만 가져와요(이름·부서·협회는 직원정보·직원경력 값을 써요) · 이미 있는 교육 이력과 메모는 그대로, 같은 기간 교육은 엑셀 값으로 갱신 · 🔒 주민번호·주소·비밀번호 칸은 읽지 않아요.</div>`;
    const btn = document.getElementById('assoc-imp-save');
    btn.disabled = !ok;
    btn.innerText = `${ok}명 교육 기록 저장`;
}

function saveAssocImport() {
    const list = assocImportRows.filter(r => r.hr);
    if (!list.length || !confirm(`${list.length}명의 교육 기록을 저장할까요?`)) return;
    const batch = db.batch();
    list.forEach(({ p, hr }) => {
        const cur = (AS.eduById || {})[hr.id] || {};
        batch.set(db.collection('hr_edu').doc(hr.id), { edu: mergeEduImport({ edu: cur.edu || {} }, p.edu), memo: cur.memo || '', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    batch.commit().then(() => { alert('저장했어요.'); closeAssocImport(); openAssocTab(); })
        .catch(err => {
            console.error('교육 기록 저장 실패:', err);
            alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요.\nFirebase 콘솔 > Firestore > 규칙(hr_)을 확인해 주세요.' : '저장 중 오류가 발생했어요.');
        });
}

// ⬇ 협회 명단 엑셀로 받기
function downloadAssocExcel() {
    const head = ['이름', '부서', '직위', '입사일', '협회', '분야', '등급', '회사등록', '자격증',
        ...EDU_SLOTS.flatMap(s => [`${s.label} 상태`, `${s.label} 시작`, `${s.label} 종료`, `${s.label} 유효 기한`, `${s.label} 이전 기록`]), '가장 가까운 유효기간', '다음 교육 신청', '메모'];
    const rows = AS.members.slice().sort((a, b) => a.name.localeCompare(b.name, 'ko')).map(m => [
        m.name, m.department || '', m.position || '', m.hireDate || '',
        (m.assocs || []).map(k => (ASSOCS.find(a => a.k === k) || {}).label).join(', '), m.field || '', m.grade || '',
        m.companyReg === true ? 'Y' : m.companyReg === false ? 'N' : '', m.license || '',
        ...EDU_SLOTS.flatMap(s => { const recs = eduRecs(m, s.k), e = recs[0] || {}; return [e.status || '', e.from || '', e.to || '', slotExpiry(m, s.k), recs.slice(1).map(r => `${r.from || ''}~${r.to || ''} ${r.assoc || ''} ${r.status || ''}`.trim()).join(' / ')]; }),
        nextDueOf(m), (() => { const a = applyInfosOf(m)[0]; return a ? `${a.label} · ${a.applied ? '신청완료' : a.text}` : ''; })(), m.memo || '']);
    const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '협회 명단');
    XLSX.writeFile(wb, `협회명단_${asToday()}.xlsx`);
}
