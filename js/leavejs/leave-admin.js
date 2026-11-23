// ==========================================
// leave-admin.js (관리자 · 이전 연차 내역 엑셀 일괄 등록)
// [⬇ 샘플 양식] 받기 → '입력' 시트에 한 줄 = 한 건 → [📤 올리기] → 검수표 확인 → [등록]
// 등록 건은 결재 없이 바로 '승인' + imported: true (종이 결재 등 이전 자료) + importBatch(묶음 번호)
// 묶음 단위로 되돌리기(삭제) 가능 · admin.js / leave-common.js 다음에 로드
//
// 📘 차감 판단 (취업규칙 2021 + 회사 운영 기준, 사용자 확인 2026-11-23)
//  - 공휴일·대체공휴일·근로자의 날·주말은 자동 제외 (js/ot-rules.js holidays)
//  - 사유(또는 휴가종류)에 아래 단어가 있으면 연차에서 안 뺌
//      경조사(제37조): 결혼 5 · 배우자 출산 10 · 부모/배우자 사망 5 · 조부모 3 · 자녀 3 · 형제자매 3
//                     (휴일 포함해서 셈, 배우자 출산만 근무일로 셈) → 한도 넘는 근무일은 년차
//      여름휴가: 1년 유급 5일, 8월~12월 사용, 이월 없음 → 그해 5일 넘는 날은 년차
//      병원·병가·생리·난임: 무급 (연차에서 안 뺌)
//  - 위 단어가 없으면 년차 (휴가종류에 '월차'라고 쓰면 월차)
//  - 연차·여름휴가는 다음 해로 이월 없음 (연도별로 따로 셈)
// ==========================================

const LV_IMPORT_COLS = [
    { k: 'name',    h: '이름',        req: true,  w: 10, note: '첫 줄만 써도 됨 · 비우면 윗줄과 같은 사람' },
    { k: 'phone',   h: '전화뒷4자리', req: false, w: 12, note: '같은 이름이 2명 이상일 때만 필요 · 비우면 윗줄과 같음' },
    { k: 'type',    h: '휴가종류',    req: false, w: 10, note: '비워도 됨 (사유를 보고 자동 판단) · 월차만 따로 쓰고 싶으면 "월차"' },
    { k: 'start',   h: '시작일',      req: true,  w: 12, note: '2026-03-05 형식 (2026.3.5 · 2026/3/5 · 엑셀 날짜 모두 됨)' },
    { k: 'end',     h: '종료일',      req: false, w: 12, note: '하루짜리면 비워도 됨 (= 시작일)' },
    { k: 'days',    h: '일수',        req: false, w: 6,  note: '참고용 · 자동 계산과 다르면 검수표에 ⚠️' },
    { k: 'half',    h: '반차',        req: false, w: 6,  note: 'Y = 반차 0.5일 · N 또는 비움 = 전일 (오전/오후로 써도 됨)' },
    { k: 'reason',  h: '사유',        req: false, w: 30, note: '결혼·출산·사망 → 경조사 / 여름휴가 → 여름휴가 / 병원·병가 → 무급 / 그 외 → 년차' },
    { k: 'date',    h: '신청일',      req: false, w: 12, note: '비우면 시작일로 저장 (휴가신청서 작성일자)' },
    { k: 'applied', h: '적용일수',    req: false, w: 8,  note: '참고용 · 연차에서 뺀 일수, 자동 계산과 다르면 검수표에 ⚠️' },
];
const LV_SUMMER_DAYS = 5;          // 여름휴가 유급 일수 (1년)
const LV_SUMMER_FROM = '08-01';    // 여름휴가 사용 기간 (이 기간 밖이면 ⚠️만, 그래도 여름휴가로 봄)
// 경조사 한도 (제37조) / calendar: 휴일 포함해서 셈 (배우자 출산만 근무일로)
//  결혼·출산은 그 단어만으로, 사망 경조사는 '사망·장례·부고' 같은 단어가 있을 때만 관계(조부모·자녀…)를 봄
//  ('딸 학교 행사' 같은 사유가 경조사로 잡히지 않게)
const LV_FAMILY_DIRECT = [
    { re: /출산/,      label: '배우자 출산', limit: 10, calendar: false },
    { re: /결혼|혼인/, label: '본인 결혼',   limit: 5,  calendar: true },
];
const LV_DEATH_RE = /사망|별세|작고|소천|조의|장례|상가|부고|상을|상\s*당|빈소/;
const LV_DEATH_RULES = [
    { re: /조부|조모|외조|할아버지|할머니/, label: '조부모 사망', limit: 3, calendar: true },
    { re: /자녀|아들|딸/,                   label: '자녀 사망',   limit: 3, calendar: true },
    { re: /형제|자매|형님|누나|언니|오빠|동생/, label: '형제자매 사망', limit: 3, calendar: true },
    { re: /부모|부친|모친|아버지|어머니|장인|장모|시부|시모|배우자|남편|아내/, label: '부모·배우자 사망', limit: 5, calendar: true },
];
const LV_FAMILY_GENERIC = { label: '경조사', limit: 0, calendar: true };   // 종류 모름 → 한도 확인 안 함
const LV_SUMMER_RE = /여름|하기|하계/;
const LV_UNPAID_RULES = [   // 난임치료가 '치료'로 병가에 잡히지 않게 난임을 먼저
    { re: /난임/, label: '난임치료휴가' },
    { re: /생리/, label: '생리휴가(무급)' },
    { re: /병원|병가|질병|입원|치료|아파|몸살/, label: '병가(무급)' },
];

