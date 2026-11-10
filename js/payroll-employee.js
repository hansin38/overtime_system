// ==========================================
// 💵 급여 관리 ③ 사원 정보 (payroll-employee.js)
// 사원 정보 화면(근로계약서 임금구성표), 사원 등록/수정/삭제, 사원정보 엑셀 받기/올리기(양식 기억·수식)
// ==========================================

// ---------- 사원 정보 (근로계약서 임금구성표 모양) ----------
// 왼쪽: 항목별 1주 / 월 시간 / 가산 / 금액 표 (초과근무는 '월 시간'을 넘은 시간부터라 그 열을 강조)
// 오른쪽: 인적사항 · 4대보험 (작게)
function renderPayInfoPane() {
    const e = emp(P.selectedId), p = profFor(P.selectedId, P.month);
    const s = calcPayStructure(p, e);
    const fixed = getFixOtLimits(e);
    const week = e.fixedOtWeek || {};
    const type = payTypeOf(p);
    const fp = p.fixedPay || {};
    const dl = (rows) => `<dl class="pay-dl">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v || '-'}</dd>`).join('')}</dl>`;
    const m = (v) => num(v) ? won(v) : '';
    const blank = '<span class="sub">—</span>';
    const h = (v) => v === undefined || v === null || v === '' ? blank : `${v}h`;
    const row = (label, w, mo, wt, amt) => `<tr><td>${label}</td><td class="r">${w}</td><td class="r key">${mo}</td><td class="r">${wt}</td><td class="r">${amt}</td></tr>`;
    const pay = s ? s.pay : {};
    let rows = '';
    if (type === 'annual') {
        rows = row('기본급', '40h', '209h', blank, s ? won(pay.base) : '-')
            + row('연장근로수당', h(week.overtime), h(fixed.overtime), s ? h(s.weighted.overtime) : blank, s ? won(pay.overtime) : '-')
            + row('휴일근로수당', h(week.holiday), h(fixed.holiday), s ? h(s.weighted.holiday) : blank, s ? won(pay.holiday) : '-')
            + row('야간근로수당', h(week.night), h(fixed.night), s ? h(s.weighted.night) : blank, s ? won(pay.night) : '-');
    } else {
        rows = row('기본급', '40h', '209h', blank, m(fp.base) || '-')
            + row('연장근로수당', h(week.overtime), h(fixed.overtime), blank, m(fp.overtime) || '-')
            + row('휴일·야근수당', `${h(week.holiday)} / ${h(week.night)}`, `${h(fixed.holiday)} / ${h(fixed.night)}`, blank, m(fp.holidayNight) || '-');
    }
    const allow = [['식대', p.mealAllowance, '비과세'], ['차량유지비', p.vehicleAllowance, '비과세'], ['직책수당', p.positionAllowance], ['현장수당', p.siteAllowance]]
        .filter(([, v]) => num(v) > 0)
        .map(([k, v, tag]) => row(`${k}${tag ? ` <span class="pay-chip-sm">${tag}</span>` : ''}`, '', '', '', won(v))).join('');
    const total = `<tr class="tot"><td>월 합계</td><td></td><td class="key"></td><td class="r">${s && s.type === 'annual' ? h(s.totalHours) : ''}</td><td class="r">${s ? won(s.monthly) : '-'}</td></tr>`;
    const history = (p.payHistory || []).length > 1 ? p.payHistory.slice().reverse().map(x =>
        `${x.from === '0000-00' ? '처음' : x.from + '분부터'} · ${x.payType === 'fixed' ? '고정 ' + won(sumValues(x.fixedPay) + num(x.mealAllowance) + num(x.vehicleAllowance) + num(x.positionAllowance) + num(x.siteAllowance)) : '연봉 ' + won(x.annualSalary)}`).join('<br>') : '';
    const title = type === 'annual' ? `연봉 ${won(p.annualSalary)} · 월 ${s ? won(s.monthly) : '-'}` : `고정 금액 · 월 ${s ? won(s.monthly) : '-'}`;

    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-info-grid contract">
            <div>
                <div class="pay-card lock"><h4>🔒 임금 구성 <small class="sub" style="font-weight: normal;">${title}</small></h4>
                    <table class="pay-wage-tbl">
                        <tr><th>항목</th><th class="r">1주</th><th class="r key">월 시간</th><th class="r">가산</th><th class="r">금액</th></tr>
                        ${rows}${allow}${total}
                    </table>
                    <div class="pay-wage-note">⏱ 초과근무는 <b>월 시간</b>(연장 ${fixed.overtime}h · 휴일 ${fixed.holiday}h · 야간 ${fixed.night}h)을 넘은 시간부터 경비로 계산해요</div>
                    ${dl([
                        ['급여 형태', type === 'annual' ? '연봉 자동 (포괄)' : '고정 금액'],
                        s && s.type === 'annual' ? ['통상시급', `${won2(s.ordinaryWage)}원 <small class="sub">자동</small>`] : null,
                        ['경비 시급', s ? (s.ordinaryBasis ? `${won2(s.expenseWage)}원 <small class="sub">통상시급 (고정OT 시급)</small>` : `${won(s.expenseWage)}원 <small class="sub">월급÷209</small>`) : (p.legacyHourlyWage ? `${won(p.legacyHourlyWage)}원 <small class="sub">예전 통상시급</small>` : '')],
                        ['명절상여', p.holidayBonus ? `설·추석 각 ${won(p.holidayBonus)} · 연 ${won(p.holidayBonus * 2)} <small class="sub">(통상시급에 월 ${won(p.holidayBonus * 2 / 12)} 포함)</small>` : ''],
                        history ? ['변경 이력', history] : null
                    ])}
                </div>
            </div>
            <div>
                <div class="pay-card"><h4>인적사항</h4>${dl([
                    ['사원번호', esc(e.empNo)], ['전화 뒷4자리', esc(e.phoneLast4)],
                    ['부서 / 직급', `${esc(e.department || '-')} / ${esc(e.position || '-')}`],
                    ['입사일', esc(e.hireDate)], ['퇴사일', esc(e.resignDate)],
                    ['급여명세서', isTarget(e.id) ? '발급 대상' : '대상 아님'],
                    ['생년월일 🔒', esc(p.birthDate)], ['이메일 🔒', esc(p.email)], ['입금 계좌 🔒', esc(p.bankAccount)]
                ])}</div>
                <div class="pay-card"><h4>4대보험 · 소득세 <small class="sub" style="font-weight: normal;">급여대장 불러오면 자동 갱신</small></h4>${dl([
                    ['국민연금 기준', p.pensionBase === 0 ? '미가입' : (p.pensionBase ? won(p.pensionBase) : '이번 달 과세급여')],
                    ['건강보험 기준', p.healthBase ? won(p.healthBase) : '이번 달 과세급여'],
                    ['고용보험', p.employmentInsured === false ? '미가입' : '가입'],
                    ['소득세 (월)', p.incomeTaxDefault !== undefined ? `${won(p.incomeTaxDefault)}원 <small class="sub">${p.incomeTaxMonth ? p.incomeTaxMonth + ' 회계사무소' : ''}</small>` : '']
                ])}</div>
            </div>
        </div>
        <div style="display: flex; gap: 6px; justify-content: flex-end;">
            <button class="pay-btn" style="color: var(--danger-color);" onclick="deletePayEmployee('${e.id}')">삭제</button>
            <button class="pay-btn blue" onclick="openPayEmpModal('${e.id}')">정보 수정</button>
        </div>`;
}

// ------------------------------------------
// 사원 등록 / 수정 / 삭제 (기본정보는 employees, 🔒 급여정보는 payroll_profiles에 따로 저장)
// ------------------------------------------
const EMP_TEXT_FIELDS = ['name', 'phone', 'empNo', 'birth', 'email', 'bank', 'dept', 'position', 'hire', 'resign', 'fixOt', 'fixHol', 'fixNight'];
const EMP_MONEY_FIELDS = ['annual', 'fBase', 'fOt', 'fHn', 'posAllow', 'meal', 'vehicle', 'site', 'bonus', 'pensionBase', 'healthBase'];

