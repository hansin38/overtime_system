// ==========================================
// leave-admin.js (관리자 · 이전 연차 내역 엑셀 일괄 등록)
// [⬇ 샘플 양식] 받기 → '입력' 시트에 한 줄 = 한 건 → [📤 올리기] → 검수표 확인 → [등록]
// 등록 건은 결재 없이 바로 '승인' + imported: true (종이 결재 등 이전 자료) + importBatch(묶음 번호)
// 묶음 단위로 되돌리기(삭제) 가능 · admin.js / leave-common.js 다음에 로드
// ==========================================

const LV_IMPORT_COLS = [
    { k: 'name',  h: '이름',        req: true,  w: 10, note: '사원 이름 (사원 목록 시트와 똑같이)' },
    { k: 'phone', h: '전화뒷4자리', req: false, w: 12, note: '같은 이름이 2명 이상일 때만 필요' },
    { k: 'type',  h: '휴가종류',    req: true,  w: 14, note: '년차 · 월차 · 여름휴가 · 경조사 · 기타(내용)  예) 기타(병가)' },
    { k: 'start', h: '시작일',      req: true,  w: 12, note: '2026-03-05 형식 (2026.3.5 · 2026/3/5 도 됨)' },
    { k: 'end',   h: '종료일',      req: false, w: 12, note: '하루짜리면 비워도 됨 (= 시작일)' },
    { k: 'half',  h: '반차',        req: false, w: 8,  note: '비우면 전일 · 오전 · 오후  (여러 날이면 오후=첫날, 오전=마지막 날 0.5일)' },
    { k: 'reason', h: '사유',       req: false, w: 24, note: '비우면 "이전 자료"로 저장' },
    { k: 'date',  h: '신청일',      req: false, w: 12, note: '비우면 시작일로 저장 (휴가신청서 작성일자에 표시)' },
];
const LV_TYPE_BY_LABEL = { '년차': 'annual', '연차': 'annual', '월차': 'monthly', '여름휴가': 'summer', '하계휴가': 'summer', '경조사': 'family', '경조': 'family', '기타': 'etc' };

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

        const year = new Date().getFullYear();
        const ex = emps[0] ? emps[0].name : '홍길동';
        const guide = [
            ['이전 연차 내역 일괄 등록 양식'],
            [],
            ['① [입력] 시트에 한 줄 = 휴가 한 건으로 채워 주세요. 첫 줄(머리글)은 지우거나 바꾸지 마세요.'],
            ['② 관리자 페이지 > 🏖️ 연차 관리 > [📤 이전 내역 올리기]에서 이 파일을 선택하면 검수표가 나와요.'],
            ['③ 문제가 없는 줄만 결재 없이 바로 [승인] 상태로 등록돼요. 잘못 올렸으면 같은 창에서 묶음째 되돌릴 수 있어요.'],
            ['④ 일수는 직접 안 써도 돼요. 기간에서 주말·공휴일을 빼고 자동 계산해요.'],
            [],
            ['칸', '필수', '쓰는 법'],
            ...LV_IMPORT_COLS.map(c => [c.h, c.req ? '필수' : '', c.note]),
            [],
            ['작성 예시 (이 시트가 아니라 [입력] 시트에 써 주세요)'],
            LV_IMPORT_COLS.map(c => c.h),
            [ex, '', '년차', `${year}-03-05`, `${year}-03-06`, '', '개인 사유', ''],
            [ex, '', '년차', `${year}-04-10`, '', '오후', '병원', ''],
            [ex, '', '여름휴가', `${year}-08-03`, `${year}-08-05`, '', '', ''],
            [ex, '', '기타(병가)', `${year}-09-14`, '', '', '', `${year}-09-11`],
        ];
        const g = XLSX.utils.aoa_to_sheet(guide);
        g['!cols'] = [{ wch: 14 }, { wch: 8 }, { wch: 70 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 12 }];
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
        // 최신 사원·신청 내역으로 검사 (겹치는 날짜 확인용)
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
    const dt = parseYmd(ymd);
    return toYmd(dt) === ymd ? ymd : null;   // 2026-02-30 같은 없는 날짜 거르기
}

// 기간 → 날짜별 내역 (직원 신청 화면 buildLeaveLogs와 같은 규칙)
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