// 연차신청서를 받지 않는 임원 직위 (샘플 양식 '사원 목록'에서 뺌, 부장 이하만 표시)
const LV_EXEC_POSITIONS = ['회장', '대표', '사장', '부사장', '전무', '상무', '이사', '감사', '고문'];
function lvIsExec(e) { return LV_EXEC_POSITIONS.some(p => String(e.position || '').includes(p)); }

let lvImport = { employees: [], rows: [] };

function lvEsc(s) { return String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }

// ------------------------------------------
// 샘플 양식 받기: 입력 · 작성 안내 · 사원 목록 3개 시트
// ------------------------------------------
function downloadLeaveImportSample() {
    db.collection("employees").get().then(snap => {
        const emps = snap.docs.map(d => d.data()).filter(e => e.name && !e.resignDate && !lvIsExec(e))
            .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
        const wb = XLSX.utils.book_new();

        const input = XLSX.utils.aoa_to_sheet([LV_IMPORT_COLS.map(c => c.h)]);
        input['!cols'] = LV_IMPORT_COLS.map(c => ({ wch: c.w }));
        XLSX.utils.book_append_sheet(wb, input, '입력');

        const y = new Date().getFullYear();
        const ex = emps[0] ? emps[0].name : '홍길동';
        const guide = [
            ['이전 연차 내역 일괄 등록 양식'],
            [],
            ['① [입력] 시트에 한 줄 = 휴가 한 건으로 채워 주세요. 첫 줄(머리글)은 지우거나 바꾸지 마세요.'],
            ['② 이름은 그 사람 첫 줄에만 써도 돼요. 아래 줄이 비어 있으면 윗줄과 같은 사람으로 봐요.'],
            ['③ 연차에서 뺄지는 사유를 보고 자동으로 정해요 (취업규칙 기준).'],
            ['     · 결혼 5일 · 배우자 출산 10일 · 부모/배우자 사망 5일 · 조부모/자녀/형제자매 사망 3일 → 경조사 (안 뺌, 휴일 포함해서 셈)'],
            ['     · 여름휴가 → 1년 5일까지 안 뺌 (8월~12월 사용, 이월 없음). 5일 넘는 날은 년차로 뺌'],
            ['     · 병원 · 병가 · 생리 · 난임 → 무급 (안 뺌)'],
            ['     · 그 외 → 년차로 뺌 (공휴일·대체공휴일·주말은 자동 제외)'],
            ['④ 반차는 Y만 쓰면 0.5일이에요. 일수·적용일수 칸은 참고용이라 비워도 되고, 쓰면 자동 계산과 맞는지 비교해 드려요.'],
            ['⑤ 관리자 페이지 > 🏖️ 연차 관리 > 맨 아래 [이전 연차 내역 엑셀로 일괄 등록]에서 파일을 선택하면 검수표가 나와요.'],
            [],
            ['칸', '필수', '쓰는 법'],
            ...LV_IMPORT_COLS.map(c => [c.h, c.req ? '필수' : '', c.note]),
            [],
            ['작성 예시 (이 시트가 아니라 [입력] 시트에 써 주세요)'],
            LV_IMPORT_COLS.map(c => c.h),
            [ex, '', '', `${y}-01-13`, `${y}-01-13`, 1, 'N', '개인사유', `${y}-01-12`, 1],
            ['', '', '', `${y}-04-22`, `${y}-04-22`, 0.5, 'Y', '', `${y}-04-22`, 0.5],
            ['', '', '', `${y}-05-18`, `${y}-05-22`, 5, 'N', '결혼', `${y}-05-14`, ''],
            ['', '', '', `${y}-08-05`, `${y}-08-07`, 3, 'N', '여름휴가', `${y}-07-21`, ''],
            ['', '', '', `${y}-09-30`, `${y}-10-02`, 3, 'N', '여름휴가 2일 + 개인사유', `${y}-09-23`, 1],
        ];
        const g = XLSX.utils.aoa_to_sheet(guide);
        g['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 70 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 6 }, { wch: 24 }, { wch: 12 }, { wch: 8 }];
        XLSX.utils.book_append_sheet(wb, g, '작성 안내');

        const list = XLSX.utils.aoa_to_sheet([['이름', '전화뒷4자리', '소속', '직위', '입사일'],
            ...emps.map(e => [e.name, e.phoneLast4 || '', e.department || '', e.position || '', e.hireDate || ''])]);
        list['!cols'] = [{ wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, list, '사원 목록');

        XLSX.writeFile(wb, '이전연차내역_등록양식.xlsx');
    }).catch(err => { console.error(err); alert('사원 목록을 불러오지 못했어요.'); });
}

// ------------------------------------------
// 올리기 창
// ------------------------------------------
function openLeaveImport() {
    lvImport = { employees: [], rows: [] };
    document.getElementById('lvimp-file').value = '';
    document.getElementById('lvimp-result').innerHTML = '';
    document.getElementById('lvimp-status').innerText = '';
    document.getElementById('lvimp-save').disabled = true;
    document.getElementById('lvimp-modal').style.display = 'flex';
    renderLeaveImportBatches();
}
function closeLeaveImport() { document.getElementById('lvimp-modal').style.display = 'none'; }

function onLeaveImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    document.getElementById('lvimp-status').innerText = '읽는 중...';
    const reader = new FileReader();
    reader.onload = () => {
        let rows;
        try {
            const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
            const ws = wb.Sheets['입력'] || wb.Sheets[wb.SheetNames[0]];
            rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
        } catch (e) {
            console.error(e);
            alert('엑셀 파일을 읽지 못했어요.');
            return;
        }
        // 최신 사원·신청 내역으로 검사 (겹치는 날짜·여름휴가 남은 일수)
        Promise.all([db.collection("employees").get(), db.collection("leave_requests").get()]).then(([empSnap, reqSnap]) => {
            lvImport.employees = empSnap.docs.map(d => d.data()).filter(e => e.name);
            leaveAdminRequests = reqSnap.docs.map(d => ({ id: d.id, data: d.data() }));
            lvImport.rows = parseLeaveImportRows(rows);
            renderLeaveImportResult();
        }).catch(err => { console.error(err); alert('사원·연차 정보를 불러오지 못했어요.'); });
    };
    reader.readAsArrayBuffer(file);
}

// 엑셀 날짜: 날짜 칸(일련번호) / 글자 '2026-03-05' · '2026.3.5' · '2026/3/5' · '2026년 3월 5일'
function lvParseDate(v) {
    if (v === '' || v == null) return '';
    if (typeof v === 'number') {
        const dt = new Date(Math.round((v - 25569) * 86400000));
        return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    }
    const m = String(v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return null;
    const ymd = `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    return toYmd(parseYmd(ymd)) === ymd ? ymd : null;   // 2026-02-30 같은 없는 날짜 거르기
}
function lvNum(v) {
    if (v === '' || v == null) return null;
    const n = parseFloat(String(v).replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : n;
}

// 기간 → 근무일 내역 (주말·공휴일 제외, 반차는 오후=첫날 / 오전·반차(Y)=마지막 날 0.5일)
function lvBuildLogs(startDate, endDate, halfDay) {
    const logs = [];
    const cur = parseYmd(startDate), last = parseYmd(endDate);
    for (let guard = 0; cur <= last && guard < 366; guard++) {
        const ymd = toYmd(cur);
        if (!isOffDay(ymd)) logs.push({ date: ymd, type: 'full', days: 1 });
        cur.setDate(cur.getDate() + 1);
    }
    if (logs.length > 0 && halfDay !== 'full') {
        const target = halfDay === 'pm' ? logs[0] : logs[logs.length - 1];
        target.type = halfDay;
        target.days = 0.5;
    }
    return logs;
}
function lvCalendarDays(a, b) { return Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1; }

// 사유·휴가종류 → 어떤 휴가인지
function lvClassify(typeRaw, reason) {
    const text = `${typeRaw} ${reason}`;
    const direct = LV_FAMILY_DIRECT.find(r => r.re.test(text));
    if (direct) return { kind: 'family', rule: direct };
    if (LV_DEATH_RE.test(text)) return { kind: 'family', rule: LV_DEATH_RULES.find(r => r.re.test(text)) || LV_FAMILY_GENERIC };
    if (/경조/.test(text)) return { kind: 'family', rule: LV_FAMILY_GENERIC };
    if (LV_SUMMER_RE.test(text)) return { kind: 'summer' };
    const unpaid = LV_UNPAID_RULES.find(r => r.re.test(text));
    if (unpaid) return { kind: 'unpaid', label: unpaid.label };
    if (/월차/.test(typeRaw)) return { kind: 'monthly' };
    if (typeRaw && !/년차|연차/.test(typeRaw) && !/^\s*$/.test(typeRaw)) return { kind: 'etc', label: typeRaw.replace(/^기타\s*[(（]?\s*|\s*[)）]$/g, '') || typeRaw };
    return { kind: 'annual' };
}

// 근무일 내역을 앞에서부터 n일만큼 / 나머지로 나눔 (반차 0.5일 고려)
function lvSplitLogs(logs, n) {
    const head = [], tail = [];
    let left = n;
    logs.forEach(l => {
        if (left >= l.days) { head.push(l); left -= l.days; }
        else if (left > 0) { head.push({ ...l, days: left, type: 'half' }); tail.push({ ...l, days: l.days - left, type: 'half' }); left = 0; }
        else tail.push(l);
    });
    return [head, tail];
}

function parseLeaveImportRows(sheetRows) {
    const norm = s => String(s).replace(/[\s*]/g, '');
    const hIdx = sheetRows.findIndex(r => r.map(norm).includes('이름') && r.map(norm).includes('시작일'));
    if (hIdx < 0) { alert("'이름'·'시작일' 머리글을 찾지 못했어요. 샘플 양식의 [입력] 시트를 사용해 주세요."); return []; }
    const head = sheetRows[hIdx].map(norm);
    const col = {};
    LV_IMPORT_COLS.forEach(c => { col[c.k] = head.indexOf(norm(c.h)); });
    if (col.phone < 0) col.phone = head.findIndex(h => h.includes('전화'));
    if (col.applied < 0) col.applied = head.findIndex(h => h.includes('적용') || h.includes('차감'));
    const get = (r, k) => col[k] >= 0 ? r[col[k]] : '';

    const years = new Set(holidays.map(h => h.slice(0, 4)));
    const out = [];
    let lastName = '', lastPhone = '';

    // 1) 줄마다 읽기 (이름·전화 비면 윗줄 사람)
    sheetRows.slice(hIdx + 1).forEach((r, i) => {
        if (!r.some(v => String(v).trim() !== '')) return;   // 빈 줄
        let name = String(get(r, 'name')).trim();
        let phone = String(get(r, 'phone')).replace(/\D/g, '').slice(-4);
        const startRaw = get(r, 'start');
        if (!name && String(startRaw).trim() === '') return;   // 맨 아래 합계 줄 등 (이름·시작일 모두 없음)
        if (name) { if (name !== lastName) lastPhone = ''; lastName = name; if (phone) lastPhone = phone; }
        else { name = lastName; phone = phone || lastPhone; }

        const row = { line: hIdx + i + 2, errors: [], warns: [], parts: [], name };
        let cands = lvImport.employees.filter(e => e.name === name);
        if (phone) cands = cands.filter(e => String(e.phoneLast4) === phone);
        if (!name) row.errors.push('이름 없음');
        else if (cands.length === 0) row.errors.push(phone ? '이름·전화번호가 맞는 사원 없음' : '사원 목록에 없는 이름');
        else if (cands.length > 1) row.errors.push('같은 이름이 여러 명 → 전화뒷4자리 필요');
        row.emp = cands.length === 1 ? cands[0] : null;

        const start = lvParseDate(startRaw);
        let end = lvParseDate(get(r, 'end'));
        if (end === '') end = start;
        const halfRaw = String(get(r, 'half')).trim();
        row.halfDay = /^(y|yes|예|o|반|반차)$/i.test(halfRaw) ? 'half' : /오전|am/i.test(halfRaw) ? 'am' : /오후|pm/i.test(halfRaw) ? 'pm' : 'full';
        if (halfRaw && row.halfDay === 'full' && !/^(n|no|아니오|x|전일|종일|하루)$/i.test(halfRaw)) row.errors.push(`반차 '${halfRaw}'를 모르겠어요 (Y/N)`);
        row.startDate = start; row.endDate = end;
        row.logs = []; row.totalDays = 0;
        if (!start) row.errors.push(start === null ? '시작일 형식 오류' : '시작일 없음');
        else if (!end) row.errors.push('종료일 형식 오류');
        else if (start > end) row.errors.push('종료일이 시작일보다 빠름');
        else if (start.slice(0, 4) !== end.slice(0, 4)) row.errors.push('연도가 바뀌는 휴가 → 연도별로 두 줄로 나눠 주세요');
        else {
            row.logs = lvBuildLogs(start, end, row.halfDay);
            row.totalDays = row.logs.reduce((s, l) => s + l.days, 0);
            if (row.totalDays <= 0) row.errors.push('기간이 모두 주말·공휴일');
            if (!years.has(start.slice(0, 4))) row.warns.push(`${start.slice(0, 4)}년 공휴일 목록이 없어 공휴일이 빠지지 않았어요 · 일수 확인`);
        }
        const signDate = lvParseDate(get(r, 'date'));
        if (signDate === null) row.errors.push('신청일 형식 오류');
        row.submittedDate = signDate || start || '';
        row.reason = String(get(r, 'reason')).trim();
        row.typeRaw = String(get(r, 'type')).trim();
        row.givenDays = lvNum(get(r, 'days'));
        row.givenApplied = col.applied >= 0 ? (lvNum(get(r, 'applied')) || 0) : null;   // 적용일수 칸이 있으면 빈칸 = 0
        row.cls = lvClassify(row.typeRaw, row.reason);
        out.push(row);
    });

    // 2) 사람·날짜 순으로 차감 판단 (여름휴가 남은 일수는 앞에서 쓴 만큼 줄어듦)
    const summerUsed = {};   // 'name|phone|year' → 이미 쓴 여름휴가 일수 (등록된 신청 + 이 파일 앞줄)
    const keyOf = (e, y) => `${e.name}|${e.phoneLast4}|${y}`;
    const activeOf = e => leaveAdminRequests.filter(({ data }) => data.employeeName === e.name && data.employeePhone === e.phoneLast4 && ACTIVE_STATUSES.includes(data.status));
    const ok = out.filter(r => !r.errors.length && r.emp).sort((a, b) => a.emp.name.localeCompare(b.emp.name, 'ko') || a.startDate.localeCompare(b.startDate));
    ok.forEach(r => {
        const y = r.startDate.slice(0, 4);
        const base = { reason: r.reason };
        const annual = logs => ({ ...base, leaveType: 'annual', leaveTypeEtc: '', logs });
        const c = r.cls;
        if (c.kind === 'family') {
            // 한도 안: 경조사 / 넘는 근무일: 년차 (휴일 포함해서 셈 - 배우자 출산은 근무일로)
            const fam = { ...base, leaveType: 'family', leaveTypeEtc: '', logs: r.logs };
            if (!c.rule.limit) { r.parts = [fam]; r.warns.push('경조사 종류(결혼·사망 등)를 몰라 한도 확인 안 함'); return; }
            let cut = r.logs.length ? r.logs.findIndex(l => (c.rule.calendar ? lvCalendarDays(r.startDate, l.date) : r.logs.indexOf(l) + 1) > c.rule.limit) : -1;
            if (cut < 0) { r.parts = [fam]; r.note = `${c.rule.label} ${c.rule.limit}일 이내`; return; }
            r.parts = [{ ...fam, logs: r.logs.slice(0, cut) }, annual(r.logs.slice(cut))].filter(p => p.logs.length);
            r.warns.push(`${c.rule.label} ${c.rule.limit}일 한도 초과 → 넘는 날은 년차`);
            return;
        }
        if (c.kind === 'summer') {
            const k = keyOf(r.emp, y);
            if (summerUsed[k] == null) summerUsed[k] = activeOf(r.emp).filter(({ data }) => data.fiscalYear === Number(y) && data.leaveType === 'summer').reduce((s, { data }) => s + (data.totalDays || 0), 0);
            const left = Math.max(0, LV_SUMMER_DAYS - summerUsed[k]);
            const [head, tail] = lvSplitLogs(r.logs, left);
            summerUsed[k] += head.reduce((s, l) => s + l.days, 0);
            r.parts = [{ ...base, leaveType: 'summer', leaveTypeEtc: '', logs: head }, annual(tail)].filter(p => p.logs.length);
            r.note = `여름휴가 ${formatDays(summerUsed[k])}/${LV_SUMMER_DAYS}일 사용`;
            if (tail.length) r.warns.push(`여름휴가 ${LV_SUMMER_DAYS}일 넘는 ${formatDays(tail.reduce((s, l) => s + l.days, 0))}일은 년차`);
            if (r.startDate.slice(5) < LV_SUMMER_FROM) r.warns.push(`여름휴가 사용 기간(8월~12월) 밖`);
            return;
        }
        if (c.kind === 'unpaid') { r.parts = [{ ...base, leaveType: 'etc', leaveTypeEtc: c.label, logs: r.logs }]; return; }
        if (c.kind === 'etc') { r.parts = [{ ...base, leaveType: 'etc', leaveTypeEtc: c.label, logs: r.logs }]; r.warns.push(`'${c.label}' → 기타(차감 안 함)`); return; }
        r.parts = [{ ...base, leaveType: c.kind === 'monthly' ? 'monthly' : 'annual', leaveTypeEtc: '', logs: r.logs }];
    });

    // 3) 겹침 검사 (이미 등록된 신청 / 이 파일의 다른 줄) · 참고 칸 비교 · 입사일
    const taken = {};
    ok.forEach(r => {
        const used = new Set(activeOf(r.emp).flatMap(({ data }) => (data.detailLogs || []).map(l => l.date)));
        const dates = r.logs.map(l => l.date);
        const dup = dates.filter(d => used.has(d));
        if (dup.length) r.errors.push(`이미 등록된 날짜와 겹침 (${dup.join(', ')})`);
        const key = `${r.emp.name}|${r.emp.phoneLast4}`;
        taken[key] = taken[key] || {};
        const dupIn = dates.filter(d => taken[key][d]);
        if (dupIn.length) r.errors.push(`엑셀 ${taken[key][dupIn[0]]}번 줄과 날짜 겹침`);
        if (!dup.length && !dupIn.length) dates.forEach(d => { taken[key][d] = r.line; });
        if (r.emp.hireDate && r.startDate < r.emp.hireDate) r.warns.push(`입사일(${r.emp.hireDate}) 이전 날짜`);

        r.deducted = r.parts.filter(p => LEAVE_TYPES[p.leaveType].deduct).reduce((s, p) => s + p.logs.reduce((a, l) => a + l.days, 0), 0);
        if (r.givenDays != null && Math.abs(r.givenDays - r.totalDays) > 0.001) r.warns.push(`엑셀 일수 ${formatDays(r.givenDays)}일 ≠ 계산 ${formatDays(r.totalDays)}일 (주말·공휴일 제외)`);
        if (r.givenApplied != null && Math.abs(r.givenApplied - r.deducted) > 0.001) r.warns.push(`엑셀 적용일수 ${formatDays(r.givenApplied)}일 ≠ 차감 ${formatDays(r.deducted)}일`);
    });
    return out;
}

// 사람·연도별 차감 합계 (등록된 것 + 이번에 올리는 것) → 발생 일수와 비교
function lvPersonTotals(rows) {
    const map = {};
    rows.filter(r => !r.errors.length && r.emp).forEach(r => {
        const y = Number(r.startDate.slice(0, 4));
        const k = `${r.emp.name}|${r.emp.phoneLast4}|${y}`;
        if (!map[k]) {
            const before = leaveAdminRequests.filter(({ data }) => data.employeeName === r.emp.name && data.employeePhone === r.emp.phoneLast4
                && data.fiscalYear === y && ACTIVE_STATUSES.includes(data.status) && isDeductible(data)).reduce((s, { data }) => s + (data.totalDays || 0), 0);
            map[k] = { name: r.emp.name, year: y, add: 0, given: 0, hasGiven: false, before, ent: r.emp.hireDate ? calcLeaveDetail(r.emp.hireDate, y, leaveAdminRequests.filter(({ data }) => data.employeeName === r.emp.name && data.employeePhone === r.emp.phoneLast4)).yearTotal : null };
        }
        map[k].add += r.deducted;
        if (r.givenApplied != null) { map[k].given += r.givenApplied; map[k].hasGiven = true; }
    });
    return Object.values(map);
}

function lvPartsHtml(r) {
    if (!r.parts.length) return r.cls ? '-' : '-';
    return r.parts.map(p => {
        const d = p.logs.reduce((s, l) => s + l.days, 0);
        const ded = LEAVE_TYPES[p.leaveType].deduct;
        const range = r.parts.length > 1 ? ` <small>${p.logs[0].date.slice(5)}${p.logs.length > 1 ? '~' + p.logs[p.logs.length - 1].date.slice(5) : ''}</small>` : '';
        return `<span class="lvimp-kind ${ded ? 'ded' : 'free'}">${lvEsc(leaveTypeLabel(p))} ${formatDays(d)}일${range}</span>`;
    }).join(' ');
}

function renderLeaveImportResult() {
    const rows = lvImport.rows;
    const ok = rows.filter(r => !r.errors.length);
    const bad = rows.length - ok.length;
    const warn = ok.filter(r => r.warns.length).length;
    const box = document.getElementById('lvimp-result');
    if (!rows.length) {
        box.innerHTML = `<div class="pay-note warn">[입력] 시트에 내용이 없어요.</div>`;
        document.getElementById('lvimp-status').innerText = '';
        document.getElementById('lvimp-save').disabled = true;
        return;
    }
    const totals = lvPersonTotals(rows);
    box.innerHTML = `
        <div class="lvimp-sum"><span>전체 <b>${rows.length}</b>줄</span><span class="ok">등록 가능 <b>${ok.length}</b></span>${warn ? `<span class="warn">확인 필요 <b>${warn}</b></span>` : ''}${bad ? `<span class="bad">오류(제외) <b>${bad}</b></span>` : ''}</div>
        ${totals.length ? `<div class="lvimp-people">${totals.map(t => {
            const after = t.before + t.add;
            const match = !t.hasGiven ? '' : Math.abs(t.given - t.add) < 0.001 ? ' <span class="ok">· 엑셀 적용일수 합계와 같음 ✅</span>' : ` <span class="bad">· 엑셀 적용일수 합계 ${formatDays(t.given)}일과 다름 ⚠️</span>`;
            return `<div><b>${lvEsc(t.name)}</b> ${t.year}년 연차 차감 <b>${formatDays(t.add)}일</b>${t.before ? ` (이미 등록 ${formatDays(t.before)}일 포함 시 ${formatDays(after)}일)` : ''}${t.ent != null ? ` / 발생 ${t.ent}일 → 잔여 <b class="${t.ent - after < 0 ? 'neg' : ''}">${formatDays(t.ent - after)}일</b>` : ''}${match}</div>`;
        }).join('')}</div>` : ''}
        <div class="lvimp-wrap"><table class="lvimp-tbl">
            <thead><tr><th>줄</th><th>이름</th><th>기간</th><th>일수</th><th>사유</th><th>판단 (주황 = 연차 차감)</th><th>검사</th></tr></thead>
            <tbody>${rows.map(r => `<tr class="${r.errors.length ? 'bad' : r.warns.length ? 'warn' : ''}">
                <td>${r.line}</td>
                <td>${lvEsc(r.name)}${r.emp ? `<small>${lvEsc(r.emp.department || '')}</small>` : ''}</td>
                <td>${r.startDate ? lvEsc(periodSummary(r)) : '-'}</td>
                <td>${r.totalDays ? formatDays(r.totalDays) + '일' : '-'}</td>
                <td class="l">${lvEsc(r.reason)}</td>
                <td class="l">${r.errors.length ? '-' : lvPartsHtml(r)}${r.note && !r.errors.length ? `<small>${lvEsc(r.note)}</small>` : ''}</td>
                <td class="l">${r.errors.length ? '❌ ' + r.errors.map(lvEsc).join('<br>❌ ') : r.warns.length ? '⚠️ ' + r.warns.map(lvEsc).join('<br>⚠️ ') : '✅'}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    const nDocs = ok.reduce((s, r) => s + r.parts.length, 0);
    document.getElementById('lvimp-status').innerText = ok.length
        ? `✅ ${ok.length}줄(${nDocs}건)을 '승인' 상태로 등록합니다${bad ? ` · ❌ ${bad}줄은 빼고` : ''}`
        : '등록할 수 있는 줄이 없어요. 엑셀을 고쳐서 다시 선택해 주세요.';
    const btn = document.getElementById('lvimp-save');
    btn.disabled = !ok.length;
    btn.innerText = ok.length ? `${nDocs}건 등록` : '등록';
}

function saveLeaveImport() {
    const ok = lvImport.rows.filter(r => !r.errors.length);
    if (!ok.length) return;
    const now = new Date();
    const batchId = `${toYmd(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    // 한 줄이 '여름휴가 + 년차'처럼 나뉘면 각각 한 건씩
    const docs = ok.flatMap(r => r.parts.map(p => {
        const half = p.logs.find(l => l.type !== 'full');
        return {
            leaveType: p.leaveType,
            leaveTypeEtc: p.leaveTypeEtc,
            startDate: p.logs[0].date,
            endDate: p.logs[p.logs.length - 1].date,
            halfDay: half ? half.type : 'full',
            reason: p.reason || '이전 자료',
            emergencyContact: '-',
            detailLogs: p.logs,
            totalDays: p.logs.reduce((s, l) => s + l.days, 0),
            employeeName: r.emp.name,
            employeePhone: r.emp.phoneLast4 || '',
            department: r.emp.department || '',
            position: r.emp.position || '',
            submittedAt: firebase.firestore.Timestamp.fromDate(parseYmd(r.submittedDate)),
            deductible: LEAVE_TYPES[p.leaveType].deduct,
            fiscalYear: Number(p.logs[0].date.slice(0, 4)),
            status: '승인',
            imported: true,
            importBatch: batchId,
            importLine: r.line,
            importedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
    }));
    if (!confirm(`${docs.length}건을 결재 없이 '승인' 상태로 등록할까요?\n(잔여 연차에 바로 반영돼요)`)) return;
    const btn = document.getElementById('lvimp-save');
    btn.disabled = true;
    btn.innerText = '등록 중...';
    lvCommitChunks(docs.map(d => b => b.set(db.collection("leave_requests").doc(), d)))
        .then(() => {
            alert(`${docs.length}건 등록했어요.\n잘못 올렸으면 이 창 아래 '올린 묶음'에서 되돌릴 수 있어요.`);
            lvImport.rows = [];
            document.getElementById('lvimp-result').innerHTML = '';
            document.getElementById('lvimp-file').value = '';
            document.getElementById('lvimp-status').innerText = `✅ ${docs.length}건 등록 완료 (묶음 ${batchId})`;
            btn.innerText = '등록';
            loadLeaveAdmin();
            renderLeaveImportBatches();
        })
        .catch(err => {
            console.error('이전 연차 등록 실패:', err);
            alert('등록 중 오류가 났어요. 일부만 들어갔을 수 있으니 아래 올린 묶음을 확인해 주세요.');
            btn.innerText = '등록';
            renderLeaveImportBatches();
        });
}

// Firestore 한 번에 500건 제한 → 400건씩 나눠서
function lvCommitChunks(ops) {
    let p = Promise.resolve();
    for (let i = 0; i < ops.length; i += 400) {
        const part = ops.slice(i, i + 400);
        p = p.then(() => { const b = db.batch(); part.forEach(op => op(b)); return b.commit(); });
    }
    return p;
}

// ------------------------------------------
// 올린 묶음 목록 · 되돌리기 (그 묶음으로 등록된 건 전부 삭제)
// ------------------------------------------
function renderLeaveImportBatches() {
    const box = document.getElementById('lvimp-batches');
    if (!box) return;
    db.collection("leave_requests").where("imported", "==", true).get().then(snap => {
        const groups = {};
        snap.docs.forEach(d => {
            const b = d.data().importBatch || '-';
            groups[b] = groups[b] || { n: 0, names: new Set() };
            groups[b].n++;
            groups[b].names.add(d.data().employeeName);
        });
        const keys = Object.keys(groups).sort().reverse();
        box.innerHTML = keys.length ? `<div class="lvimp-bh">올린 묶음</div>` + keys.map(k => `
            <div class="lvimp-batch"><span><b>${lvEsc(k)}</b> · ${groups[k].n}건 · ${groups[k].names.size}명</span>
            <button class="pay-btn sm ghost" onclick="undoLeaveImportBatch('${lvEsc(k)}', ${groups[k].n})">되돌리기</button></div>`).join('') : '';
    }).catch(err => console.error(err));
}

function undoLeaveImportBatch(batchId, n) {
    if (!confirm(`${batchId}에 올린 ${n}건을 모두 삭제할까요?\n되돌릴 수 없어요.`)) return;
    db.collection("leave_requests").where("importBatch", "==", batchId).get()
        .then(snap => lvCommitChunks(snap.docs.map(d => b => b.delete(d.ref))))
        .then(() => { alert('삭제했어요.'); loadLeaveAdmin(); renderLeaveImportBatches(); })
        .catch(err => { console.error(err); alert('삭제 중 오류가 났어요.'); });
}