function openPayEmpModal(empId = null) {
    P.editingEmpId = empId;
    const e = empId ? emp(empId) : {};
    const p = empId ? profFor(empId, P.month) : {};
    const fixed = getFixOtLimits(e);
    const fp = p.fixedPay || {};
    document.getElementById('pe-from').value = P.month;
    document.getElementById('pe-from-wrap').style.display = empId ? '' : 'none';
    const m = (v) => (v === undefined || v === null || v === '') ? '' : won(v);
    const v = {
        name: e.name, phone: e.phoneLast4, empNo: e.empNo, birth: p.birthDate, email: p.email, bank: p.bankAccount,
        dept: e.department, position: e.position, hire: e.hireDate, resign: e.resignDate,
        fixOt: fixed.overtime, fixHol: fixed.holiday, fixNight: fixed.night,
        annual: m(p.annualSalary), fBase: m(fp.base), fOt: m(fp.overtime), fHn: m(fp.holidayNight),
        posAllow: m(p.positionAllowance), meal: empId ? m(p.mealAllowance) : '200,000', vehicle: m(p.vehicleAllowance),
        site: m(p.siteAllowance), bonus: empId ? m(p.holidayBonus) : '200,000',
        pensionBase: m(p.pensionBase), healthBase: m(p.healthBase)
    };
    [...EMP_TEXT_FIELDS, ...EMP_MONEY_FIELDS].forEach(k => { document.getElementById('pe-' + k).value = v[k] ?? ''; });
    document.getElementById('pe-expBasis').value = p.expenseWageBasis === 'ordinary' ? 'ordinary' : 'monthly';
    document.getElementById('pe-empIns').checked = p.employmentInsured !== false;
    document.getElementById('pe-target').checked = empId ? p.payslipTarget === true : true;
    setEmpPayType(payTypeOf(p));
    // 이름·전화번호는 연장근로·연차 신청과 연결되어 있어 수정 시 잠금
    document.getElementById('pe-name').disabled = !!empId;
    document.getElementById('pe-phone').disabled = !!empId;
    document.getElementById('pay-emp-title').innerText = empId ? `사원 정보 수정 (${e.name})` : '사원 등록';
    updateEmpCalcPreview();
    document.getElementById('pay-emp-modal').style.display = 'flex';
}

function closePayEmpModal() {
    document.getElementById('pay-emp-modal').style.display = 'none';
}

function setEmpPayType(type) {
    document.getElementById('pe-type').value = type;
    document.querySelectorAll('.pay-type-opt').forEach(el => el.classList.toggle('on', el.dataset.type === type));
    document.getElementById('pe-annual-wrap').style.display = type === 'annual' ? '' : 'none';
    document.getElementById('pe-expBasis-wrap').style.display = type === 'annual' ? '' : 'none';   // 통상시급은 연봉형만 있음
    document.querySelectorAll('.pe-fixed-only').forEach(el => { el.style.display = type === 'fixed' ? '' : 'none'; });
    updateEmpCalcPreview();
}

function onEmpMoneyInput(el) {
    const raw = String(el.value).replace(/[^0-9]/g, '');
    el.value = raw ? Number(raw).toLocaleString() : '';
    updateEmpCalcPreview();
}

function readEmpForm() {
    const g = (k) => document.getElementById('pe-' + k).value.trim();
    const optMoney = (k) => g(k) === '' ? null : num(g(k));   // 빈칸 = 자동, 0 = 미가입
    const type = g('type');
    return {
        name: g('name'), phone: g('phone').replace(/\D/g, ''), empNo: g('empNo'),
        birthDate: g('birth'), email: g('email'), bankAccount: g('bank'),
        department: g('dept'), position: g('position'), hireDate: g('hire'), resignDate: g('resign'),
        fixedOt: { overtime: parseFloat(g('fixOt')) || 0, holiday: parseFloat(g('fixHol')) || 0, night: parseFloat(g('fixNight')) || 0 },
        payType: type,
        annualSalary: num(g('annual')),
        fixedPay: { base: num(g('fBase')), overtime: num(g('fOt')), holidayNight: num(g('fHn')) },
        positionAllowance: num(g('posAllow')), mealAllowance: num(g('meal')), vehicleAllowance: num(g('vehicle')),
        siteAllowance: num(g('site')), holidayBonus: num(g('bonus')),
        pensionBase: optMoney('pensionBase'), healthBase: optMoney('healthBase'),
        employmentInsured: document.getElementById('pe-empIns').checked,
        payslipTarget: document.getElementById('pe-target').checked,
        expenseWageBasis: g('expBasis') === 'ordinary' ? 'ordinary' : 'monthly',
        from: g('from')
    };
}

function pickCond(o) {
    return Object.fromEntries(PAY_COND_FIELDS.map(k => [k, k === 'fixedPay' ? { base: num((o.fixedPay || {}).base), overtime: num((o.fixedPay || {}).overtime), holidayNight: num((o.fixedPay || {}).holidayNight) } : (k === 'payType' ? payTypeOf(o) : num(o[k]))]));
}

// 급여조건이 바뀌었으면 '적용 시작 월'부터 새 조건이 적용되도록 이력에 추가
// (이전 달 급여는 예전 조건으로 계산, 맨 위 값은 이번 달 기준 조건으로 맞춤)
function nextPayHistory(profile, form) {
    const from = /^\d{4}-\d{2}$/.test(form.from || '') ? form.from : P.month;
    const newCond = pickCond(form);
    if (JSON.stringify(pickCond(condFor(profile, from))) === JSON.stringify(newCond)) return null; // 바뀐 게 없음
    let hist = (profile.payHistory || []).slice();
    if (!hist.length) hist.push({ from: '0000-00', ...pickCond(profile) });
    hist = hist.filter(h => h.from !== from).concat([{ from, ...newCond }]).sort((a, b) => a.from.localeCompare(b.from));
    return hist;
}

function updateEmpCalcPreview() {
    const box = document.getElementById('pe-preview');
    if (!box) return;
    const f = readEmpForm();
    const s = calcPayStructure(f, { fixedOt: f.fixedOt });
    if (!s) { box.innerHTML = f.payType === 'annual' ? '연봉을 입력하면 월급 구성이 자동 계산됩니다.' : '항목별 금액을 입력하면 월 지급 합계가 나옵니다.'; return; }
    if (s.type === 'fixed') {
        box.innerHTML = `월 지급 합계 ${won(s.monthly)} · 경비 시급 ${won(s.expenseWage)}원 (월급÷209)`;
        return;
    }
    const year = new Date().getFullYear();
    const minWage = MIN_WAGE[year] || MIN_WAGE[Math.max(...Object.keys(MIN_WAGE).map(Number))];
    const ok = s.ordinaryWage >= minWage;
    box.innerHTML = `월급 ${won(s.monthly)} → 기본급 ${won(s.pay.base)} · 연장 ${won(s.pay.overtime)} · 휴일·야간 ${won(s.pay.holiday + s.pay.night)}<br>
        통상시급 ${won2(s.ordinaryWage)}원 · 경비 시급 ${s.ordinaryBasis ? `${won2(s.expenseWage)}원 (통상시급)` : `${won(s.expenseWage)}원 (월급÷209)`}
        <span style="color: ${ok ? 'var(--success-color)' : 'var(--danger-color)'};">${ok ? '✅' : '⚠️'} 최저임금 ${won(minWage)}원 ${ok ? '이상' : '미달'}</span>
        ${s.pay.base < 0 ? '<br><b style="color: var(--danger-color);">⚠️ 기본급이 마이너스입니다. 연봉·수당을 확인해 주세요.</b>' : ''}`;
}

