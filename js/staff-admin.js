// ==========================================
// 👥 직원 관리 (staff-admin.js)
// 전체 명단 표 · 검색 · 부서 · 재직/퇴사 · 정보 누락 확인 · 근속 · 올해 연차 잔여
// 데이터는 급여 관리와 같은 P (payroll-month.js loadPayrollData) 를 그대로 사용
// 줄을 누르면 사원 정보 수정 창(openPayEmpModal), 등록·엑셀 받기/올리기도 여기서 (payroll-employee.js)
// ==========================================

const STAFF = { state: 'active', sort: { key: 'name', dir: 1 } };

// 표 칸: k 정렬 키 (없으면 정렬 안 함)
const STAFF_COLS = [
    { h: '사원번호', k: 'empNo' },
    { h: '이름', k: 'name' },
    { h: '부서', k: 'dept' },
    { h: '직위', k: 'position' },
    { h: '입사일', k: 'hire' },
    { h: '근속', k: 'service' },
    { h: '연차 잔여', k: 'leave', title: `${new Date().getFullYear()}년 잔여 / 오늘까지 발생 (년차·월차)` },
    { h: '급여', k: 'payType' },
    { h: '명세서', k: 'target', title: '급여명세서 발급 대상' },
    { h: '상태', k: 'state' },
    { h: '확인 필요', k: 'missing', title: '비어 있으면 안 되는 정보' },
];

function openStaffTab() {
    if (!P.loaded) {   // 급여 관리를 아직 안 열었으면 달 선택부터 (사원 수정 창의 '적용 시작 월' 기준)
        initPayMonthSelect();
        P.loaded = true;
    }
    document.getElementById('staff-tbody').innerHTML = `<tr><td colspan="${STAFF_COLS.length}" style="color: #888;">불러오는 중...</td></tr>`;
    loadPayrollData();   // 끝나면 renderStaffTable() 호출됨
}

// 급여 관리(보기 전용)의 '직원 관리에서 수정' → 직원 관리 탭으로 옮겨서 그 사람 수정 창 열기
function editInStaffTab(empId) {
    switchAdminTab('staff');
    openPayEmpModal(empId);
}

