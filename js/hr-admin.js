// ==========================================
// 🎓 인사 · 자격 - 직원정보 관리 · 직원경력 관리 (관리자 조회 전용, hr-admin.js)
// - 데이터: 처음 한 번 직원명단.xlsx 로 올리고, 그다음부터는 이 화면(수정 창)이 원본 · 엑셀을 다시 올리면 통째로 바뀜(경고)
//     「1기본정보」 → 직원정보 (성명 · 직급 · 부서 · 생년월일 · 전화 · 입사일 · 주소 · 이메일)
//     「2경력,학력」 → 직원경력 (구분 · 분야 · 자격등급 · 회사등록 · 자격증 · 발급번호 · 합격일 · 학력)
// - 🔒 주민번호는 저장하지 않고 생년월일만 뽑음 (개인정보보호법 제24조의2 - 주민번호는 암호화 보관 의무)
// - 저장: hr_staff 컬렉션 (문서 하나 = 한 사람, firestore.rules 의 hr_ 규칙 → 관리자만)
// - 날짜·글자 도우미(asYmd · asText · birthFromRrn · asToday · assocKeysFrom · ASSOCS)는 js/assoc-admin.js 것을 같이 씀
// - 화면: 칸 머리 눌러 정렬 · 필터 버튼(부서·직급 / 등급·회사등록·협회) · 요약 · 머리글 고정 · 지금 결과 엑셀 받기
//   🔒 전화·이메일·주소는 기본으로 가림 ([개인정보 보기]로 펼침, 펼치면 전화·메일 바로 연결)
// ==========================================

const HR = {
    people: [], loaded: false, importRows: [],
    q: { info: '', career: '' },
    sort: { info: { key: 'no', dir: 1 }, career: { key: 'no', dir: 1 } },
    filter: { info: { dept: '', pos: '' }, career: { grade: '', reg: '', assoc: '', empty: '' } },
    reveal: false,   // 🔒 전화·이메일·주소는 기본으로 가림 → [개인정보 보기]를 눌러야 펼쳐짐 (화면 공유·캡처 대비)
};

function openHrTab(kind) {
    const tbody = document.getElementById(`hr-${kind}-tbody`);
    if (HR.loaded) { renderHr(kind); return; }
    tbody.innerHTML = `<tr><td colspan="12" style="color: #888;">불러오는 중...</td></tr>`;
    db.collection('hr_staff').get().then(snap => {
        HR.people = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        HR.loaded = true;
        renderHr(kind);
    }).catch(err => {
        console.error('직원정보 불러오기 실패:', err);
        tbody.innerHTML = `<tr><td colspan="12" style="color: var(--danger-color);">직원정보를 불러오지 못했어요.${err && err.code === 'permission-denied' ? '<br><small>Firebase 콘솔 > Firestore > 규칙에 hr_ 규칙(관리자만)을 게시했는지 확인해 주세요.</small>' : ''}</td></tr>`;
    });
}

function setHrSearch(kind, value) { HR.q[kind] = value; renderHr(kind); }
function setHrFilter(kind, key, value) { HR.filter[kind][key] = HR.filter[kind][key] === value ? '' : value; renderHr(kind); }
function resetHrFilter(kind) { Object.keys(HR.filter[kind]).forEach(k => { HR.filter[kind][k] = ''; }); renderHr(kind); }
function sortHr(kind, key) { const s = HR.sort[kind]; HR.sort[kind] = s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }; renderHr(kind); }
function toggleHrReveal() { HR.reveal = !HR.reveal; renderHr('info'); }

// 입사일 → 근속 개월 수 / 'N년 M개월'
function hrTenureMonths(ymd) {
    if (!ymd) return null;
    const a = parseYmd(ymd), b = parseYmd(asToday());
    const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
    return months < 0 ? null : months;
}
function hrTenure(ymd) { const n = hrTenureMonths(ymd); return n === null ? '' : `${Math.floor(n / 12)}년 ${n % 12}개월`; }