function savePayEmployee() {
    const f = readEmpForm();
    if (!f.name || f.phone.length !== 4) { alert("이름과 휴대폰 뒷자리 4자리를 정확히 입력해 주세요."); return; }
    if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { alert("이메일 형식을 확인해 주세요."); return; }
    if (f.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(f.birthDate)) { alert("생년월일은 달력에서 선택해 주세요."); return; }
    if (f.resignDate && f.hireDate && f.resignDate < f.hireDate) { alert("퇴사일이 입사일보다 빠릅니다."); return; }

    const basic = {
        empNo: f.empNo, department: f.department, position: f.position,
        hireDate: f.hireDate, resignDate: f.resignDate, fixedOt: f.fixedOt
    };
    const secret = {
        birthDate: f.birthDate, email: f.email, bankAccount: f.bankAccount,
        ...pickCond(f),
        pensionBase: f.pensionBase, healthBase: f.healthBase, employmentInsured: f.employmentInsured,
        payslipTarget: f.payslipTarget,
        expenseWageBasis: f.expenseWageBasis   // 급여조건 이력(payHistory)과 별개로 사원에 고정
    };
    if (P.editingEmpId) {
        const hist = nextPayHistory(prof(P.editingEmpId), f);
        if (hist) {
            secret.payHistory = hist;
            Object.assign(secret, pickCond(condFor({ payHistory: hist }, ymdOfDate(new Date()).slice(0, 7))));
        } else {
            // 급여조건은 그대로 → 맨 위 값도 건드리지 않음
            PAY_COND_FIELDS.forEach(k => delete secret[k]);
        }
    }
    const saveProfile = (id) => db.collection("payroll_profiles").doc(id).set(secret, { merge: true }).then(() => id);

    let job;
    if (P.editingEmpId) {
        job = db.collection("employees").doc(P.editingEmpId).update(basic).then(() => saveProfile(P.editingEmpId));
    } else {
        job = db.collection("employees").where("name", "==", f.name).where("phoneLast4", "==", f.phone).get()
            .then(snap => {
                if (!snap.empty) throw new Error('duplicate');
                return db.collection("employees").add({
                    name: f.name, phoneLast4: f.phone, ...basic,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            })
            .then(ref => saveProfile(ref.id));
    }
    job.then(id => {
        alert(P.editingEmpId ? "수정 완료!" : "등록 완료!");
        closePayEmpModal();
        P.selectedId = id;
        loadPayrollData();
        if (typeof loadSearchEmployeeList === 'function') loadSearchEmployeeList();
    }).catch(err => {
        if (err.message === 'duplicate') { alert("이미 등록된 사원입니다."); return; }
        console.error("사원 저장 실패:", err);
        alert("저장 중 오류가 발생했습니다.");
    });
}

function deletePayEmployee(empId) {
    const e = emp(empId);
    if (!confirm(`${e.name} 사원을 삭제할까요?\n※ 직원 로그인이 막히고 급여정보가 삭제됩니다. 이미 저장된 월별 급여(임금대장)는 보관됩니다.\n퇴사자는 삭제 대신 퇴사일을 입력하고, 급여명세서만 빼려면 '발급 대상' 체크를 해제하세요.`)) return;
    Promise.all([
        db.collection("employees").doc(empId).delete(),
        db.collection("payroll_profiles").doc(empId).delete()
    ]).then(() => {
        P.selectedId = null;
        loadPayrollData();
        if (typeof loadSearchEmployeeList === 'function') loadSearchEmployeeList();
    }).catch(err => { console.error("사원 삭제 실패:", err); alert("삭제 중 오류가 발생했습니다."); });
}

// ------------------------------------------
// 📄 사원정보 엑셀 받기 / 📤 엑셀 올리기 (여러 명 한꺼번에 등록·수정)
// - 받기: 빈 양식 또는 지금 정보 넣어서 (계좌·생년월일·이메일은 체크할 때만)
//   월급여·기본급·연장·휴일야근은 연봉형이면 계산값을 채워 줌 (노무사 '급여산출계산' 엑셀과 같은 식)
// - 올리기: 사원번호 → 없으면 이름+휴대폰 뒷4자리로 사람을 찾아 있으면 수정, 없으면 새로 등록
//   빈칸은 기존값 유지 ('-'를 쓰면 지움) · 바뀌는 사람만 보여 주고 체크한 사람만 저장 · 엑셀에 없는 사람은 그대로
//   연봉형의 월급여·기본급·연장·휴일야근은 저장하지 않고 계산과 비교만 (다르면 ⚠️)
//   고정OT 1주 시간을 쓰면 월 시간 = 1주 × 365 ÷ 7 ÷ 12 (0.5 단위 올림) 으로 바꿔 저장 (근로계약서 기준)
// - 급여조건이 바뀌면 '적용 시작 월'(비우면 지금 보고 있는 달)부터 새 조건 → 연봉 인상 이력에 추가 (사원 수정 창과 같은 방식)
// ------------------------------------------
const EMPXL_FIELDS = [
    { h: '사원번호', k: 'empNo', src: 'emp' },
    { h: '이름', k: 'name', src: 'emp', lock: true },
    { h: '휴대폰 뒷4자리', k: 'phoneLast4', src: 'emp', t: 'phone', lock: true },
    { h: '부서', k: 'department', src: 'emp' },
    { h: '직급', k: 'position', src: 'emp' },
    { h: '입사일', k: 'hireDate', src: 'emp', t: 'date' },
    { h: '퇴사일', k: 'resignDate', src: 'emp', t: 'date' },
    { h: '급여형태(연봉/고정)', k: 'payType', src: 'cond', t: 'payType' },
    { h: '연봉', k: 'annualSalary', src: 'cond', t: 'money' },
    { h: '월급여', k: 'monthly', src: 'check', t: 'money' },
    { h: '기본급', k: 'fixedPay.base', src: 'cond', t: 'money', alias: ['고정-기본급'] },
    { h: '연장근로수당', k: 'fixedPay.overtime', src: 'cond', t: 'money', alias: ['고정-연장근로수당'] },
    { h: '휴일·야근수당', k: 'fixedPay.holidayNight', src: 'cond', t: 'money', alias: ['고정-휴일·야근수당'], hidden: true },   // 예전 양식용 (받기에는 안 나옴)
    { h: '휴일근로수당', k: 'split.holiday', src: 'split', t: 'money' },
    { h: '야간근로수당', k: 'split.night', src: 'split', t: 'money' },
    { h: '식대', k: 'mealAllowance', src: 'cond', t: 'money' },
    { h: '차량유지비', k: 'vehicleAllowance', src: 'cond', t: 'money' },
    { h: '직책수당', k: 'positionAllowance', src: 'cond', t: 'money' },
    { h: '현장수당', k: 'siteAllowance', src: 'cond', t: 'money' },
    { h: '명절상여(설·추석 각)', k: 'holidayBonus', src: 'cond', t: 'money', alias: ['명절상여'] },
    { h: '경비시급', k: 'expenseWage', src: 'check', t: 'rate' },
    { h: '통상임금(시급)', k: 'ordinary', src: 'check', t: 'rate' },
    { h: '1주 연장(h)', k: 'week.overtime', src: 'week', t: 'hours' },
    { h: '1주 휴일(h)', k: 'week.holiday', src: 'week', t: 'hours' },
    { h: '1주 야간(h)', k: 'week.night', src: 'week', t: 'hours' },
    { h: '고정OT 연장(월h)', k: 'fixedOt.overtime', src: 'emp', t: 'hours', alias: ['고정OT 연장(h)'] },
    { h: '고정OT 휴일(월h)', k: 'fixedOt.holiday', src: 'emp', t: 'hours', alias: ['고정OT 휴일(h)'] },
    { h: '고정OT 야간(월h)', k: 'fixedOt.night', src: 'emp', t: 'hours', alias: ['고정OT 야간(h)'] },
    { h: '연장 가산(h)', k: 'wt.overtime', src: 'ref', t: 'hours', rate: 1.5 },   // 참고용 (올릴 때 무시)
    { h: '휴일 가산(h)', k: 'wt.holiday', src: 'ref', t: 'hours', rate: 1.5 },
    { h: '야간 가산(h)', k: 'wt.night', src: 'ref', t: 'hours', rate: 0.5 },
    { h: '경비시급(월급/통상)', k: 'expenseWageBasis', src: 'prof', t: 'basis' },
    { h: '명세서 발급(O/X)', k: 'payslipTarget', src: 'prof', t: 'ox' },
    { h: '고용보험(O/X)', k: 'employmentInsured', src: 'prof', t: 'ox' },
    { h: '적용 시작 월', k: 'from', src: 'meta', t: 'month' },
    { h: '생년월일', k: 'birthDate', src: 'prof', t: 'date', secret: true },
    { h: '이메일', k: 'email', src: 'prof', secret: true },
    { h: '계좌번호', k: 'bankAccount', src: 'prof', secret: true }
];
const EMPXL_LABEL = (f) => f.h.replace(/\(.*\)$/, '').trim();
const EMPXL_CHECK_KEYS = ['monthly', 'fixedPay.base', 'fixedPay.overtime', 'fixedPay.holidayNight', 'split.holiday', 'split.night'];
// 근로계약서 1주 시간 → 월 시간 (노무사 엑셀: CEILING(1주 × 365 ÷ 7 ÷ 12, 0.5))
function weekToMonthHours(w) { return ceilHalf(w * 365 / 7 / 12); }

// 월급여·기본급·연장·휴일야근 계산값 (연봉형은 연봉+고정OT로, 고정형은 입력 금액 그대로)
function empXlCalcPay(p, e) {
    const s = calcPayStructure(p, e);
    if (!s) return null;
    return {
        monthly: s.monthly, 'fixedPay.base': s.pay.base, 'fixedPay.overtime': s.pay.overtime,
        'fixedPay.holidayNight': s.type === 'annual' ? s.pay.holiday + s.pay.night : s.pay.holidayNight,
        // 고정형은 휴일·야근수당이 한 덩어리라 휴일 칸에 전부, 야간 칸은 비움 (올리면 둘을 더해서 저장)
        'split.holiday': s.type === 'annual' ? s.pay.holiday : s.pay.holidayNight,
        'split.night': s.type === 'annual' ? s.pay.night : '',
        expenseWage: s.expenseWage, ordinary: s.type === 'annual' ? s.ordinaryWage : ''
    };
}

// 지금 값 (엑셀에 쓰는 모양이 아니라 저장된 모양)
function empXlCurrent(f, e, p) {
    if (f.src === 'week') { const w = (e.fixedOtWeek || {})[f.k.split('.')[1]]; return w === undefined || w === null ? '' : w; }
    if (f.k.startsWith('fixedOt.')) return getFixOtLimits(e)[f.k.split('.')[1]];
    if (f.src === 'ref') return ceilHalf(getFixOtLimits(e)[f.k.split('.')[1]] * f.rate);
    if (f.src === 'check' || f.src === 'split' || (f.k.startsWith('fixedPay.') && payTypeOf(p) === 'annual')) {
        const c = empXlCalcPay(p, e);
        return c ? c[f.k] : '';
    }
    if (f.k.startsWith('fixedPay.')) return num((p.fixedPay || {})[f.k.split('.')[1]]);
    if (f.k === 'payType') return payTypeOf(p);
    if (f.k === 'payslipTarget') return p.payslipTarget === true;
    if (f.k === 'employmentInsured') return p.employmentInsured !== false;
    if (f.k === 'expenseWageBasis') return p.expenseWageBasis === 'ordinary' ? 'ordinary' : 'monthly';
    const v = (f.src === 'emp' ? e : p)[f.k];
    return f.t === 'money' ? num(v) : (v ?? '');
}
// 저장된 값 → 엑셀/화면 표시
function empXlShow(f, v) {
    if (f.t === 'money') return v === '' ? '' : num(v);
    if (f.t === 'rate') return v === '' ? '' : Math.round(num(v) * 100) / 100;
    if (f.t === 'payType') return v === 'fixed' ? '고정' : '연봉';
    if (f.t === 'ox') return v ? 'O' : 'X';
    if (f.t === 'basis') return v === 'ordinary' ? '통상' : '월급';
    return v ?? '';
}
function empXlShowText(f, v) {
    if (v === '' || v === null || v === undefined) return '(없음)';
    return f.t === 'money' ? won(v) : String(empXlShow(f, v));
}

function closeEmpXlDownload() { document.getElementById('pay-empxl-dl-modal').style.display = 'none'; }

// 계산 칸에 엑셀 수식 (노무사 '급여산출계산'과 같은 식) - 연봉·수당·고정OT를 고치면 엑셀에서 바로 다시 계산
//   월급여 = 연봉 ÷ 12 · 가산 = CEILING(월 시간 × 1.5 / 1.5 / 0.5, 0.5)
//   통상시급 = (월급여 + 명절상여 × 2 ÷ 12) ÷ (209 + 가산 합계)
//   연장·휴일·야간 = 통상시급 × 가산 · 기본급 = 통상시급 × 209 − (식대~현장수당) − 명절상여 × 2 ÷ 12
//   경비시급 = 월급여 ÷ 209 (경비시급 기준이 '통상'이면 통상시급)
// - 급여형태가 '고정'인 줄은 저장된 금액 그대로 (IF로 분기), 이름이 빈 줄은 빈칸
function empXlFormulas(XLSX, ws, fields, aoa, rowCount) {
    const col = (k) => { const c = fields.findIndex(f => f.k === k); return c < 0 ? null : XLSX.utils.encode_col(c); };
    const C = Object.fromEntries(['name', 'payType', 'annualSalary', 'monthly', 'fixedPay.base', 'fixedPay.overtime', 'split.holiday', 'split.night',
        'mealAllowance', 'siteAllowance', 'holidayBonus', 'expenseWage', 'ordinary', 'fixedOt.overtime', 'fixedOt.holiday', 'fixedOt.night',
        'wt.overtime', 'wt.holiday', 'wt.night', 'expenseWageBasis'].map(k => [k, col(k)]));
    if (Object.values(C).some(v => v === null)) return;
    for (let r = 1; r < rowCount; r++) {
        const n = r + 1, at = (k) => `${C[k]}${n}`;
        const ann = r < aoa.length ? aoa[r] : null;
        const fixedVal = (k) => { if (!ann) return '""'; const v = ann[fields.findIndex(f => f.k === k)]; return typeof v === 'number' ? v : '""'; };
        const bonusM = `${at('holidayBonus')}*2/12`;
        const wsum = `(${at('wt.overtime')}+${at('wt.holiday')}+${at('wt.night')})`;
        const set = (k, body, opts = {}) => {
            const addr = `${C[k]}${n}`;
            const fixedPart = opts.fixed || fixedVal(k);
            const f = opts.noFixed ? `IF(${at('name')}="","",${body})` : `IF(${at('name')}="","",IF(${at('payType')}="고정",${fixedPart},${body}))`;
            const old = ws[addr] && typeof ws[addr].v === 'number' ? ws[addr].v : '';
            ws[addr] = old === '' ? { t: 's', v: '', f } : { t: 'n', v: old, f };
        };
        set('wt.overtime', `CEILING(${at('fixedOt.overtime')}*1.5,0.5)`, { noFixed: true });
        set('wt.holiday', `CEILING(${at('fixedOt.holiday')}*1.5,0.5)`, { noFixed: true });
        set('wt.night', `CEILING(${at('fixedOt.night')}*0.5,0.5)`, { noFixed: true });
        set('monthly', `${at('annualSalary')}/12`, { fixed: `SUM(${at('fixedPay.base')}:${at('siteAllowance')})` });   // 고정형은 항목 합계
        set('ordinary', `(${at('monthly')}+${bonusM})/(${STD_MONTH_HOURS}+${wsum})`);
        set('fixedPay.overtime', `${at('ordinary')}*${at('wt.overtime')}`);
        set('split.holiday', `${at('ordinary')}*${at('wt.holiday')}`);
        set('split.night', `${at('ordinary')}*${at('wt.night')}`);
        set('fixedPay.base', `${at('ordinary')}*${STD_MONTH_HOURS}-SUM(${at('mealAllowance')}:${at('siteAllowance')})-${bonusM}`);
        set('expenseWage', `IF(AND(${at('payType')}<>"고정",${at('expenseWageBasis')}="통상"),${at('ordinary')},${at('monthly')}/${STD_MONTH_HOURS})`, { noFixed: true });
    }
}

// 엑셀 서식: 글꼴 10 · 머리글은 굵게+줄바꿈 · 금액은 천 단위 쉼표 · 열 너비는 내용에 맞춰 최소로 (예시 줄은 너비 계산에서 뺌)
function empXlStyle(XLSX, ws, fields, aoa, rowCount) {
    const textW = (v) => [...String(v ?? '')].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2000 ? 1.7 : 1), 0);
    const font = { name: '맑은 고딕', sz: 10 };
    const border = { bottom: { style: 'thin', color: { rgb: 'D0D4D9' } } };
    ws['!cols'] = fields.map((f, c) => {
        let w = 0;
        aoa.forEach((row, r) => {
            if (r === 1) return;   // 예시 줄
            const v = row[c];
            w = Math.max(w, textW(f.t === 'money' && typeof v === 'number' ? v.toLocaleString() : v));
        });
        // 머리글은 두 줄까지 줄바꿈되므로 절반 길이 정도면 충분
        const head = Math.max(...f.h.split(/[\s(]/).map(textW));
        return { wch: Math.ceil(Math.max(4, w, head, textW(f.h) / 2)) + 1 };
    });
    ws['!rows'] = [{ hpt: 30 }];
    for (let r = 0; r < rowCount; r++) {
        fields.forEach((f, c) => {
            const a = XLSX.utils.encode_cell({ r, c });
            if (!ws[a]) ws[a] = { t: 's', v: '' };
            const cell = ws[a];
            if (r === 0) cell.s = { font: { ...font, bold: true }, fill: { fgColor: { rgb: 'EEF1F4' } }, alignment: { wrapText: true, vertical: 'center', horizontal: 'center' }, border };
            else if (r === 1) cell.s = { font: { ...font, color: { rgb: '9A8A3A' }, italic: true }, fill: { fgColor: { rgb: 'FFF9DB' } } };
            else cell.s = { font };
            if (f.t === 'money' && cell.t === 'n') cell.z = '#,##0';
            if (f.t === 'rate' && cell.t === 'n') cell.z = '#,##0.00';
        });
    }
}

// 글꼴·서식이 저장되는 엑셀 프로그램(xlsx-js-style, SheetJS 0.18.5와 사용법 같음)을 사원정보 엑셀 받을 때만 불러옴
// - 페이지 전체가 쓰는 XLSX(급여대장 불러오기·대장 다운로드)는 그대로 두고, 따로 XLSX_STYLE 로 보관
function loadXlsxStyle() {
    if (window.XLSX_STYLE) return Promise.resolve(window.XLSX_STYLE);
    return new Promise((resolve, reject) => {
        const orig = window.XLSX;
        const sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js';
        sc.onload = () => { window.XLSX_STYLE = window.XLSX; window.XLSX = orig; resolve(window.XLSX_STYLE); };
        sc.onerror = () => { window.XLSX = orig; reject(new Error('엑셀 서식 프로그램을 불러오지 못했어요')); };
        document.head.appendChild(sc);
    });
}

// ---------- 내가 올린 엑셀을 받기 양식으로 (payroll_settings/emp_excel_template, 관리자만) ----------
// - 올릴 때 파일 그대로(base64) 저장 → [지금 정보 넣어서] 받으면 그 파일을 열어
//   수식 칸은 그대로 두고, 값 칸(연봉·수당·고정OT·부서 등)만 지금 정보로 바꿈 · 새 사원은 맨 아래에 윗줄 수식 복사해서 추가
const EMPXL_TPL_DOC = () => db.collection("payroll_settings").doc("emp_excel_template");
function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
function b64ToBytes(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}
function saveEmpXlTemplate(bytes, fileName) {
    if (bytes.length > 600000) return;   // 너무 큰 파일은 저장 안 함 (Firestore 문서 1MB 제한)
    const tpl = { data: bytesToB64(bytes), fileName, savedAt: Date.now() };
    EMPXL_TPL_DOC().set(tpl)
        .then(() => { P.empXlTemplate = tpl; })
        .catch(err => console.error("엑셀 양식 저장 실패:", err));
}
function loadEmpXlTemplate() {
    if (P.empXlTemplate !== undefined) return Promise.resolve(P.empXlTemplate);
    return EMPXL_TPL_DOC().get()
        .then(doc => (P.empXlTemplate = doc.exists ? doc.data() : null))
        .catch(err => { console.error("엑셀 양식 읽기 실패:", err); return null; });
}
function openEmpXlDownload() {
    document.getElementById('pay-empxl-dl-modal').style.display = 'flex';
    const info = document.getElementById('empxl-tpl-info');
    info.innerHTML = '';
    loadEmpXlTemplate().then(tpl => {
        info.innerHTML = tpl
            ? `<label class="pay-chk"><input type="checkbox" id="empxl-use-tpl" checked> 내가 올린 엑셀 모양·수식 그대로 <small class="sub">(${esc(tpl.fileName)} · ${ymdOfDate(new Date(tpl.savedAt))})</small></label>`
            : `<div class="sub" style="margin-top: 10px;">엑셀을 한 번 올리면 다음부터 그 모양·수식 그대로 받을 수 있어요</div>`;
    });
}

// 수식 안의 같은 줄 번호를 새 줄 번호로 (A15 → A20, $A$15 처럼 $가 붙은 줄은 그대로)
function shiftFormulaRow(f, from, to) {
    return f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(])/g, (m, a, c, b, row) => (b === '$' || Number(row) !== from) ? m : `${a}${c}${b}${to}`);
}