function setStaffState(v) {
    STAFF.state = v;
    document.querySelectorAll('#staff-state button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    renderStaffTable();
}

function sortStaff(key) {
    STAFF.sort = STAFF.sort.key === key ? { key, dir: -STAFF.sort.dir } : { key, dir: 1 };
    renderStaffTable();
}

// 오늘 기준 재직 상태
function staffState(e, today) {
    if (e.resignDate && e.resignDate < today) return 'resigned';
    if (e.hireDate && e.hireDate > today) return 'upcoming';
    return 'active';
}

// 근속: 입사일 ~ 오늘(퇴사자는 퇴사일) → 'N년 M개월'
function staffService(e, today) {
    if (!e.hireDate) return { text: '-', months: -1 };
    const end = e.resignDate && e.resignDate < today ? e.resignDate : today;
    if (e.hireDate > end) return { text: '입사 전', months: -1 };
    const [hy, hm, hd] = e.hireDate.split('-').map(Number), [ey, em, ed] = end.split('-').map(Number);
    let months = (ey - hy) * 12 + (em - hm) - (ed < hd ? 1 : 0);
    months = Math.max(0, months);
    const y = Math.floor(months / 12), m = months % 12;
    return { text: y ? `${y}년${m ? ` ${m}개월` : ''}` : `${m}개월`, months };
}

// 꼭 있어야 하는 정보 (없으면 생기는 문제를 툴팁으로)
function staffMissing(e, p) {
    const out = [];
    if (!e.hireDate) out.push(['입사일', '연차 발생을 계산할 수 없어요']);
    if (!e.empNo) out.push(['사원번호', '급여대장·엑셀에서 사람을 찾을 때 써요']);
    if (!e.department || !e.position) out.push(['부서·직위', '휴가신청서·명세서에 비어서 나가요']);
    if (p.payslipTarget === true) {
        if (!p.birthDate) out.push(['생년월일', '명세서 PDF 암호(생년월일 6자리)를 만들 수 없어요']);
        if (!p.email) out.push(['이메일', '명세서를 메일로 보낼 수 없어요']);
        if (!p.bankAccount) out.push(['계좌', '명세서에 입금 계좌가 안 나와요']);
        const c = condFor(p, P.month || ymdOfDate(new Date()).slice(0, 7));
        if (!num(c.annualSalary) && !sumValues(c.fixedPay)) out.push(['급여 조건', '연봉 또는 고정 금액이 없어 급여를 계산할 수 없어요']);
    }
    return out;
}

function staffRows() {
    const today = ymdOfDate(new Date());
    const year = Number(today.slice(0, 4));
    return P.employees.map(e => {
        const p = prof(e.id);
        const mine = (P.leaveRequests || []).filter(d => d.employeeName === e.name && d.employeePhone === e.phoneLast4).map(data => ({ data }));
        const detail = calcLeaveDetail(e.hireDate, year, mine);
        const used = leaveUsedInYear(mine, year);
        return {
            e, p, today,
            state: staffState(e, today),
            service: staffService(e, today),
            leave: e.hireDate ? { granted: detail.granted, remaining: detail.granted - used, yearTotal: detail.yearTotal } : null,
            missing: staffMissing(e, p),
        };
    });
}

function renderStaffTable() {
    const tbody = document.getElementById('staff-tbody');
    if (!tbody || !P.employees) return;
    const all = staffRows();
    const today = ymdOfDate(new Date());
    const ym = today.slice(0, 7), yy = today.slice(0, 4);

    // 위쪽 요약 칸
    const active = all.filter(r => r.state !== 'resigned');
    const missingCnt = active.filter(r => r.missing.length).length;
    const kpi = (label, val, sub, onclick, warn) => `<div class="staff-kpi${warn ? ' warn' : ''}${onclick ? ' click' : ''}"${onclick ? ` onclick="${onclick}"` : ''}><small>${label}</small><b>${val}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
    document.getElementById('staff-kpis').innerHTML =
        kpi('재직', `${active.length}명`, active.filter(r => r.state === 'upcoming').length ? `입사 예정 ${active.filter(r => r.state === 'upcoming').length}명 포함` : '', "setStaffState('active')")
        + kpi('이번 달 입사', `${all.filter(r => (r.e.hireDate || '').startsWith(ym)).length}명`, '')
        + kpi(`${yy}년 퇴사`, `${all.filter(r => (r.e.resignDate || '').startsWith(yy)).length}명`, '', "setStaffState('resigned')")
        + kpi('명세서 대상', `${active.filter(r => r.p.payslipTarget === true).length}명`, '')
        + kpi('정보 누락', `${missingCnt}명`, missingCnt ? '눌러서 보기' : '모두 입력됨', missingCnt ? "document.getElementById('staff-missing').checked = true; setStaffState('active')" : '', missingCnt > 0);

    // 부서 목록 (고른 값 유지)
    const deptSel = document.getElementById('staff-dept');
    const keepDept = deptSel.value;
    const depts = [...new Set(all.map(r => r.e.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
    deptSel.innerHTML = `<option value="">전체 부서</option>` + depts.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    deptSel.value = depts.includes(keepDept) ? keepDept : '';

    // 거르기
    const q = (document.getElementById('staff-search').value || '').trim();
    const onlyMissing = document.getElementById('staff-missing').checked;
    let list = all.filter(r =>
        (STAFF.state === 'all' || (STAFF.state === 'resigned' ? r.state === 'resigned' : r.state !== 'resigned'))
        && (!deptSel.value || r.e.department === deptSel.value)
        && (!q || [r.e.name, r.e.empNo, r.e.department, r.e.position].some(v => String(v || '').includes(q)))
        && (!onlyMissing || r.missing.length));

    // 정렬 (값이 없는 사람은 오름차순·내림차순 모두 맨 아래)
    const keyOf = {
        empNo: r => r.e.empNo || null, name: r => r.e.name || null, dept: r => r.e.department || null, position: r => r.e.position || null,
        hire: r => r.e.hireDate || null, service: r => (r.service.months >= 0 ? r.service.months : null), leave: r => (r.leave ? r.leave.remaining : null),
        payType: r => payTypeOf(r.p), target: r => (r.p.payslipTarget === true ? 0 : 1), state: r => r.state, missing: r => -r.missing.length,
    }[STAFF.sort.key];
    list.sort((a, b) => {
        const x = keyOf(a), y = keyOf(b);
        const byName = (a.e.name || '').localeCompare(b.e.name || '', 'ko');
        if (x === null || y === null) return x === y ? byName : (x === null ? 1 : -1);
        const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ko', { numeric: true });
        return STAFF.sort.dir * c || byName;
    });

    // 머리글 (누르면 정렬)
    document.getElementById('staff-head').innerHTML = STAFF_COLS.map(c => {
        const on = STAFF.sort.key === c.k;
        return `<th class="sortable"${c.title ? ` title="${c.title}"` : ''} onclick="sortStaff('${c.k}')">${c.h} <span class="arr${on ? ' on' : ''}">${on ? (STAFF.sort.dir > 0 ? '▲' : '▼') : '↕'}</span></th>`;
    }).join('') + '<th></th>';

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="${STAFF_COLS.length + 1}" style="color: #888;">${P.employees.length ? '조건에 맞는 직원이 없어요' : '등록된 사원이 없어요. [＋ 사원등록]으로 추가해 주세요.'}</td></tr>`;
        return;
    }
    const stateChip = { active: '<span class="staff-chip ok">재직</span>', upcoming: '<span class="staff-chip blue">입사 예정</span>', resigned: '<span class="staff-chip gray">퇴사</span>' };
    tbody.innerHTML = list.map(r => {
        const e = r.e, p = r.p;
        const leave = !r.leave ? '<span class="sub">-</span>'
            : `<b class="${r.leave.remaining < 0 ? 'neg' : ''}">${formatDays(r.leave.remaining)}</b><span class="sub"> / ${formatDays(r.leave.granted)}일</span>`;
        const miss = r.missing.length
            ? r.missing.map(([k, why]) => `<span class="staff-miss" title="${why}">${k}</span>`).join('')
            : '<span class="staff-ok">✓</span>';
        return `<tr class="${r.state === 'resigned' ? 'resigned' : ''}" onclick="openPayEmpModal('${e.id}')" title="눌러서 정보 수정">
            <td>${esc(e.empNo || '-')}</td>
            <td><b>${esc(e.name)}</b></td>
            <td>${esc(e.department || '-')}</td>
            <td>${esc(e.position || '-')}</td>
            <td>${esc(e.hireDate || '-')}${r.state === 'resigned' ? `<small>퇴사 ${esc(e.resignDate)}</small>` : ''}</td>
            <td>${r.service.text}</td>
            <td>${leave}</td>
            <td>${payTypeOf(p) === 'fixed' ? '고정' : '연봉'}</td>
            <td>${p.payslipTarget === true ? '<span class="staff-chip ok">대상</span>' : '<span class="sub">-</span>'}</td>
            <td>${stateChip[r.state]}</td>
            <td class="l">${miss}</td>
            <td><button class="staff-del" title="삭제" onclick="event.stopPropagation(); deletePayEmployee('${e.id}')">삭제</button></td>
        </tr>`;
    }).join('');
}