function parseLeaveImportRows(sheetRows) {
    const norm = s => String(s).replace(/[\s*]/g, '');
    const hIdx = sheetRows.findIndex(r => r.map(norm).includes('이름') && r.map(norm).includes('시작일'));
    if (hIdx < 0) { alert("'이름'·'시작일' 머리글을 찾지 못했어요. 샘플 양식의 [입력] 시트를 사용해 주세요."); return []; }
    const head = sheetRows[hIdx].map(norm);
    const col = {};
    LV_IMPORT_COLS.forEach(c => { col[c.k] = head.indexOf(norm(c.h)); });
    if (col.phone < 0) col.phone = head.findIndex(h => h.includes('전화'));
    const get = (r, k) => col[k] >= 0 ? r[col[k]] : '';

    const years = new Set(holidays.map(h => h.slice(0, 4)));
    const out = [];
    const taken = {};   // 파일 안에서 같은 사람·같은 날짜 겹침 확인
    sheetRows.slice(hIdx + 1).forEach((r, i) => {
        if (!r.some(v => String(v).trim() !== '')) return;   // 빈 줄
        const row = { line: hIdx + i + 2, errors: [], warns: [] };
        const name = String(get(r, 'name')).trim();
        const phone = String(get(r, 'phone')).replace(/\D/g, '').slice(-4);
        row.name = name;

        // 사원 찾기 (같은 이름이 여러 명이면 전화 뒷4자리로)
        let cands = lvImport.employees.filter(e => e.name === name);
        if (phone) cands = cands.filter(e => String(e.phoneLast4) === phone);
        if (!name) row.errors.push('이름 없음');
        else if (cands.length === 0) row.errors.push(phone ? '이름·전화번호가 맞는 사원 없음' : '사원 목록에 없는 이름');
        else if (cands.length > 1) row.errors.push('같은 이름이 여러 명 → 전화뒷4자리 필요');
        const emp = cands.length === 1 ? cands[0] : null;
        row.emp = emp;

        // 휴가 종류: '기타(병가)' · '병가'(목록에 없으면 기타로)
        const typeRaw = String(get(r, 'type')).trim();
        const tm = typeRaw.match(/^([^(（]+)\s*[(（]\s*(.*?)\s*[)）]?$/);
        const base = (tm ? tm[1] : typeRaw).replace(/\s/g, '');
        row.leaveType = LV_TYPE_BY_LABEL[base] || (typeRaw ? 'etc' : '');
        row.leaveTypeEtc = row.leaveType === 'etc' ? (base === '기타' ? (tm ? tm[2] : '') : typeRaw) : '';
        if (!row.leaveType) row.errors.push('휴가종류 없음');
        if (row.leaveType === 'etc' && !LV_TYPE_BY_LABEL[base]) row.warns.push(`'${typeRaw}' → 기타(${typeRaw})로 등록`);

        // 기간·반차
        const start = lvParseDate(get(r, 'start'));
        let end = lvParseDate(get(r, 'end'));
        if (end === '') end = start;
        const halfRaw = String(get(r, 'half')).trim();
        row.halfDay = /오전|am/i.test(halfRaw) ? 'am' : /오후|pm/i.test(halfRaw) ? 'pm' : 'full';
        if (halfRaw && row.halfDay === 'full' && !/전일|종일|하루/.test(halfRaw)) row.errors.push(`반차 '${halfRaw}'를 모르겠어요 (오전/오후/비움)`);
        row.startDate = start; row.endDate = end;
        row.detailLogs = []; row.totalDays = 0;
        if (!start) row.errors.push(start === null ? '시작일 형식 오류' : '시작일 없음');
        else if (!end) row.errors.push('종료일 형식 오류');
        else if (start > end) row.errors.push('종료일이 시작일보다 빠름');
        else if (start.slice(0, 4) !== end.slice(0, 4)) row.errors.push('연도가 바뀌는 휴가 → 연도별로 두 줄로 나눠 주세요');
        else {
            row.detailLogs = lvBuildLogs(start, end, row.halfDay);
            row.totalDays = row.detailLogs.reduce((s, l) => s + l.days, 0);
            if (row.totalDays <= 0) row.errors.push('기간이 모두 주말·공휴일');
            if (!years.has(start.slice(0, 4))) row.warns.push(`${start.slice(0, 4)}년 공휴일 목록이 없어 공휴일이 빠지지 않았어요 · 일수 확인`);
        }
        const signDate = lvParseDate(get(r, 'date'));
        if (signDate === null) row.errors.push('신청일 형식 오류');
        row.submittedDate = signDate || start || '';
        row.reason = String(get(r, 'reason')).trim();

        // 겹침: 이미 등록된 신청(대기·승인·재전송) / 파일 안의 다른 줄
        if (emp && row.detailLogs.length) {
            const mine = leaveAdminRequests.filter(({ data }) => data.employeeName === emp.name && data.employeePhone === emp.phoneLast4 && ACTIVE_STATUSES.includes(data.status));
            const used = new Set(mine.flatMap(({ data }) => (data.detailLogs || []).map(l => l.date)));
            const dup = row.detailLogs.map(l => l.date).filter(d => used.has(d));
            if (dup.length) row.errors.push(`이미 등록된 날짜와 겹침 (${dup.join(', ')})`);
            const key = `${emp.name}|${emp.phoneLast4}`;
            taken[key] = taken[key] || {};
            const dupIn = row.detailLogs.map(l => l.date).filter(d => taken[key][d]);
            if (dupIn.length) row.errors.push(`엑셀 ${taken[key][dupIn[0]]}번 줄과 날짜 겹침`);
            if (!dup.length && !dupIn.length) row.detailLogs.forEach(l => { taken[key][l.date] = row.line; });
            if (emp.hireDate && start < emp.hireDate) row.warns.push(`입사일(${emp.hireDate}) 이전 날짜`);
        }
        out.push(row);
    });

    // 잔여 연차 초과 경고 (년차·월차, 연도별로 기존 사용 + 이번에 올리는 것)
    const sums = {};
    out.filter(r => !r.errors.length && r.emp && LEAVE_TYPES[r.leaveType].deduct).forEach(r => {
        const y = Number(r.startDate.slice(0, 4));
        const key = `${r.emp.name}|${r.emp.phoneLast4}|${y}`;
        if (!sums[key]) {
            const before = leaveAdminRequests.filter(({ data }) => data.employeeName === r.emp.name && data.employeePhone === r.emp.phoneLast4
                && data.fiscalYear === y && ACTIVE_STATUSES.includes(data.status) && isDeductible(data))
                .reduce((s, { data }) => s + (data.totalDays || 0), 0);
            sums[key] = { used: before, ent: calcAnnualLeaveEntitlement(r.emp.hireDate, y), hire: r.emp.hireDate, rows: [] };
        }
        sums[key].used += r.totalDays;
        sums[key].rows.push(r);
    });
    Object.values(sums).forEach(s => {
        if (s.hire && s.used > s.ent) s.rows[s.rows.length - 1].warns.push(`등록하면 사용 ${formatDays(s.used)}일 > 발생 ${s.ent}일 (잔여 마이너스)`);
    });
    return out;
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
    box.innerHTML = `
        <div class="lvimp-sum"><span>전체 <b>${rows.length}</b>건</span><span class="ok">등록 가능 <b>${ok.length}</b></span>${warn ? `<span class="warn">확인 필요 <b>${warn}</b></span>` : ''}${bad ? `<span class="bad">오류(제외) <b>${bad}</b></span>` : ''}</div>
        <div class="lvimp-wrap"><table class="lvimp-tbl">
            <thead><tr><th>줄</th><th>이름</th><th>종류</th><th>기간</th><th>일수</th><th>사유</th><th>검사</th></tr></thead>
            <tbody>${rows.map(r => `<tr class="${r.errors.length ? 'bad' : r.warns.length ? 'warn' : ''}">
                <td>${r.line}</td>
                <td>${lvEsc(r.name)}${r.emp ? `<small>${lvEsc(r.emp.department || '')}</small>` : ''}</td>
                <td>${r.leaveType ? lvEsc(leaveTypeLabel(r)) : '-'}</td>
                <td>${r.startDate ? lvEsc(periodSummary(r)) : '-'}</td>
                <td>${r.totalDays ? formatDays(r.totalDays) + '일' : '-'}</td>
                <td class="l">${lvEsc(r.reason)}</td>
                <td class="l">${r.errors.length ? '❌ ' + r.errors.map(lvEsc).join('<br>❌ ') : r.warns.length ? '⚠️ ' + r.warns.map(lvEsc).join('<br>⚠️ ') : '✅'}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    document.getElementById('lvimp-status').innerText = ok.length
        ? `✅ ${ok.length}건을 '승인' 상태로 등록합니다${bad ? ` · ❌ ${bad}건은 빼고` : ''}`
        : '등록할 수 있는 줄이 없어요. 엑셀을 고쳐서 다시 선택해 주세요.';
    const btn = document.getElementById('lvimp-save');
    btn.disabled = !ok.length;
    btn.innerText = ok.length ? `${ok.length}건 등록` : '등록';
}

function saveLeaveImport() {
    const ok = lvImport.rows.filter(r => !r.errors.length);
    if (!ok.length) return;
    if (!confirm(`${ok.length}건을 결재 없이 '승인' 상태로 등록할까요?\n(잔여 연차에 바로 반영돼요)`)) return;
    const now = new Date();
    const batchId = `${toYmd(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const docs = ok.map(r => ({
        leaveType: r.leaveType,
        leaveTypeEtc: r.leaveTypeEtc,
        startDate: r.startDate,
        endDate: r.endDate,
        halfDay: r.halfDay,
        reason: r.reason || '이전 자료',
        emergencyContact: '-',
        detailLogs: r.detailLogs,
        totalDays: r.totalDays,
        employeeName: r.emp.name,
        employeePhone: r.emp.phoneLast4 || '',
        department: r.emp.department || '',
        position: r.emp.position || '',
        submittedAt: firebase.firestore.Timestamp.fromDate(parseYmd(r.submittedDate)),
        deductible: LEAVE_TYPES[r.leaveType].deduct,
        fiscalYear: Number(r.startDate.slice(0, 4)),
        status: '승인',
        imported: true,
        importBatch: batchId,
        importedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }));
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