function downloadEmpXlFromTemplate(XLSX, tpl, secret) {
    const wb = XLSX.read(b64ToBytes(tpl.data), { type: 'array', cellStyles: true, cellFormula: true, cellNF: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const { h, cols } = empXlFindHeader(rows);
    if (h < 0) return false;
    const ci = (k) => (cols.find(x => x.f.k === k) || {}).ci;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const cellAt = (r, c) => ws[XLSX.utils.encode_cell({ r, c })];
    // 값 칸 채우기 (수식 칸은 건드리지 않음)
    const fill = (r, e) => {
        const p = profFor(e.id, P.month);
        cols.forEach(({ f, ci: c }) => {
            const addr = XLSX.utils.encode_cell({ r, c });
            const old = ws[addr];
            if (old && old.f) return;
            let v = f.k === 'from' ? '' : (f.secret && !secret ? '' : empXlShow(f, empXlCurrent(f, e, p)));
            if (f.t === 'rate' && v !== '') v = Math.round(v * 100) / 100;
            const cell = { ...(old || {}), t: typeof v === 'number' ? 'n' : 's', v };
            delete cell.w;
            ws[addr] = cell;
        });
        wrapFixed(r, e, p);
    };
    // 계산 칸 수식을 '급여형태가 고정이면' 조건으로 감싸기 (원래 수식은 그대로, 이미 고정 조건이 있으면 그대로)
    //   통상임금 → 빈칸 · 기본급·연장·휴일·야간 → 사이트에 저장된 금액 · 월급여 → 기본급~현장수당 합계
    const hCol = ci('payType');
    const origF = {};   // 감싸기 전 수식 (새 사원 줄에 복사할 때 씀)
    const wrapFixed = (r, e, p) => {
        if (hCol === undefined) return;
        const n = r + 1, H = `$${XLSX.utils.encode_col(hCol)}${n}`;
        const isFixed = payTypeOf(p) === 'fixed';
        const baseC = ci('fixedPay.base'), siteC = ci('siteAllowance');
        ['ordinary', 'monthly', 'fixedPay.base', 'fixedPay.overtime', 'fixedPay.holidayNight', 'split.holiday', 'split.night'].forEach(k => {
            const c = ci(k);
            if (c === undefined) return;
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr];
            if (!cell || !cell.f || cell.f.includes('="고정"')) return;
            const f = EMPXL_FIELDS.find(x => x.k === k);
            let alt;
            if (k === 'ordinary') alt = '""';
            else if (k === 'monthly' && baseC !== undefined && siteC !== undefined && baseC < siteC) alt = `SUM(${XLSX.utils.encode_col(baseC)}${n}:${XLSX.utils.encode_col(siteC)}${n})`;
            else { const v = empXlCurrent(f, e, p); alt = typeof v === 'number' ? Math.round(v) : '""'; }
            origF[addr] = cell.f;
            cell.f = `IF(${H}="고정",${alt},${cell.f})`;
            if (isFixed) {   // 엑셀이 다시 계산하기 전에도 맞게 보이도록 저장값도 고정 쪽으로
                const v = k === 'ordinary' ? '' : empXlCurrent(f, e, p);
                cell.t = typeof v === 'number' ? 'n' : 's'; cell.v = v === '' ? '' : v; delete cell.w;
            }
        });
    };
    const done = new Set();
    let lastRow = h;
    for (let r = h + 1; r <= range.e.r; r++) {
        const no = String((cellAt(r, ci('empNo')) || {}).v ?? '').trim();
        const name = String((cellAt(r, ci('name')) || {}).v ?? '').trim();
        const phone = String((cellAt(r, ci('phoneLast4')) || {}).v ?? '').replace(/\D/g, '').padStart(4, '0');
        if (!no && !name) continue;
        if (no.includes('예시') || name.includes('예시')) continue;
        lastRow = r;
        const e = (no && P.employees.find(x => String(x.empNo || '') === no)) || P.employees.find(x => x.name === name && x.phoneLast4 === phone);
        if (e && !done.has(e.id)) { fill(r, e); done.add(e.id); }
    }
    // 엑셀에 없는 사원은 맨 아래에 추가 (마지막 사원 줄의 수식·서식 복사)
    const extra = [...P.employees].filter(e => !done.has(e.id))
        .sort((a, b) => (num(a.empNo) || 1e9) - (num(b.empNo) || 1e9) || String(a.name).localeCompare(b.name));
    let r = lastRow;
    extra.forEach(e => {
        r++;
        for (let c = range.s.c; c <= range.e.c; c++) {
            const src = cellAt(lastRow, c);
            const addr = XLSX.utils.encode_cell({ r, c });
            const srcF = src && (origF[XLSX.utils.encode_cell({ r: lastRow, c })] || src.f);
            if (src && src.f) ws[addr] = { t: 'n', v: 0, f: shiftFormulaRow(srcF, lastRow + 1, r + 1), ...(src.s ? { s: src.s } : {}), ...(src.z ? { z: src.z } : {}) };
            else if (src) ws[addr] = { t: 's', v: '', ...(src.s ? { s: src.s } : {}), ...(src.z ? { z: src.z } : {}) };
        }
        fill(r, e);
    });
    if (r > range.e.r) { range.e.r = r; ws['!ref'] = XLSX.utils.encode_range(range); }
    XLSX.writeFile(wb, `사원정보_${ymdOfDate(new Date())}.xlsx`, { cellStyles: true });
    return true;
}

async function downloadEmpXl(withData) {
    let XLSX = window.XLSX;
    try { XLSX = await loadXlsxStyle(); }
    catch (err) { console.error(err); }   // 못 불러오면 서식 없이라도 받기
    const secret = document.getElementById('empxl-secret').checked;
    const useTpl = document.getElementById('empxl-use-tpl');
    if (withData && useTpl && useTpl.checked && P.empXlTemplate) {
        try {
            if (downloadEmpXlFromTemplate(XLSX, P.empXlTemplate, secret)) { closeEmpXlDownload(); return; }
        } catch (err) { console.error("올린 양식으로 받기 실패 → 기본 양식으로:", err); }
    }
    const fields = EMPXL_FIELDS.filter(f => (secret || !f.secret) && !f.hidden);
    const example = {
        empNo: '예시', name: '홍길동', phoneLast4: '0000', department: '설계부', position: '사원', hireDate: '2026-11-01', resignDate: '',
        payType: '연봉', annualSalary: 40000000, monthly: '자동', 'fixedPay.base': '자동', 'fixedPay.overtime': '자동', 'split.holiday': '자동', 'split.night': '자동', expenseWage: '자동', ordinary: '자동',
        mealAllowance: 200000, vehicleAllowance: '', positionAllowance: '', siteAllowance: '', holidayBonus: 200000,
        'week.overtime': 10, 'week.holiday': 2, 'week.night': 2.5,
        'fixedOt.overtime': 43.5, 'fixedOt.holiday': 9, 'fixedOt.night': 11,
        expenseWageBasis: '월급', payslipTarget: 'O', employmentInsured: 'O',
        from: '2027-01', birthDate: '1999-01-01', email: 'a@b.com', bankAccount: '은행 계좌'
    };
    const aoa = [fields.map(f => f.h), fields.map(f => example[f.k] ?? '')];
    if (withData) {
        const list = [...P.employees].sort((a, b) => (num(a.empNo) || 1e9) - (num(b.empNo) || 1e9) || String(a.name).localeCompare(b.name));
        list.forEach(e => {
            const p = profFor(e.id, P.month);
            aoa.push(fields.map(f => f.k === 'from' ? '' : empXlShow(f, empXlCurrent(f, e, p))));
        });
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // 월 고정OT 칸에 수식: 1주 칸을 쓰면 엑셀에서 바로 월 시간으로 바뀜 (비어 있으면 지금 값 그대로)
    // 아래로 빈 줄 30개에도 수식을 미리 넣어 둠 (새 사원용, 1주를 안 쓰면 빈칸)
    const extra = 30;
    ['overtime', 'holiday', 'night'].forEach(k => {
        const wc = fields.findIndex(f => f.k === `week.${k}`), mc = fields.findIndex(f => f.k === `fixedOt.${k}`);
        if (wc < 0 || mc < 0) return;
        for (let r = 1; r < aoa.length + extra; r++) {
            const w = XLSX.utils.encode_cell({ r, c: wc });
            const cur = r < aoa.length ? aoa[r][mc] : '';
            const wv = r < aoa.length ? aoa[r][wc] : '';
            const calc = `CEILING(${w}*365/7/12,0.5)`;
            const fallback = cur === '' ? '""' : cur;
            const v = wv !== '' ? weekToMonthHours(num(wv)) : cur;
            ws[XLSX.utils.encode_cell({ r, c: mc })] = v === '' ? { t: 's', v: '', f: `IF(${w}="",${fallback},${calc})` } : { t: 'n', v, f: `IF(${w}="",${fallback},${calc})` };
        }
    });
    empXlFormulas(XLSX, ws, fields, aoa, aoa.length + extra);
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length + extra - 1, c: fields.length - 1 } });
    empXlStyle(XLSX, ws, fields, aoa, aoa.length + extra);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '사원정보');
    XLSX.writeFile(wb, withData ? `사원정보_${ymdOfDate(new Date())}.xlsx` : '사원정보_빈양식.xlsx');
    closeEmpXlDownload();
}