// 🔒 가리기: 010-****-5206 · ks****@naver.com · 서울시 송파구 ***
const hrMaskPhone = (s) => String(s || '').replace(/^(\d{2,3})[-\s]?(\d{3,4})[-\s]?(\d{4})$/, '$1-****-$3') || '';
const hrMaskEmail = (s) => String(s || '').replace(/^(.{0,2})[^@]*(@.*)$/, '$1****$2');
const hrMaskAddr = (s) => { const t = String(s || '').split(/\s+/); return t.length > 2 ? `${t.slice(0, 2).join(' ')} ***` : (s ? '***' : ''); };
// 졸업년도 'YYYY.MM' 로 통일 (2026.2.25 · 2020.08 · 1999 → 2026.02 · 2020.08 · 1999)
function hrYm(v) {
    const m = String(v ?? '').match(/(\d{4})(?:\D+(\d{1,2}))?/);
    return m ? (m[2] ? `${m[1]}.${pad2(m[2])}` : m[1]) : asText(v);
}
// 구분(협회 이름 글자) → 협회 칩 (협회 관리와 같은 모양)
function hrAssocChips(text) {
    const keys = assocKeysFrom(text);
    if (!keys.length) return text ? esc(text) : '<span class="sub">-</span>';
    return keys.map(k => { const a = ASSOCS.find(x => x.k === k); return `<span class="as-assoc as-${k}" title="${a.label}">${a.short}</span>`; }).join('');
}
const HR_GRADES = ['특급', '고급', '중급', '초급'];
const HR_POS_ORDER = ['대표이사', '부사장', '전무', '상무', '이사', '고문', '부장', '차장', '과장', '대리', '주임', '사원'];

// 이름 칸: 퇴사자는 '퇴사 날짜' · 화면에서 고친 적 있으면 ✏️
// 직원경력 화면은 경력이 없는 사람도 빈 줄로 보여줌 (경력 미입력 · 줄을 눌러 채우기)
const hrRowsOf = (kind) => kind === 'info' ? HR.people.filter(p => p.info) : HR.people.map(p => p.career ? p : { ...p, career: { department: (p.info || {}).department || '', position: (p.info || {}).position || '' }, _noCareer: true });
const hrNameCell = (p) => `<b>${esc(p.name)}</b>${p.resigned ? `<small>퇴사 ${esc(p.resigned.date || '')}</small>` : (p._noCareer ? '<small class="hr-empty">경력 미입력</small>' : p.history && p.history.length ? '<small title="화면에서 고친 기록이 있어요">✏️ 수정됨</small>' : '')}`;
// 표 칸 정의: 정렬 열쇠 · 정렬 값 · 머리 · 칸 모양
function hrColumns(kind) {
    const v = (x) => esc(x || '') || '<span class="sub">-</span>';
    if (kind === 'info') return [
        { key: 'name', th: '이름', cls: 'l', w: 84, val: p => p.name, td: hrNameCell },
        { key: 'pos', th: '직급', w: 70, val: p => { const i = HR_POS_ORDER.indexOf(p.info.position); return i < 0 ? 99 : i; }, td: p => v(p.info.position) },
        { key: 'dept', th: '부서', cls: 'l', w: 110, val: p => p.info.department, td: p => v(p.info.department) },
        { key: 'birth', th: '생년월일', w: 96, val: p => p.info.birth, td: p => v(p.info.birth) },
        { key: 'hire', th: '입사일 · 근속', w: 104, val: p => p.info.hireDate, td: p => p.info.hireDate ? `${p.info.hireDate}<small>${hrTenure(p.info.hireDate)}</small>` : v('') },
        { key: 'phone', th: '전화번호', w: 118, td: p => !p.info.phone ? v('') : HR.reveal ? `<a href="tel:${esc(p.info.phone)}" onclick="event.stopPropagation()">${esc(p.info.phone)}</a>` : esc(hrMaskPhone(p.info.phone)) },
        { key: 'email', th: '이메일', cls: 'l', w: 190, td: p => !p.info.email ? v('') : HR.reveal ? `<a href="mailto:${esc(p.info.email)}" onclick="event.stopPropagation()">${esc(p.info.email)}</a>` : esc(hrMaskEmail(p.info.email)) },
        { key: 'addr', th: '주소', cls: 'l hr-addr', td: p => !p.info.address ? v('') : HR.reveal ? `<span title="${esc(p.info.address)}">${esc(p.info.address)}</span>` : esc(hrMaskAddr(p.info.address)) },
    ];
    return [
        { key: 'name', th: '이름', cls: 'l', w: 84, val: p => p.name, td: hrNameCell },
        { key: 'dept', th: '부서 · 직급', cls: 'l', w: 112, val: p => p.career.department, td: p => `${v(p.career.department)}<small>${esc(p.career.position || '')}</small>` },
        { key: 'assoc', th: '구분', cls: 'l', w: 120, val: p => assocKeysFrom(p.career.group).join(','), td: p => hrAssocChips(p.career.group) },
        { key: 'field', th: '분야', w: 80, val: p => p.career.field, td: p => v(p.career.field) },
        { key: 'grade', th: '자격등급', w: 74, val: p => { const i = HR_GRADES.indexOf(p.career.grade); return i < 0 ? 99 : i; }, td: p => p.career.grade ? `<span class="hr-grade g${HR_GRADES.indexOf(p.career.grade)}">${esc(p.career.grade)}</span>` : v('') },
        { key: 'reg', th: '회사등록', w: 70, val: p => p.career.companyReg === true ? 0 : p.career.companyReg === false ? 1 : 2, td: p => p.career.companyReg === true ? '<span class="staff-chip ok">Y</span>' : p.career.companyReg === false ? '<span class="staff-chip gray">N</span>' : v('') },
        { key: 'license', th: '자격증 · 발급번호', cls: 'l', w: 150, val: p => p.career.license, td: p => `${v(p.career.license)}${p.career.licenseNo ? `<small>${esc(p.career.licenseNo)}</small>` : ''}` },
        { key: 'ldate', th: '합격일', w: 92, val: p => p.career.licenseDate, td: p => v(p.career.licenseDate) },
        { key: 'school', th: '최종학력', cls: 'l', val: p => p.career.school, td: p => `${v(p.career.school)}<small>${esc([p.career.degree, p.career.major].filter(Boolean).join(' · '))}</small>` },
        { key: 'grad', th: '졸업', w: 70, val: p => hrYm(p.career.gradYear), td: p => v(hrYm(p.career.gradYear)) },
    ];
}