// 엑셀 칸 하나 읽기 → undefined(빈칸=유지) / { v } / { err }
function empXlParse(f, raw) {
    if (raw === '' || raw === null || raw === undefined) return undefined;
    const s = String(raw).trim();
    if (s === '') return undefined;
    if (s === '-' && !f.lock) return { v: f.t === 'money' || f.t === 'hours' ? 0 : '' };   // '-' = 지우기
    const toYmd = (x) => {
        if (x instanceof Date) return ymdOfDate(new Date(x.getTime() + 12 * 3600000));   // 엑셀 날짜의 시간대 오차 보정
        if (typeof x === 'number') { const d = XLSX.SSF.parse_date_code(x); return d ? `${d.y}-${pad2(d.m)}-${pad2(d.d)}` : ''; }
        const m = /^(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]*(?:(\d{1,2}))?/.exec(String(x).trim());
        return m ? `${m[1]}-${pad2(m[2])}${m[3] ? '-' + pad2(m[3]) : ''}` : '';
    };
    switch (f.t) {
        case 'phone': {
            const d = s.replace(/\D/g, '').padStart(4, '0');
            return d.length === 4 ? { v: d } : { err: `휴대폰 뒷자리(${s})가 4자리가 아니에요` };
        }
        case 'date': {
            const d = toYmd(raw);
            return /^\d{4}-\d{2}-\d{2}$/.test(d) ? { v: d } : { err: `${EMPXL_LABEL(f)}(${s})를 날짜로 읽지 못했어요 (예: 2026-11-01)` };
        }
        case 'month': {
            const d = toYmd(raw).slice(0, 7);
            return /^\d{4}-\d{2}$/.test(d) ? { v: d } : { err: `적용 시작 월(${s})을 읽지 못했어요 (예: 2027-01)` };
        }
        case 'money':
            if (typeof raw !== 'number' && !/\d/.test(s)) return undefined;   // '연봉형은 자동' 같은 안내 글은 무시
            return { v: Math.round(num(raw)) };
        case 'rate': {   // 통상시급·경비시급 (소수 그대로, 숫자가 아니면 무시)
            const n = typeof raw === 'number' ? raw : parseFloat(s.replace(/,/g, ''));
            return isNaN(n) ? undefined : { v: n };
        }
        case 'hours': {
            if (typeof raw !== 'number' && !/\d/.test(s)) return undefined;
            const n = parseFloat(s);
            return isNaN(n) || n < 0 ? { err: `${EMPXL_LABEL(f)}(${s})이 숫자가 아니에요` } : { v: n };
        }
        case 'payType':
            if (/연봉|annual/i.test(s)) return { v: 'annual' };
            if (/고정|fixed/i.test(s)) return { v: 'fixed' };
            return { err: `급여형태(${s})는 '연봉' 또는 '고정'으로 써 주세요` };
        case 'ox':
            if (/^(o|○|y|yes|예|1|true|발급|가입)$/i.test(s)) return { v: true };
            if (/^(x|×|n|no|아니오|0|false|미발급|미가입)$/i.test(s)) return { v: false };
            return { err: `${EMPXL_LABEL(f)}(${s})는 O 또는 X로 써 주세요` };
        case 'basis':
            if (s.includes('통상')) return { v: 'ordinary' };
            if (s.includes('월급')) return { v: 'monthly' };
            return { err: `경비시급(${s})은 '월급' 또는 '통상'으로 써 주세요` };
        default: return { v: s };
    }
}

function openEmpXlUpload() {
    P.empXlRows = [];
    document.getElementById('empxl-file').value = '';
    document.getElementById('empxl-drop').style.display = '';
    document.getElementById('empxl-result').innerHTML = '';
    document.getElementById('empxl-status').innerText = '';
    const btn = document.getElementById('empxl-save');
    btn.disabled = true; btn.innerText = '저장';
    document.getElementById('pay-empxl-up-modal').style.display = 'flex';
}
function closeEmpXlUpload() { document.getElementById('pay-empxl-up-modal').style.display = 'none'; }

function onEmpXlFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            P.empXlRows = buildEmpXlRows(rows);
            document.getElementById('empxl-drop').style.display = 'none';
            renderEmpXlRows();
            // 올린 엑셀(.xlsx)을 '받기 양식'으로 기억 → [지금 정보 넣어서] 받을 때 이 모양·수식 그대로
            if (/\.xlsx$/i.test(file.name)) saveEmpXlTemplate(new Uint8Array(reader.result), file.name);
        } catch (err) {
            console.error("사원정보 엑셀 읽기 실패:", err);
            document.getElementById('empxl-result').innerHTML = `<div class="pay-note warn">${esc(err.message)}</div>`;
        }
    };
    reader.readAsArrayBuffer(file);
}