// 지금 화면 조건(검색 · 필터 · 정렬)에 맞는 사람
function hrListOf(kind) {
    const q = (HR.q[kind] || '').trim(), f = HR.filter[kind];
    const col = hrColumns(kind).find(c => c.key === HR.sort[kind].key);
    const val = col && col.val ? col.val : (p => p.no || 999);
    const dir = HR.sort[kind].dir;
    return hrRowsOf(kind)
        .filter(p => HR.showResigned || !p.resigned)
        .filter(p => { const d = kind === 'info' ? p.info : p.career; return !q || [p.name, d.department, d.position].some(x => String(x || '').includes(q)); })
        .filter(p => kind !== 'info' || ((!f.dept || p.info.department === f.dept) && (!f.pos || p.info.position === f.pos)))
        .filter(p => kind !== 'career' || ((!f.grade || p.career.grade === f.grade)
            && (!f.reg || (f.reg === 'Y' ? p.career.companyReg === true : p.career.companyReg !== true))
            && (!f.assoc || assocKeysFrom(p.career.group).includes(f.assoc))
            && (!f.empty || p._noCareer)))
        .sort((a, b) => {
            const x = val(a), y = val(b), byNo = (a.no || 999) - (b.no || 999);
            const ex = x === '' || x === null || x === undefined, ey = y === '' || y === null || y === undefined;
            if (ex || ey) return ex === ey ? byNo : (ex ? 1 : -1);   // 빈 값은 늘 맨 아래
            return dir * (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko')) || byNo;
        });
}

// 위쪽 요약 + 필터 버튼 (누르면 그것만, 다시 누르면 풀림)
function hrChipsHtml(kind) {
    const all = hrRowsOf(kind);
    const base = all.filter(p => HR.showResigned || !p.resigned);
    const nResigned = all.filter(p => p.resigned).length;
    const resignChip = nResigned ? `<button type="button" class="as-fc${HR.showResigned ? ' on' : ''}" onclick="toggleHrShowResigned()">퇴사자 포함<b>${nResigned}</b></button>` : '';
    const f = HR.filter[kind];
    const chip = (label, n, on, onclick) => `<button type="button" class="as-fc${on ? ' on' : ''}" onclick="${onclick}">${label}<b>${n}</b></button>`;
    const countBy = (arr, fn) => { const m = {}; arr.forEach(p => { const k = fn(p); if (k) m[k] = (m[k] || 0) + 1; }); return m; };
    const allOn = Object.values(f).every(x => !x);
    if (kind === 'info') {
        const depts = countBy(base, p => p.info.department);
        const months = base.map(p => hrTenureMonths(p.info.hireDate)).filter(n => n !== null);
        const avg = months.length ? months.reduce((s, n) => s + n, 0) / months.length : 0;
        const pos = countBy(base, p => p.info.position);
        const posOpts = Object.keys(pos).sort((a, b) => ((HR_POS_ORDER.indexOf(a) + 1) || 99) - ((HR_POS_ORDER.indexOf(b) + 1) || 99));
        return `<div class="as-fchips">${chip('전체', base.length, allOn, "resetHrFilter('info')")}
            ${Object.keys(depts).sort((a, b) => depts[b] - depts[a] || a.localeCompare(b, 'ko')).map(d => chip(esc(d), depts[d], f.dept === d, `setHrFilter('info','dept','${esc(d)}')`)).join('')}
            <span class="as-fsep"></span>
            <select class="hr-sel" onchange="HR.filter.info.pos=this.value; renderHr('info')"><option value="">직급 전체</option>${posOpts.map(p => `<option value="${esc(p)}" ${f.pos === p ? 'selected' : ''}>${esc(p)} (${pos[p]})</option>`).join('')}</select>
            ${resignChip}<span class="hr-stat">평균 근속 <b>${Math.floor(avg / 12)}년 ${Math.round(avg % 12)}개월</b></span></div>`;
    }
    const grades = countBy(base, p => p.career.grade);
    const regY = base.filter(p => p.career.companyReg === true).length;
    const assocs = countBy(base.flatMap(p => assocKeysFrom(p.career.group).map(k => ({ k }))), x => x.k);
    return `<div class="as-fchips">${chip('전체', base.length, allOn, "resetHrFilter('career')")}
        ${HR_GRADES.filter(g => grades[g]).map(g => chip(g, grades[g], f.grade === g, `setHrFilter('career','grade','${g}')`)).join('')}
        <span class="as-fsep"></span>
        ${base.some(p => p._noCareer) ? chip('경력 미입력', base.filter(p => p._noCareer).length, f.empty === '1', "setHrFilter('career','empty','1')") + '<span class="as-fsep"></span>' : ''}${chip('회사등록 Y', regY, f.reg === 'Y', "setHrFilter('career','reg','Y')")}${chip('회사등록 N·없음', base.filter(p => !p._noCareer).length - regY, f.reg === 'N', "setHrFilter('career','reg','N')")}
        <span class="as-fsep"></span>
        ${ASSOCS.filter(a => assocs[a.k]).map(a => chip(a.short, assocs[a.k], f.assoc === a.k, `setHrFilter('career','assoc','${a.k}')`)).join('')}
        ${resignChip ? `<span class="as-fsep"></span>${resignChip}` : ''}</div>`;
}

function renderHr(kind) {
    const tbody = document.getElementById(`hr-${kind}-tbody`);
    if (!tbody) return;
    const cols = hrColumns(kind), list = hrListOf(kind), s = HR.sort[kind];
    document.getElementById(`hr-${kind}-chips`).innerHTML = HR.people.length ? hrChipsHtml(kind) : '';
    document.getElementById(`hr-${kind}-count`).innerText = `${list.length}명`;
    const rv = document.getElementById('hr-reveal-btn');
    if (rv) rv.innerText = HR.reveal ? '🙈 개인정보 가리기' : '🔒 개인정보 보기';
    document.getElementById(`hr-${kind}-head`).innerHTML = cols.map(c => c.val
        ? `<th class="sortable${c.cls && c.cls.startsWith('l') ? ' l' : ''}" style="${c.w ? `width:${c.w}px;` : ''}" onclick="sortHr('${kind}','${c.key}')">${c.th} <span class="arr${s.key === c.key ? ' on' : ''}">${s.key === c.key ? (s.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`
        : `<th class="${c.cls && c.cls.startsWith('l') ? 'l' : ''}" style="${c.w ? `width:${c.w}px;` : ''}">${c.th}</th>`).join('');
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="${cols.length}" style="color: #888;">${HR.people.length ? '조건에 맞는 사람이 없어요' : '아직 데이터가 없어요. [📤 직원명단 엑셀 올리기]로 넣어 주세요.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = list.map(p => `<tr class="${p.resigned ? 'resigned' : ''}" onclick="openHrModal('${p.id}','${kind}')" title="눌러서 수정">${cols.map(c => `<td class="${c.cls || ''}">${c.td(p)}</td>`).join('')}</tr>`).join('');
}

// ⬇ 지금 거른 결과 그대로 엑셀 (가리기와 상관없이 실제 값)
function downloadHrExcel(kind) {
    const list = hrListOf(kind);
    const rows = kind === 'info'
        ? [['이름', '직급', '부서', '생년월일', '입사일', '근속', '전화번호', '이메일', '주소'],
           ...list.map(p => [p.name, p.info.position, p.info.department, p.info.birth, p.info.hireDate, hrTenure(p.info.hireDate), p.info.phone, p.info.email, p.info.address])]
        : [['이름', '부서', '직급', '구분', '분야', '자격등급', '회사등록', '자격증', '자격증발급번호', '합격일', '최종학력', '학위', '학과', '졸업'],
           ...list.map(p => { const c = p.career; return [p.name, c.department, c.position, c.group, c.field, c.grade, c.companyReg === true ? 'Y' : c.companyReg === false ? 'N' : '', c.license, c.licenseNo, c.licenseDate, c.school, c.degree, c.major, hrYm(c.gradYear)]; })];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind === 'info' ? '직원정보' : '직원경력');
    XLSX.writeFile(wb, `${kind === 'info' ? '직원정보' : '직원경력'}_${asToday()}.xlsx`);
}


// ------------------------------------------
// ✏️ 수정 창 (1안): 줄을 누르면 그 사람 창 · [👤 기본정보] [📚 경력·자격] · 바꾼 칸은 노랗게 → [저장]
//   처음 한 번만 엑셀로 올리고, 그다음부터는 이 화면이 원본 · 고칠 때마다 변경 기록(history)을 남김(최근 50건)
//   퇴사는 지우지 않고 [퇴사 처리] → 기본 목록에서 숨김 (위쪽 [퇴사자] 버튼으로 보기)
// ------------------------------------------
const HR_DEGREES = ['고졸', '전문대졸', '학사', '석사', '박사'];
// 구분(협회) 글자 → 협회 이름 목록 (협회 관리와 같은 6개 · 저장은 '전기기술인협회, 전기철도협회' 처럼)
const hrAssocLabels = (text) => assocKeysFrom(text).map(k => ASSOCS.find(a => a.k === k).label).join(', ');
const HR_FIELDS = {
    info: [
        { k: 'name', label: '이름', root: true }, { k: 'position', label: '직급', list: 'hr-pos-list' }, { k: 'department', label: '부서', list: 'hr-dept-list' },
        { k: 'birth', label: '생년월일', type: 'date' }, { k: 'hireDate', label: '입사일', type: 'date' }, { k: 'phone', label: '전화번호', ph: '010-0000-0000' },
        { k: 'email', label: '이메일', span: 3 }, { k: 'address', label: '주소', span: 3 },
    ],
    career: [
        { k: 'position', label: '직급', list: 'hr-pos-list' }, { k: 'department', label: '부서', list: 'hr-dept-list' }, { k: 'field', label: '분야', options: ['', '설계', '감리', '설계/감리'] },
        { k: 'grade', label: '자격등급', options: ['', ...HR_GRADES] }, { k: 'companyReg', label: '회사등록', options: ['', 'Y', 'N'] }, { k: 'licenseDate', label: '합격일', type: 'date' },
        { k: 'group', label: '구분(협회)', hint: '여러 개 고를 수 있어요', assoc: true, span: 3 },
        { k: 'license', label: '자격증', span: 2 }, { k: 'licenseNo', label: '자격증 발급번호' },
        { k: 'school', label: '최종학력(학교)' }, { k: 'degree', label: '학위', options: ['', ...HR_DEGREES] }, { k: 'major', label: '학과(전공)' },
        { k: 'gradYear', label: '졸업(YYYY.MM)', ph: '2020.08' },
    ],
};
HR.showResigned = false;
HR.edit = null;   // { id, tab, orig }

function hrFieldValue(p, tab, f) {
    if (f.root) return p ? p[f.k] || '' : '';
    const d = p && p[tab];
    if (!d) return tab === 'career' && ['department', 'position'].includes(f.k) ? ((p && p.info) || {})[f.k] || '' : '';   // 경력 미입력이면 부서·직급은 직원정보 값으로 채워 둠
    if (f.k === 'companyReg') return d.companyReg === true ? 'Y' : d.companyReg === false ? 'N' : '';
    return d[f.k] ?? '';
}
function openHrModal(id = null, tab = 'info') {
    const p = id ? HR.people.find(x => x.id === id) : null;
    if (id && !p) return;
    HR.edit = { id, tab, orig: p };
    const depts = [...new Set(HR.people.map(x => (x.info || {}).department || (x.career || {}).department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    const field = (t, f) => {
        const v = String(hrFieldValue(p, t, f));
        const id2 = `hrf-${t}-${f.k}`;
        const input = f.assoc
            ? `<div id="${id2}" class="hr-assoc-picks" data-orig="${esc(hrAssocLabels(v))}">${ASSOCS.map(a => `<label class="lvimp-emp"><input type="checkbox" value="${a.k}" ${assocKeysFrom(v).includes(a.k) ? 'checked' : ''} onchange="markHrAssoc('${id2}')"> ${a.label}</label>`).join('')}</div>`
            : f.options
            ? `<select id="${id2}" data-orig="${esc(v)}" onchange="markHrChange(this)">${f.options.map(o => `<option value="${o}" ${o === v ? 'selected' : ''}>${o || '-'}</option>`).join('')}${v && !f.options.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>`
            : `<input id="${id2}" ${f.type ? `type="${f.type}"` : ''} ${f.list ? `list="${f.list}"` : ''} value="${esc(v)}" data-orig="${esc(v)}" placeholder="${esc(f.ph || '')}" oninput="markHrChange(this)">`;
        return `<div ${f.span ? `style="grid-column: span ${f.span};"` : ''}><label>${f.label}${f.hint ? ` <small class="sub">· ${f.hint}</small>` : ''}</label>${input}</div>`;
    };
    const last = p && Array.isArray(p.history) && p.history.length ? p.history[p.history.length - 1] : null;
    const hist = p && Array.isArray(p.history) ? p.history.slice().reverse() : [];
    document.getElementById('hr-modal-title').innerText = p ? `직원 정보 · ${p.name}${p.resigned ? ' (퇴사)' : ''}` : '직원 추가';
    document.getElementById('hr-modal-body').innerHTML = `
        <datalist id="hr-pos-list">${HR_POS_ORDER.map(x => `<option value="${x}">`).join('')}</datalist>
        <datalist id="hr-dept-list">${depts.map(x => `<option value="${esc(x)}">`).join('')}</datalist>
        <div class="lv-subtabs" style="margin-bottom: 12px;">
            <button type="button" id="hrm-tab-info" onclick="switchHrModalTab('info')">👤 기본정보</button>
            <button type="button" id="hrm-tab-career" onclick="switchHrModalTab('career')">📚 경력 · 자격${p && !p.career ? ' <small>(없음)</small>' : ''}</button>
        </div>
        <div id="hrm-pane-info" class="pay-fg c3">${HR_FIELDS.info.map(f => field('info', f)).join('')}</div>
        <div id="hrm-pane-career" class="pay-fg c3">${p && !p.career ? '<div class="hr-note" style="grid-column: span 3;">경력 관리를 하지 않는 직원이에요. 칸을 채우고 저장하면 직원경력 관리에 나와요.</div>' : ''}${HR_FIELDS.career.map(f => field('career', f)).join('')}</div>
        ${p && p.resigned ? `<div class="hr-note warn">🚪 ${esc(p.resigned.date || '')} 퇴사 처리된 직원이에요.</div>` : ''}
        ${hist.length ? `<details class="hr-hist"><summary>🕘 변경 기록 ${hist.length}건</summary>${hist.map(h => `<div><b>${esc(h.at || '')}</b> ${h.changes.map(c => `${esc(c.label)} <span class="sub">${esc(c.from || '(빈칸)')}</span> → ${esc(c.to || '(빈칸)')}`).join(' · ')}</div>`).join('')}</details>` : ''}`;
    document.getElementById('hr-modal-last').innerText = last ? `마지막 수정: ${last.at} · ${last.changes.slice(0, 2).map(c => `${c.label} ${c.from || '(빈칸)'} → ${c.to || '(빈칸)'}`).join(' · ')}${last.changes.length > 2 ? ` 외 ${last.changes.length - 2}칸` : ''}` : (p ? '' : '새 직원은 이름만 있어도 저장돼요');
    const rb = document.getElementById('hr-modal-resign');
    rb.style.display = p ? '' : 'none';
    rb.innerText = p && p.resigned ? '퇴사 취소' : '퇴사 처리';
    switchHrModalTab(tab);
    document.getElementById('hr-modal').style.display = 'flex';
}
function switchHrModalTab(tab) {
    if (HR.edit) HR.edit.tab = tab;
    ['info', 'career'].forEach(t => {
        document.getElementById(`hrm-pane-${t}`).style.display = t === tab ? '' : 'none';
        document.getElementById(`hrm-tab-${t}`).classList.toggle('on', t === tab);
    });
}
function markHrAssoc(id) { const box = document.getElementById(id); box.classList.toggle('chg', hrPickedAssoc(box) !== (box.dataset.orig || '')); }
const hrPickedAssoc = (box) => Array.from(box.querySelectorAll('input:checked')).map(i => ASSOCS.find(a => a.k === i.value).label).join(', ');
function markHrChange(el) { el.classList.toggle('chg', el.value.trim() !== (el.dataset.orig || '')); }
function closeHrModal() { document.getElementById('hr-modal').style.display = 'none'; HR.edit = null; }
const hrNow = () => { const d = new Date(); return `${toYmd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

function saveHrModal() {
    const e = HR.edit;
    if (!e) return;
    const p = e.orig;
    const val = (t, k) => { const el = document.getElementById(`hrf-${t}-${k}`); if (!el) return ''; return el.classList.contains('hr-assoc-picks') ? hrPickedAssoc(el) : (el.value || '').trim(); };
    const name = val('info', 'name');
    if (!name) { alert('이름을 입력해 주세요.'); switchHrModalTab('info'); return; }
    const changes = [];
    const pick = (t) => {
        const out = { ...((p && p[t]) || {}) };
        HR_FIELDS[t].filter(f => !f.root).forEach(f => {
            const raw = String(hrFieldValue(p, t, f)), after = val(t, f.k);
            if (f.assoc && hrAssocLabels(raw) === after) { out[f.k] = raw; return; }   // 고른 협회가 같으면 원래 글자 그대로 (바뀐 것 아님)
            const before = raw;
            if (before !== after) changes.push({ label: `${t === 'career' ? '[경력] ' : ''}${f.label}`, from: before, to: after });
            out[f.k] = f.k === 'companyReg' ? (after === 'Y' ? true : after === 'N' ? false : null) : (f.k === 'gradYear' ? hrYm(after) : after);
        });
        return out;
    };
    if (p && p.name !== name) changes.push({ label: '이름', from: p.name, to: name });
    const info = pick('info');
    const careerOut = pick('career');
    const careerHasValue = HR_FIELDS.career.some(f => { const v = careerOut[f.k]; return v !== '' && v !== null && v !== undefined && !['position', 'department'].includes(f.k); });
    const career = (p && p.career) || careerHasValue ? careerOut : null;
    if (p && !changes.length) { closeHrModal(); return; }
    const history = ((p && p.history) || []).concat(p ? [{ at: hrNow(), changes }] : [{ at: hrNow(), changes: [{ label: '직원 추가', from: '', to: name }] }]).slice(-50);
    const doc = { ...(p || {}), name, info, career, history, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    delete doc.id;
    const ref = p ? db.collection('hr_staff').doc(p.id) : db.collection('hr_staff').doc();
    ref.set(doc).then(() => {
        const saved = { ...doc, id: ref.id, updatedAt: null };
        HR.people = p ? HR.people.map(x => x.id === p.id ? saved : x) : HR.people.concat([saved]);
        closeHrModal();
        renderHr('info'); renderHr('career');
    }).catch(err => {
        console.error('직원정보 저장 실패:', err);
        alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요.\nFirebase 콘솔 > Firestore > 규칙에 hr_ 규칙을 게시해 주세요.' : '저장 중 오류가 발생했어요.');
    });
}

function toggleHrResign() {
    const p = HR.edit && HR.edit.orig;
    if (!p) return;
    let resigned = null, change;
    if (p.resigned) {
        if (!confirm(`${p.name} 님의 퇴사 처리를 취소할까요?`)) return;
        change = { label: '퇴사 취소', from: p.resigned.date || '', to: '' };
    } else {
        const date = prompt(`${p.name} 님 퇴사일을 입력해 주세요 (YYYY-MM-DD)`, asToday());
        if (date === null) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) { alert('날짜를 2026-11-24 처럼 입력해 주세요.'); return; }
        resigned = { date: date.trim() };
        change = { label: '퇴사 처리', from: '', to: resigned.date };
    }
    const history = (p.history || []).concat([{ at: hrNow(), changes: [change] }]).slice(-50);
    db.collection('hr_staff').doc(p.id).update({ resigned, history, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).then(() => {
        HR.people = HR.people.map(x => x.id === p.id ? { ...x, resigned, history } : x);
        closeHrModal();
        renderHr('info'); renderHr('career');
    }).catch(err => { console.error(err); alert('저장 중 오류가 발생했어요.'); });
}
function toggleHrMenu(ev, kind) {
    ev.stopPropagation();
    const m = document.getElementById(`hr-more-${kind}`);
    m.style.display = m.style.display === 'block' ? 'none' : 'block';
}
document.addEventListener('click', () => ['info', 'career'].forEach(k => { const m = document.getElementById(`hr-more-${k}`); if (m) m.style.display = 'none'; }));
function toggleHrShowResigned() { HR.showResigned = !HR.showResigned; renderHr('info'); renderHr('career'); }

// ------------------------------------------
// 📤 직원명단.xlsx 올리기 (1기본정보 + 2경력,학력 → 통째로 바꿈)
// ------------------------------------------
function parseHrWorkbook(wb) {
    const sheet = (n) => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) : null;
    const base = sheet('1기본정보'), career = sheet('2경력,학력');
    if (!base && !career) throw new Error("'1기본정보'·'2경력,학력' 시트를 찾지 못했어요. 직원명단 파일이 맞는지 확인해 주세요.");
    const byName = {};
    const person = (name) => (byName[name] = byName[name] || { name });
    const rowsOf = (rows) => (rows || []).slice(3).filter(r => asText(r[1]) && !/^성명$/.test(asText(r[1])));
    const dash = (x) => (asText(x) === '-' ? '' : asText(x));
    // 1기본정보: 번호(0) 성명(1) 직급(2) 부서(3) 주민번호(4 → 생년월일만) 전화(5) 입사일자(6) 주소(7) 이메일(8)
    rowsOf(base).forEach(r => {
        const p = person(asText(r[1]));
        p.no = Number(r[0]) || null;
        p.info = { position: dash(r[2]), department: dash(r[3]), birth: birthFromRrn(r[4]), phone: asText(r[5]), hireDate: asYmd(r[6]), address: asText(r[7]), email: asText(r[8]) };
    });
    // 2경력,학력: 성명(1) 직급(2) 부서(3) 구분(5) 분야(6) 자격등급(7) 회사등록(8) 자격증(10) 발급번호(11) 합격일(12) 최종학력(14) 학위명(15) 학과(16) 졸업년도(17)
    rowsOf(career).forEach(r => {
        const p = person(asText(r[1]));
        const reg = asText(r[8]);
        p.career = {
            position: dash(r[2]), department: dash(r[3]), group: asText(r[5]), field: asText(r[6]), grade: asText(r[7]),
            companyReg: /^y/i.test(reg) ? true : /^n/i.test(reg) ? false : null,
            license: asText(r[10]), licenseNo: asText(r[11]), licenseDate: asYmd(r[12]) || asText(r[12]),
            school: asText(r[14]), degree: asText(r[15]), major: asText(r[16]), gradYear: asText(r[17]),
        };
    });
    return Object.values(byName).map(p => ({ ...p, info: p.info || null, career: p.career || null }));
}

function openHrImport() {
    HR.importRows = [];
    document.getElementById('hr-imp-file').value = '';
    document.getElementById('hr-imp-result').innerHTML = '';
    document.getElementById('hr-imp-save').disabled = true;
    document.getElementById('hr-imp-modal').style.display = 'flex';
}
function closeHrImport() { document.getElementById('hr-imp-modal').style.display = 'none'; }

function onHrImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            HR.importRows = parseHrWorkbook(XLSX.read(new Uint8Array(reader.result), { type: 'array' }));
            const nInfo = HR.importRows.filter(p => p.info).length, nCareer = HR.importRows.filter(p => p.career).length;
            document.getElementById('hr-imp-result').innerHTML = `
                <div class="lvimp-sum"><span>읽은 사람 <b>${HR.importRows.length}</b>명</span><span class="ok">직원정보 <b>${nInfo}</b>명</span><span class="ok">직원경력 <b>${nCareer}</b>명</span></div>
                <div class="pay-note" style="margin-top: 10px;">⚠️ 저장하면 지금 사이트의 직원정보·직원경력이 <b>이 엑셀 내용으로 통째로 바뀌어요</b>. 화면에서 고친 내용·변경 기록·퇴사 처리도 모두 엑셀 기준으로 돌아가요.<br>
                🔒 주민번호는 저장하지 않고 생년월일만 뽑았어요.</div>`;
            const btn = document.getElementById('hr-imp-save');
            btn.disabled = !HR.importRows.length;
            btn.innerText = `${HR.importRows.length}명 저장`;
        } catch (e) {
            console.error(e);
            alert(e.message || '엑셀을 읽지 못했어요.');
        }
    };
    reader.readAsArrayBuffer(file);
}

function saveHrImport() {
    if (!HR.importRows.length || !confirm(`직원정보·직원경력을 이 엑셀 내용(${HR.importRows.length}명)으로 바꿀까요?`)) return;
    const used = {};
    const docs = HR.importRows.map(p => {
        let id = p.name.replace(/[\/.#$\[\]]/g, '_');
        used[id] = (used[id] || 0) + 1;
        if (used[id] > 1) id += `_${used[id]}`;   // 같은 이름이 두 명이면 _2
        return { id, data: { ...p, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } };
    });
    const keep = new Set(docs.map(d => d.id));
    const batch = db.batch();
    HR.people.filter(p => !keep.has(p.id)).forEach(p => batch.delete(db.collection('hr_staff').doc(p.id)));   // 엑셀에서 빠진 사람은 지움
    docs.forEach(d => batch.set(db.collection('hr_staff').doc(d.id), d.data));
    batch.commit().then(() => {
        alert('저장했어요.');
        closeHrImport();
        HR.loaded = false;   // 협회 관리도 다음에 열 때 새 직원정보로 연결됨
        const kind = document.getElementById('hrcareer-admin-section').style.display === 'block' ? 'career' : 'info';
        openHrTab(kind);
    }).catch(err => {
        console.error('직원정보 저장 실패:', err);
        alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요.\nFirebase 콘솔 > Firestore > 규칙에 hr_ 규칙을 게시해 주세요.' : '저장 중 오류가 발생했어요.');
    });
}