// 1주 시간 → 월 고정OT로 바꾸기 (월 칸도 썼는데 다르면 1주 기준으로 저장하고 알려 줌)
function empXlApplyWeek(vals, warns) {
    const week = {};
    ['overtime', 'holiday', 'night'].forEach(k => {
        if (!(`week.${k}` in vals)) return;
        const w = vals[`week.${k}`], m = weekToMonthHours(w);
        week[k] = w;
        if (`fixedOt.${k}` in vals && vals[`fixedOt.${k}`] !== m) warns.push(`고정OT ${OT_LABELS[k]}: 1주 ${w}h → 월 ${m}h로 저장 (엑셀 월 칸 ${vals[`fixedOt.${k}`]}h는 무시)`);
        vals[`fixedOt.${k}`] = m;
    });
    return week;
}

// 월급여·기본급·연장·휴일야근 검사 (연봉형은 계산값과, 고정형은 월급여 = 항목 합계인지) - 1원 차이는 반올림이라 넘어감
function empXlCheckPay(checks, cond, fixedOt, warns) {
    const keys = Object.keys(checks);
    if (!keys.length) return;
    const p = { ...cond };
    if (cond.payType === 'annual') {
        const c = empXlCalcPay(p, { fixedOt });
        if (!c) return;
        keys.forEach(k => {
            if (Math.abs(checks[k] - c[k]) > 2) warns.push(`${EMPXL_LABEL(EMPXL_FIELDS.find(f => f.k === k))}: 엑셀 ${won(checks[k])} ↔ 계산 ${won(c[k])} (연봉형은 계산값으로 써요)`);
        });
    } else if ('monthly' in checks) {
        const sum = num(cond.fixedPay.base) + num(cond.fixedPay.overtime) + num(cond.fixedPay.holidayNight)
            + num(cond.mealAllowance) + num(cond.vehicleAllowance) + num(cond.positionAllowance) + num(cond.siteAllowance);
        if (Math.abs(checks.monthly - sum) > 2) warns.push(`월급여: 엑셀 ${won(checks.monthly)} ↔ 항목 합계 ${won(sum)}`);
    }
}

// 사원정보 엑셀의 머리글 줄 찾기 → { h: 줄 번호(없으면 -1), cols: [{ f: EMPXL_FIELDS 항목, ci: 열 번호 }] }
// (띄어쓰기·줄바꿈 무시, 예전 양식 이름(alias)도 인식)
function empXlFindHeader(rows) {
    const norm = (v) => String(v ?? '').replace(/\s/g, '');
    const h = rows.findIndex(r => r.some(c => norm(c) === '이름') && r.some(c => norm(c).startsWith('휴대폰')));
    const cols = [];
    if (h >= 0) rows[h].forEach((c, ci) => {
        const f = EMPXL_FIELDS.find(x => [x.h, ...(x.alias || [])].some(n => norm(n) === norm(c)));
        if (f) cols.push({ f, ci });
    });
    return { h, cols };
}

function buildEmpXlRows(rows) {
    const { h, cols } = empXlFindHeader(rows);
    if (h < 0) throw new Error('"이름", "휴대폰 뒷4자리" 머리글을 찾지 못했어요. [📄 엑셀 받기]로 받은 양식에 써 주세요.');
    const hasBonusCol = cols.some(c => c.f.k === 'holidayBonus');
    const curMonth = ymdOfDate(new Date()).slice(0, 7);
    const out = [];
    const seen = new Set();
    for (let r = h + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        if (!row.some(c => String(c ?? '').trim() !== '')) continue;
        const vals = {}, errs = [];
        cols.forEach(({ f, ci }) => {
            const res = empXlParse(f, row[ci]);
            if (!res) return;
            if (res.err) errs.push(res.err); else vals[f.k] = res.v;
        });
        if (String(vals.empNo || '').includes('예시') || String(vals.name || '').includes('예시')) continue;
        const label = vals.name || (vals.empNo ? `사원번호 ${vals.empNo}` : `${r + 1}번째 줄`);
        if (errs.length) { out.push({ kind: 'err', name: label, msg: errs.join(' · ') }); continue; }

        const byNo = vals.empNo ? P.employees.find(e => String(e.empNo || '') === String(vals.empNo)) : null;
        const byName = vals.name && vals.phoneLast4 ? P.employees.find(e => e.name === vals.name && e.phoneLast4 === vals.phoneLast4) : null;
        if (byNo && byName && byNo !== byName) { out.push({ kind: 'err', name: label, msg: `사원번호 ${vals.empNo}은(는) ${byNo.name} 님 번호예요` }); continue; }
        const target = byNo || byName;
        if (byNo && vals.name && vals.name !== byNo.name) { out.push({ kind: 'err', name: label, msg: `사원번호 ${vals.empNo}은(는) ${byNo.name} 님으로 등록돼 있어요` }); continue; }
        if (target && seen.has(target.id)) { out.push({ kind: 'err', name: label, msg: '엑셀에 같은 사람이 두 줄 있어요 (아래 줄은 건너뜀)' }); continue; }

        const warns = [];
        const week = empXlApplyWeek(vals, warns);
        const from = vals.from || P.month;
        const pFrom = target ? profFor(target.id, from) : {};
        const type = vals.payType || (target ? payTypeOf(pFrom) : 'annual');
        // 연봉형의 월급여·기본급·연장·휴일야근 = 검사만 / 고정형의 월급여 = 검사만
        // 휴일근로수당 / 야간근로수당 두 칸 → 고정형은 더해서 휴일·야근수당으로 저장 (연봉형은 아래에서 검사만)
        if (type !== 'annual' && ('split.holiday' in vals || 'split.night' in vals) && !('fixedPay.holidayNight' in vals)) {
            vals['fixedPay.holidayNight'] = num(vals['split.holiday']) + num(vals['split.night']);
        }
        // 명절상여 열 자체가 없고 통상임금(시급)이 있으면 (직접 수식을 건 엑셀) 수식에서 거꾸로 찾기:
        //   통상시급 × (209 + 가산시간) − 월급 = 명절상여 월할(설·추석 각 × 2 ÷ 12) → 1,000원 단위
        if (!hasBonusCol && vals.ordinary > 0) {
            const ot = { ...getFixOtLimits(target || {}) };
            ['overtime', 'holiday', 'night'].forEach(k => { if (`fixedOt.${k}` in vals) ot[k] = vals[`fixedOt.${k}`]; });
            const totalH = STD_MONTH_HOURS + ceilHalf(ot.overtime * 1.5) + ceilHalf(ot.holiday * 1.5) + ceilHalf(ot.night * 0.5);
            const monthlyRaw = vals.annualSalary > 0 ? vals.annualSalary / 12 : num(vals.monthly);
            if (monthlyRaw > 0) {
                const each = Math.round((vals.ordinary * totalH - monthlyRaw) * 6 / 1000) * 1000;
                if (each >= 0) vals.holidayBonus = each;
            }
        }
        delete vals.ordinary; delete vals.expenseWage;
        ['overtime', 'holiday', 'night'].forEach(k => delete vals[`wt.${k}`]);
        const checks = {};
        EMPXL_CHECK_KEYS.forEach(k => {
            if (k in vals && (type === 'annual' || k === 'monthly')) { checks[k] = vals[k]; delete vals[k]; }
        });
        delete vals['split.holiday']; delete vals['split.night'];

        if (!target) {
            // 🆕 새로 등록: 이름·휴대폰 뒷4자리 필수, 빈칸은 0 (명세서 발급·고용보험은 기본 O)
            if (!vals.name || !vals.phoneLast4) { out.push({ kind: 'err', name: label, msg: '새로 등록하려면 이름과 휴대폰 뒷4자리가 필요해요' }); continue; }
            if (vals.hireDate && vals.resignDate && vals.resignDate < vals.hireDate) { out.push({ kind: 'err', name: label, msg: '퇴사일이 입사일보다 빨라요' }); continue; }
            const fixed = getFixOtLimits({});
            const basic = {
                name: vals.name, phoneLast4: vals.phoneLast4, empNo: vals.empNo || '', department: vals.department || '', position: vals.position || '',
                hireDate: vals.hireDate || '', resignDate: vals.resignDate || '',
                fixedOt: { overtime: vals['fixedOt.overtime'] ?? fixed.overtime, holiday: vals['fixedOt.holiday'] ?? fixed.holiday, night: vals['fixedOt.night'] ?? fixed.night }
            };
            if (Object.keys(week).length) basic.fixedOtWeek = week;
            const cond = pickCond({
                payType: type, annualSalary: vals.annualSalary,
                fixedPay: { base: vals['fixedPay.base'], overtime: vals['fixedPay.overtime'], holidayNight: vals['fixedPay.holidayNight'] },
                mealAllowance: vals.mealAllowance, vehicleAllowance: vals.vehicleAllowance, positionAllowance: vals.positionAllowance,
                siteAllowance: vals.siteAllowance, holidayBonus: vals.holidayBonus
            });
            empXlCheckPay(checks, cond, basic.fixedOt, warns);
            const profile = {
                ...cond, birthDate: vals.birthDate || '', email: vals.email || '', bankAccount: vals.bankAccount || '',
                payslipTarget: vals.payslipTarget ?? true, employmentInsured: vals.employmentInsured ?? true,
                expenseWageBasis: vals.expenseWageBasis || 'monthly', pensionBase: null, healthBase: null
            };
            const summary = [basic.department, basic.position, cond.payType === 'fixed' ? '고정 금액' : (cond.annualSalary ? `연봉 ${won(cond.annualSalary)}` : ''), basic.hireDate ? `${basic.hireDate} 입사` : ''].filter(Boolean).join(' · ');
            out.push({ kind: 'new', name: vals.name, summary, basic, profile, warns, on: true });
            continue;
        }

        // ✏️ 수정: 엑셀에 쓴 칸만 비교
        seen.add(target.id);
        const e = target;
        const pNow = profFor(e.id, P.month);
        const basic = {}, prof2 = {}, changes = [];
        const fixedOt = { ...getFixOtLimits(e) };
        let otChanged = false;
        const newCond = pickCond(pFrom);
        let condChanged = false;
        EMPXL_FIELDS.forEach(f => {
            if (!(f.k in vals) || f.lock || f.src === 'meta' || f.src === 'week' || f.src === 'check' || f.src === 'ref') return;
            const v = vals[f.k];
            const old = empXlCurrent(f, e, f.src === 'cond' ? pFrom : pNow);
            if (String(old) === String(v)) return;
            const otk = f.k.startsWith('fixedOt.') ? f.k.split('.')[1] : null;
            changes.push({ label: EMPXL_LABEL(f), old: empXlShowText(f, old), now: empXlShowText(f, v), cond: f.src === 'cond', note: otk && otk in week ? `1주 ${week[otk]}h` : '' });
            if (otk) { fixedOt[otk] = v; otChanged = true; }
            else if (f.k.startsWith('fixedPay.')) { newCond.fixedPay[f.k.split('.')[1]] = v; condChanged = true; }
            else if (f.src === 'cond') { newCond[f.k] = v; condChanged = true; }
            else if (f.src === 'emp') basic[f.k] = v;
            else prof2[f.k] = v;
        });
        if (otChanged) basic.fixedOt = fixedOt;
        if (Object.keys(week).length) {
            const merged = { ...(e.fixedOtWeek || {}), ...week };
            if (JSON.stringify(merged) !== JSON.stringify(e.fixedOtWeek || {})) basic.fixedOtWeek = merged;
        }
        const hire = basic.hireDate ?? e.hireDate, resign = basic.resignDate ?? e.resignDate;
        if (hire && resign && resign < hire) { out.push({ kind: 'err', name: e.name, msg: '퇴사일이 입사일보다 빨라요' }); continue; }
        empXlCheckPay(checks, newCond, fixedOt, warns);
        if (condChanged) {
            const hist = nextPayHistory(prof(e.id), { ...newCond, from });
            if (hist) { prof2.payHistory = hist; Object.assign(prof2, pickCond(condFor({ payHistory: hist }, curMonth))); }
        }
        const hasSave = changes.length || basic.fixedOtWeek;
        if (!hasSave && !warns.length) { out.push({ kind: 'same', name: e.name }); continue; }
        out.push({ kind: hasSave ? 'mod' : 'warn', id: e.id, name: e.name, changes, from: condChanged ? from : '', basic, profile: prof2, warns, on: !!hasSave });
    }
    return out;
}

function renderEmpXlRows() {
    const rows = P.empXlRows;
    const shown = rows.filter(r => r.kind !== 'same');
    const same = rows.length - shown.length;
    const warnHtml = (r) => (r.warns || []).length ? `<div class="warn">${r.warns.map(w => `⚠️ ${esc(w)}`).join('<br>')}</div>` : '';
    const lines = shown.map(r => {
        const i = rows.indexOf(r);
        if (r.kind === 'err') return `<div class="pay-xl-line err"><span class="ck"></span><span class="nm">${esc(r.name)}</span><span class="what">⚠️ ${esc(r.msg)} <span class="sub">(건너뜀)</span></span></div>`;
        if (r.kind === 'warn') return `<div class="pay-xl-line"><span class="ck"></span><span class="nm">${esc(r.name)}</span><span class="what"><span class="sub">바뀌는 칸 없음 · 확인만 해 주세요</span>${warnHtml(r)}</span></div>`;
        const what = r.kind === 'new'
            ? `🆕 새로 등록 ${r.summary ? `<span class="sub">${esc(r.summary)}</span>` : ''}`
            : (r.changes.map(c => `${esc(c.label)} <span class="old">${esc(c.old)}</span> → <span class="new">${esc(c.now)}</span>${c.note ? ` <span class="sub">(${esc(c.note)})</span>` : ''}${c.cond && r.from ? ` <span class="sub">(${r.from.replace('-', '년 ')}월부터)</span>` : ''}`).join('<br>')
                || '<span class="sub">근로계약 1주 시간 저장</span>');
        return `<label class="pay-xl-line"><input type="checkbox" class="ck" ${r.on ? 'checked' : ''} onchange="P.empXlRows[${i}].on = this.checked; renderEmpXlRows()"><span class="nm">${esc(r.name)}</span><span class="what">${what}${warnHtml(r)}</span></label>`;
    }).join('');
    document.getElementById('empxl-result').innerHTML = shown.length
        ? `<div class="sub" style="margin-bottom: 6px;">바뀌는 사람만 보여요 · 체크를 풀면 빼고 저장해요</div>${lines}`
        : `<div class="pay-note">바뀌는 내용이 없어요 (${same}명 모두 같음)</div>`;
    const n = rows.filter(r => (r.kind === 'new' || r.kind === 'mod') && r.on).length;
    document.getElementById('empxl-status').innerText = `${same ? `변경 없음 ${same}명 · ` : ''}빈칸은 그대로 둬요`;
    const btn = document.getElementById('empxl-save');
    btn.disabled = !n;
    btn.innerText = `${n}명 저장`;
}

function saveEmpXl() {
    const rows = P.empXlRows.filter(r => (r.kind === 'new' || r.kind === 'mod') && r.on);
    if (!rows.length) return;
    setPayBusy(true, '사원정보 저장 중...');
    const jobs = rows.map(r => {
        if (r.kind === 'new') {
            return db.collection("employees").add({ ...r.basic, createdAt: firebase.firestore.FieldValue.serverTimestamp() })
                .then(ref => db.collection("payroll_profiles").doc(ref.id).set(r.profile, { merge: true }));
        }
        const a = Object.keys(r.basic).length ? db.collection("employees").doc(r.id).update(r.basic) : Promise.resolve();
        return a.then(() => Object.keys(r.profile).length ? db.collection("payroll_profiles").doc(r.id).set(r.profile, { merge: true }) : null);
    });
    Promise.allSettled(jobs).then(results => {
        setPayBusy(false);
        const failed = results.map((x, i) => x.status === 'rejected' ? rows[i].name : null).filter(Boolean);
        results.forEach(x => { if (x.status === 'rejected') console.error("사원정보 저장 실패:", x.reason); });
        closeEmpXlUpload();
        loadPayrollData();
        if (typeof loadSearchEmployeeList === 'function') loadSearchEmployeeList();
        if (failed.length) alert(`${failed.join(', ')} 님은 저장하지 못했어요. 다시 올려 주세요.`);
        else payToast(`${rows.length}명 사원정보를 저장했어요`);
    });
}

