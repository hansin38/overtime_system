// ==========================================
// 💵 급여 관리 (관리자 전용) - 사원등록 · 월 급여 입력 · 임금명세서/경비명세서 · 메일 발송 · 대장 엑셀
// - 기본정보(employees): 이름·전화 뒷4자리·사원번호·부서·직급·입사/퇴사일·고정OT → 직원 로그인·연장근로·연차와 공유
// - 🔒 급여정보(payroll_profiles): 생년월일·이메일·계좌·연봉·직책수당·식대·명절상여 → 관리자 로그인 시에만 읽기/쓰기
// - 월별 급여(payroll_records, 문서ID "YYYY-MM_사원ID"): 저장 시점 금액을 그대로 보관 (명세서는 이 값으로 출력)
// - 초과근무수당은 경비로 별도 지급 → 임금명세서에는 넣지 않고 경비명세서(관리자 보관, 발송은 선택)에만 표시
// ==========================================

const STD_MONTH_HOURS = 209;
const MEAL_TAX_FREE_LIMIT = 200000;            // 식대 비과세 한도 (월)
const MIN_WAGE = { 2026: 10320 };              // 최저임금 (매년 추가)
// 명절상여 지급 월 (설·추석이 있는 달) - 매년 다음 해 추가
const HOLIDAY_BONUS_MONTHS = { 2026: [2, 9], 2027: [2, 9] };
const DEFAULT_COMPANY = { companyName: "(주)한신콘설탄트", ceoName: "", contactName: "", contactPhone: "", contactEmail: "", payDay: 10 };
const PAY_LOGO = "/images/hanshin-logo.png";

const PAY_ITEMS = [
    { key: 'base', label: '기본급' },
    { key: 'meal', label: '식대', note: '비과세' },
    { key: 'position', label: '직책수당' },
    { key: 'overtime', label: '연장근로수당' },
    { key: 'holiday', label: '휴일근로수당' },
    { key: 'night', label: '야간근로수당' },
    { key: 'bonus', label: '명절상여' }
];
const DEDUCT_ITEMS = [
    { key: 'pension', label: '국민연금' },
    { key: 'health', label: '건강보험' },
    { key: 'care', label: '장기요양' },
    { key: 'employment', label: '고용보험' },
    { key: 'incomeTax', label: '소득세' },
    { key: 'localTax', label: '지방소득세' }
];
const OT_LABELS = { overtime: '연장', holiday: '휴일', night: '야간' };

const P = {
    loaded: false,
    month: '',            // 'YYYY-MM'
    employees: [],        // [{ id, ...employees 문서 }]
    profiles: {},         // { 사원ID: payroll_profiles 문서 }
    records: {},          // 선택 월 { 사원ID: 기록 }
    yearRecords: [],      // 선택 연도 전체 기록
    otRequests: [],       // 승인된 연장근로 신청
    leaveRequests: [],
    settings: { ...DEFAULT_COMPANY },
    selectedId: null,
    subTab: 1,
    payEditable: false,
    dirty: false,
    editingEmpId: null
};

// ------------------------------------------
// 공통 도우미 (pad2는 leave-common.js 공용)
// ------------------------------------------
function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function num(v) {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
}
function won(n) { return Math.round(Number(n) || 0).toLocaleString(); }
function won2(n) { return (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } // 통상시급 표시용
function round10(n) { return Math.round(n / 10) * 10; }
function ceilHalf(n) { return Math.ceil(Math.round(n * 1000) / 1000 / 0.5) * 0.5; } // 엑셀 CEILING(x, 0.5)
function fmtH(h) { return (Math.round((h || 0) * 10) / 10).toFixed(1) + 'h'; }
function ymdOfDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function monthDays(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return `${y}년 ${m}월분`; }
function shiftMonth(ym, diff) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + diff, 1);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function recordId(ym, empId) { return `${ym}_${empId}`; }
function emp(id) { return P.employees.find(e => e.id === id); }
function prof(id) { return P.profiles[id] || {}; }
function maskAccount(text) {
    const s = String(text || '').trim();
    if (!s) return '';
    const bank = (s.match(/^[^\d\s-]+/) || [''])[0];
    const digits = s.replace(/\D/g, '');
    if (!digits) return s;
    return `${bank ? bank + ' ' : ''}****-**-**${digits.slice(-4)}`;
}
function birth6(birthDate) {
    const d = String(birthDate || '').replace(/\D/g, '');
    return d.length === 8 ? d.slice(2) : (d.length === 6 ? d : '');
}
function msToDate(ms) { return ms ? ymdOfDate(new Date(ms)) : ''; }
function msToDateTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ------------------------------------------
// 계산 (엑셀 '급여산출계산' 고정OT 계약 표와 같은 식)
// 통상시급 = (월급 + 명절상여 월할) ÷ (209 + 연장×1.5 + 휴일×1.5 + 야간×0.5)  ※ 가산시간은 0.5 단위 올림
// 연장·휴일·야간 수당 = 통상시급 × 가산시간 (십원 반올림) / 기본급 = 월급 − 식대 − 직책수당 − 고정OT 수당
// 초과수당(경비) 시급 = 연봉 ÷ 12 ÷ 209
// ------------------------------------------
function calcPayStructure(profile, employee) {
    const annual = num(profile.annualSalary);
    if (!(annual > 0)) return null;
    const fixed = getFixOtLimits(employee);
    const weighted = {
        overtime: ceilHalf(fixed.overtime * 1.5),
        holiday: ceilHalf(fixed.holiday * 1.5),
        night: ceilHalf(fixed.night * 0.5)
    };
    const monthlyRaw = annual / 12;
    const bonusMonthly = num(profile.holidayBonus) * 2 / 12;
    const totalHours = STD_MONTH_HOURS + weighted.overtime + weighted.holiday + weighted.night;
    const ordinaryWage = (monthlyRaw + bonusMonthly) / totalHours;
    const monthly = round10(monthlyRaw);
    const pay = {
        meal: num(profile.mealAllowance),
        position: num(profile.positionAllowance),
        overtime: round10(ordinaryWage * weighted.overtime),
        holiday: round10(ordinaryWage * weighted.holiday),
        night: round10(ordinaryWage * weighted.night)
    };
    pay.base = monthly - pay.meal - pay.position - pay.overtime - pay.holiday - pay.night;
    return { annual, monthly, bonusMonthly, ordinaryWage, expenseWage: monthlyRaw / STD_MONTH_HOURS, fixed, weighted, totalHours, pay };
}

// 이번 달 재직 기간 (입사·퇴사일 당일 포함, 달력일 기준 일할)
function employmentRange(employee, ym) {
    const first = `${ym}-01`, last = `${ym}-${pad2(monthDays(ym))}`;
    const start = employee.hireDate && employee.hireDate > first ? employee.hireDate : first;
    const end = employee.resignDate && employee.resignDate < last ? employee.resignDate : last;
    if (start > end) return null;
    const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
    return { start, end, days, monthDays: monthDays(ym), partial: days < monthDays(ym) };
}
function isEmployedIn(employee, ym) {
    return !!employmentRange(employee, ym);
}

// 소정근로일수 = 재직 기간의 평일 (공휴일 제외)
function countWorkDays(range) {
    if (!range) return 0;
    let count = 0;
    for (let d = new Date(range.start); ymdOfDate(d) <= range.end; d.setDate(d.getDate() + 1)) {
        const ymd = ymdOfDate(d), w = d.getDay();
        if (w !== 0 && w !== 6 && !holidays.includes(ymd)) count++;
    }
    return count;
}

// 기본 지급액 (연봉 기준 + 일할 + 명절상여)
function defaultPay(empId, ym) {
    const employee = emp(empId), profile = prof(empId);
    const structure = calcPayStructure(profile, employee);
    const range = employmentRange(employee, ym);
    const pay = { base: 0, meal: 0, position: 0, overtime: 0, holiday: 0, night: 0, bonus: 0 };
    if (structure) {
        Object.assign(pay, structure.pay);
        if (range && range.partial) {
            const f = range.days / range.monthDays;
            const total = round10(structure.monthly * f);
            ['meal', 'position', 'overtime', 'holiday', 'night'].forEach(k => { pay[k] = round10(pay[k] * f); });
            pay.base = total - pay.meal - pay.position - pay.overtime - pay.holiday - pay.night;
        }
        const [y, m] = ym.split('-').map(Number);
        if ((HOLIDAY_BONUS_MONTHS[y] || []).includes(m)) pay.bonus = num(profile.holidayBonus);
    }
    return { pay, structure, range };
}

// 연장근로 신청의 귀속 월 = 마지막 근무일이 속한 달 (지난달 예외 줄은 이번 달 신청에 포함)
function requestMonth(req) {
    const dates = (req.detailLogs || []).map(l => l.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1].slice(0, 7) : '';
}

// 이번 달 실근로시간·초과수당(경비) - 승인된 연장근로 신청 기준
function calcMonthOvertime(empId, ym) {
    const employee = emp(empId);
    const structure = calcPayStructure(prof(empId), employee);
    const wage = structure ? structure.expenseWage : expenseHourlyWage(prof(empId));
    const limits = getFixOtLimits(employee);
    const logs = P.otRequests
        .filter(r => r.employeeName === employee.name && r.employeePhone === employee.phoneLast4 && requestMonth(r) === ym)
        .flatMap(r => r.detailLogs || []);
    const result = calculateOvertimePay(logs, wage, limits);
    return {
        wage,
        limits,
        actual: result.used,
        over: result.over,
        lines: result.lines,
        pay: result.overtimePay
    };
}

function sumValues(obj) { return Object.values(obj || {}).reduce((s, v) => s + (Number(v) || 0), 0); }

function computeTotals(rec) {
    const payTotal = sumValues(rec.pay);
    const etcTotal = (rec.etc || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const deductTotal = sumValues(rec.deduct) + etcTotal;
    const nonTaxable = Math.min(Number(rec.pay.meal) || 0, MEAL_TAX_FREE_LIMIT);
    return { pay: payTotal, deduct: deductTotal, net: payTotal - deductTotal, nonTaxable, taxable: payTotal - nonTaxable };
}

function recordStatus(rec) {
    if (!rec) return 'wait';
    if (!rec.wageSentAt) return 'save';
    return rec.updatedAt > rec.wageSentAt ? 'revised' : 'sent';
}
const STATUS_TEXT = { wait: '미입력', save: '저장됨', sent: '발송완료', revised: '수정됨 (재발송 필요)' };

// ------------------------------------------
// 탭 열기 · 데이터 로드
// ------------------------------------------
function openPayrollTab() {
    if (!P.loaded) {
        initPayMonthSelect();
        P.loaded = true;
    }
    loadPayrollData();
}

function initPayMonthSelect() {
    const sel = document.getElementById('pay-month');
    const thisMonth = ymdOfDate(new Date()).slice(0, 7);
    const options = [];
    for (let i = 1; i >= -24; i--) options.push(shiftMonth(thisMonth, i));
    sel.innerHTML = options.map(ym => `<option value="${ym}">${monthLabel(ym)}</option>`).join('');
    sel.value = shiftMonth(thisMonth, -1); // 급여는 보통 지난달분을 이번 달에 지급
    P.month = sel.value;
}

function changePayMonth() {
    if (P.dirty && !confirm("저장하지 않은 입력 내용이 있습니다. 달을 바꿀까요?")) {
        document.getElementById('pay-month').value = P.month;
        return;
    }
    P.month = document.getElementById('pay-month').value;
    loadPayrollData();
}

function loadPayrollData() {
    const ym = P.month;
    const year = Number(ym.slice(0, 4));
    document.getElementById('pay-main').innerHTML = `<div class="pay-empty">불러오는 중...</div>`;
    Promise.all([
        db.collection("employees").get(),
        db.collection("payroll_profiles").get(),
        db.collection("payroll_records").where("year", "==", year).get(),
        db.collection("overtime_requests").where("status", "==", "승인").get(),
        db.collection("leave_requests").get(),
        db.collection("payroll_settings").doc("company").get()
    ]).then(([empSnap, profSnap, recSnap, otSnap, leaveSnap, setDoc]) => {
        P.employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        P.profiles = {};
        profSnap.forEach(d => { P.profiles[d.id] = d.data(); });
        P.yearRecords = recSnap.docs.map(d => d.data());
        P.records = {};
        P.yearRecords.filter(r => r.month === ym).forEach(r => { P.records[r.employeeId] = r; });
        P.otRequests = otSnap.docs.map(d => d.data());
        P.leaveRequests = leaveSnap.docs.map(d => d.data());
        P.settings = { ...DEFAULT_COMPANY, ...(setDoc.exists ? setDoc.data() : {}) };

        const list = monthEmployees();
        if (!list.find(e => e.id === P.selectedId)) P.selectedId = list.length ? list[0].id : null;
        P.dirty = false;
        renderPayMonthBar();
        renderPayEmpList();
        renderPayMain();
    }).catch(err => {
        console.error("급여 데이터 로드 실패:", err);
        document.getElementById('pay-main').innerHTML = `<div class="pay-empty">급여 데이터를 불러오지 못했습니다.<br><small>관리자 로그인 상태와 Firestore 보안 규칙을 확인해 주세요.</small></div>`;
    });
}

// 선택한 달에 재직한 사원
function monthEmployees() {
    return P.employees.filter(e => isEmployedIn(e, P.month));
}

function defaultPayDate(ym) {
    const next = shiftMonth(ym, 1);
    const day = Math.min(Number(P.settings.payDay) || 10, monthDays(next));
    return `${next}-${pad2(day)}`;
}

// ------------------------------------------
// 상단: 이번 달 현황 · 직원 목록
// ------------------------------------------
function renderPayMonthBar() {
    const list = monthEmployees();
    const saved = list.filter(e => P.records[e.id]).length;
    const sent = list.filter(e => recordStatus(P.records[e.id]) === 'sent').length;
    const pending = list.filter(e => ['save', 'revised'].includes(recordStatus(P.records[e.id]))).length;
    document.getElementById('pay-stat-saved').innerText = `${saved}/${list.length}`;
    document.getElementById('pay-stat-sent').innerText = `${sent}/${list.length}`;
    document.getElementById('pay-stat-paydate').innerText = defaultPayDate(P.month).slice(5);
    const bulk = document.getElementById('pay-bulk-btn');
    bulk.innerText = `일괄 발송 (${pending}명)`;
    bulk.disabled = pending === 0;
}

function renderPayEmpList() {
    const q = (document.getElementById('pay-search').value || '').trim();
    const list = monthEmployees().filter(e => !q || (e.name || '').includes(q));
    const box = document.getElementById('pay-emp-list');
    if (P.employees.length === 0) {
        box.innerHTML = `<div class="pay-emp-none">등록된 사원이 없습니다</div>`;
        return;
    }
    box.innerHTML = list.map(e => {
        const st = recordStatus(P.records[e.id]);
        return `<div class="${e.id === P.selectedId ? 'sel' : ''}" onclick="selectPayEmployee('${e.id}')">
            <span class="pay-dot d-${st}"></span>${esc(e.name)}<small>${esc(e.empNo || '')}</small>
        </div>`;
    }).join('') || `<div class="pay-emp-none">검색 결과가 없습니다</div>`;

    // 이번 달 재직자가 아닌 사원(입사 전·퇴사 후)도 정보 수정은 할 수 있게 아래에 따로 표시
    const others = P.employees.filter(e => !isEmployedIn(e, P.month) && (!q || (e.name || '').includes(q)));
    document.getElementById('pay-emp-others').innerHTML = others.length
        ? `<div class="pay-others-title">이번 달 미재직</div>` + others.map(e =>
            `<div class="${e.id === P.selectedId ? 'sel' : ''}" onclick="selectPayEmployee('${e.id}')">${esc(e.name)}<small>${e.resignDate ? '퇴사' : '입사 전'}</small></div>`).join('')
        : '';
}

function selectPayEmployee(id) {
    if (id === P.selectedId) return;
    if (P.dirty && !confirm("저장하지 않은 입력 내용이 있습니다. 다른 사원으로 이동할까요?")) return;
    P.selectedId = id;
    P.dirty = false;
    P.payEditable = false;
    renderPayEmpList();
    renderPayMain();
}

// ------------------------------------------
// 오른쪽: 사원 상세 (이번 달 급여 / 연간 현황 / 사원 정보)
// ------------------------------------------
function renderPayMain() {
    const box = document.getElementById('pay-main');
    const e = emp(P.selectedId);
    if (!e) {
        box.innerHTML = `<div class="pay-empty">왼쪽에서 사원을 선택하거나 [＋ 사원등록]으로 사원을 추가해 주세요.</div>`;
        return;
    }
    const profile = prof(e.id);
    const st = recordStatus(P.records[e.id]);
    const fixed = getFixOtLimits(e);
    const employed = isEmployedIn(e, P.month);
    const chips = [
        profile.annualSalary ? `연봉 ${won(profile.annualSalary)}` : `<span class="warn">연봉 미등록</span>`,
        `고정OT 연장 ${fixed.overtime}h · 휴일 ${fixed.holiday}h · 야간 ${fixed.night}h`,
        e.hireDate ? `입사 ${e.hireDate}` : `<span class="warn">입사일 미등록</span>`,
        e.resignDate ? `퇴사 ${e.resignDate}` : ''
    ].filter(Boolean);

    if (!employed && P.subTab === 1) P.subTab = 3;
    box.innerHTML = `
        <div class="pay-emp-head">
            <span class="name">${esc(e.name)}</span>
            <span class="meta">${esc(e.department || '-')} · ${esc(e.position || '-')} · ${esc(e.empNo || '사원번호 없음')}</span>
            ${employed ? `<span class="pay-pill p-${st}">${P.month.slice(5).replace(/^0/, '')}월 ${STATUS_TEXT[st]}</span>` : `<span class="pay-pill p-wait">이번 달 미재직</span>`}
        </div>
        <div class="pay-chips">${chips.map(c => `<span class="pay-chip">${c}</span>`).join('')}</div>
        <div class="pay-subtabs">
            ${employed ? `<button class="${P.subTab === 1 ? 'on' : ''}" onclick="switchPaySub(1)">이번 달 급여</button>` : ''}
            <button class="${P.subTab === 2 ? 'on' : ''}" onclick="switchPaySub(2)">연간 현황</button>
            <button class="${P.subTab === 3 ? 'on' : ''}" onclick="switchPaySub(3)">사원 정보</button>
        </div>
        <div id="pay-pane"></div>`;
    if (P.subTab === 1) renderPayMonthPane();
    else if (P.subTab === 2) renderPayYearPane();
    else renderPayInfoPane();
}

function switchPaySub(n) {
    if (P.subTab === 1 && n !== 1 && P.dirty && !confirm("저장하지 않은 입력 내용이 있습니다. 이동할까요?")) return;
    if (n !== 1) P.dirty = false;
    P.subTab = n;
    renderPayMain();
}

// ---------- 이번 달 급여 ----------
function renderPayMonthPane() {
    const id = P.selectedId;
    const rec = P.records[id];
    const def = defaultPay(id, P.month);
    const pay = rec ? rec.pay : def.pay;
    const deduct = rec ? rec.deduct : {};
    const etc = rec ? (rec.etc || []) : [];
    const noSalary = !def.structure;
    const prorateNote = def.range && def.range.partial
        ? `<div class="pay-note blue">📅 일할계산 · ${def.range.start.slice(5)} ~ ${def.range.end.slice(5)} 재직 ${def.range.days}일 ÷ ${def.range.monthDays}일 (입사·퇴사일 포함)</div>` : '';

    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-grid">
            <div>
                ${noSalary ? `<div class="pay-note warn">연봉이 등록되지 않아 지급액을 자동 계산할 수 없습니다. [사원 정보] 탭에서 급여조건을 입력해 주세요.</div>` : ''}
                <div class="pay-card">
                    <h4>지급 <span class="tag">연봉에서 자동 계산</span>
                        <span class="link" onclick="togglePayEdit()">${P.payEditable ? '자동 계산값으로 되돌리기' : '금액 직접 수정'}</span></h4>
                    <div class="hint">${P.payEditable ? '그달만 다르게 지급할 금액을 고쳐 주세요' : '십원 단위 반올림 · 그달만 다르게 줄 때만 수정하세요'}</div>
                    ${prorateNote}
                    <div class="pay-lines" id="pay-pay-lines">
                        ${PAY_ITEMS.map(it => `
                            <span>${it.label}${it.note ? ` <small class="sub">${it.note}</small>` : ''}${it.key === 'bonus' ? ` <small class="sub">설·추석 달</small>` : ''}</span>
                            <input data-pay="${it.key}" value="${won(pay[it.key])}" ${P.payEditable ? '' : 'readonly'} oninput="onPayInput(this)">`).join('')}
                        <span class="total">지급액 계</span><span class="num total" id="pay-sum-pay"></span>
                    </div>
                </div>

                <div class="pay-card">
                    <h4>공제 <span class="link" onclick="loadPrevDeduct()">지난달 값 불러오기</span></h4>
                    <div class="hint">급여신고한 금액을 그대로 입력하세요</div>
                    <div class="pay-lines">
                        ${DEDUCT_ITEMS.map(it => `<span>${it.label}</span><input data-deduct="${it.key}" value="${deduct[it.key] ? won(deduct[it.key]) : ''}" placeholder="0" oninput="onPayInput(this)">`).join('')}
                        <span class="total">공제액 계</span><span class="num total" id="pay-sum-deduct"></span>
                    </div>
                </div>

                <div class="pay-card">
                    <h4>기타 공제 <small class="sub" style="font-weight: normal;">필요할 때만 (경조회비, 가불금 등)</small></h4>
                    <div id="pay-etc-rows">${etc.map(e => etcRowHtml(e.name, e.amount)).join('')}</div>
                    <button class="pay-btn sm" onclick="addEtcRow()" style="margin-top: 8px;">＋ 항목 추가</button>
                </div>
            </div>

            <div class="pay-summary">
                <div class="sum-net"><small>월급 실수령액</small><b id="pay-sum-net"></b>
                    <div class="row"><span id="pay-sum-pay2"></span><span id="pay-sum-deduct2"></span></div></div>
                <div class="sum-exp" id="pay-sum-exp"></div>
                <div class="pay-save-row"><button class="pay-btn dark" onclick="savePayRecord()">저장</button></div>
                <div class="pay-docs">
                    <div class="pay-doc">
                        <div class="t">📄 임금명세서<small id="pay-doc-wage-st"></small></div>
                        <div class="a"><button class="pay-btn sm" onclick="viewPayDoc('wage')">보기</button><button class="pay-btn sm blue" onclick="sendPayDoc('${id}', 'wage')">발송</button></div>
                    </div>
                    <div class="pay-doc">
                        <div class="t">📄 경비명세서<small id="pay-doc-exp-st"></small></div>
                        <div class="a"><button class="pay-btn sm" onclick="viewPayDoc('expense')">보기</button><button class="pay-btn sm org" onclick="sendPayDoc('${id}', 'expense')">발송</button></div>
                    </div>
                </div>
            </div>
        </div>`;
    refreshPaySummary();
}

function etcRowHtml(name = '', amount = '') {
    return `<div class="pay-etc-row">
        <input class="etc-name" placeholder="항목명" value="${esc(name)}" oninput="onPayInput(this)">
        <input class="etc-amount" placeholder="금액" value="${amount ? won(amount) : ''}" oninput="onPayInput(this)">
        <button class="pay-btn sm ghost" onclick="this.parentElement.remove(); onPayInput();">✕</button>
    </div>`;
}
function addEtcRow() {
    document.getElementById('pay-etc-rows').insertAdjacentHTML('beforeend', etcRowHtml());
}

// 숫자 입력칸은 입력하면서 천 단위 쉼표
function onPayInput(el) {
    if (el && (el.dataset.pay || el.dataset.deduct || el.classList.contains('etc-amount'))) {
        const raw = String(el.value).replace(/[^0-9-]/g, '');
        el.value = raw ? Number(raw).toLocaleString() : '';
    }
    P.dirty = true;
    refreshPaySummary();
}

function togglePayEdit() {
    if (P.payEditable) {
        // 자동 계산값으로 되돌리기
        const def = defaultPay(P.selectedId, P.month);
        document.querySelectorAll('#pay-pay-lines input[data-pay]').forEach(inp => { inp.value = won(def.pay[inp.dataset.pay]); });
        P.dirty = true;
    }
    P.payEditable = !P.payEditable;
    const values = readPayForm();
    renderPayMonthPane();
    // 다시 그린 화면에 방금 값 유지
    document.querySelectorAll('#pay-pay-lines input[data-pay]').forEach(inp => { inp.value = won(values.pay[inp.dataset.pay]); });
    document.querySelectorAll('input[data-deduct]').forEach(inp => { const v = values.deduct[inp.dataset.deduct]; inp.value = v ? won(v) : ''; });
    document.getElementById('pay-etc-rows').innerHTML = values.etc.map(e => etcRowHtml(e.name, e.amount)).join('');
    refreshPaySummary();
}

function readPayForm() {
    const pay = {}, deduct = {};
    document.querySelectorAll('input[data-pay]').forEach(inp => { pay[inp.dataset.pay] = num(inp.value); });
    document.querySelectorAll('input[data-deduct]').forEach(inp => { deduct[inp.dataset.deduct] = num(inp.value); });
    const etc = Array.from(document.querySelectorAll('#pay-etc-rows .pay-etc-row'))
        .map(row => ({ name: row.querySelector('.etc-name').value.trim(), amount: num(row.querySelector('.etc-amount').value) }))
        .filter(e => e.name || e.amount);
    return { pay, deduct, etc };
}

function refreshPaySummary() {
    const form = readPayForm();
    const t = computeTotals(form);
    document.getElementById('pay-sum-pay').innerText = won(t.pay);
    document.getElementById('pay-sum-deduct').innerText = won(t.deduct);
    document.getElementById('pay-sum-net').innerText = `${won(t.net)}원`;
    document.getElementById('pay-sum-pay2').innerText = `지급 ${won(t.pay)}`;
    document.getElementById('pay-sum-deduct2').innerText = `공제 ${won(t.deduct)}`;

    const ot = calcMonthOvertime(P.selectedId, P.month);
    const line = ot.lines.map(l => `${OT_LABELS[l.bucket]} 초과 ${fmtH(l.hours)} × ${won(ot.wage)}원 × ${Math.round(l.rate * 100)}%`).join('<br>');
    const rec = P.records[P.selectedId];
    document.getElementById('pay-sum-exp').innerHTML = `
        <div class="h"><span>경비 · 초과근무수당</span><span class="pay-pill p-keep">${rec && rec.expenseSentAt ? '발송함' : '보관'}</span></div>
        <b>${won(ot.pay)}원</b>
        <div class="s">${line || '고정OT 범위 내 (지급 없음)'}</div>`;

    const st = recordStatus(rec);
    document.getElementById('pay-doc-wage-st').innerText = rec
        ? (st === 'save' ? '저장됨 · 미발송' : st === 'revised' ? '수정됨 · 재발송 필요' : `${msToDateTime(rec.wageSentAt)} 발송완료`)
        : '저장 전';
    document.getElementById('pay-doc-exp-st').innerText = rec && rec.expenseSentAt
        ? `${msToDateTime(rec.expenseSentAt)} 발송함` : '보관 · 미발송';
}

function loadPrevDeduct() {
    const prevId = recordId(shiftMonth(P.month, -1), P.selectedId);
    db.collection("payroll_records").doc(prevId).get().then(doc => {
        if (!doc.exists) { alert("지난달 저장된 급여가 없습니다."); return; }
        const d = doc.data().deduct || {};
        document.querySelectorAll('input[data-deduct]').forEach(inp => { const v = d[inp.dataset.deduct]; inp.value = v ? won(v) : ''; });
        onPayInput();
    });
}

// 현재 입력 화면(또는 저장된 기록)을 명세서용 기록으로 만들기
function buildRecord(empId, fromForm) {
    const e = emp(empId), profile = prof(empId);
    const def = defaultPay(empId, P.month);
    const saved = P.records[empId];
    const form = fromForm ? readPayForm() : { pay: saved.pay, deduct: saved.deduct, etc: saved.etc || [] };
    const ot = calcMonthOvertime(empId, P.month);
    const structure = def.structure;
    const rec = {
        ...(saved || {}),
        month: P.month,
        year: Number(P.month.slice(0, 4)),
        employeeId: empId,
        name: e.name,
        empNo: e.empNo || '',
        department: e.department || '',
        position: e.position || '',
        bankAccount: profile.bankAccount || '',
        payDate: (saved && saved.payDate) || defaultPayDate(P.month),
        pay: form.pay,
        deduct: form.deduct,
        etc: form.etc,
        prorate: def.range && def.range.partial ? { start: def.range.start, end: def.range.end, days: def.range.days, monthDays: def.range.monthDays } : null,
        workDays: countWorkDays(def.range),
        hours: { fixed: ot.limits, actual: ot.actual, over: ot.over },
        expense: { wage: ot.wage, lines: ot.lines, pay: ot.pay, annual: structure ? structure.annual : 0 },
        calc: structure ? { ordinaryWage: structure.ordinaryWage, weighted: structure.weighted, totalHours: structure.totalHours, monthly: structure.monthly } : null
    };
    // 저장된 기록을 볼 때는 저장 당시 근로시간·경비를 그대로 사용
    if (!fromForm && saved && saved.hours) { rec.hours = saved.hours; rec.expense = saved.expense; }
    rec.totals = computeTotals(rec);
    return rec;
}

function savePayRecord() {
    const id = P.selectedId;
    const rec = buildRecord(id, true);
    const now = Date.now();
    rec.updatedAt = now;
    if (!rec.savedAt) rec.savedAt = now;
    rec.payEdited = P.payEditable || !!(P.records[id] && P.records[id].payEdited);
    // 발송 이력이 없는 상태에서 다시 저장하면 그냥 덮어쓰기
    return db.collection("payroll_records").doc(recordId(P.month, id)).set(rec)
        .then(() => {
            P.records[id] = rec;
            const i = P.yearRecords.findIndex(r => r.month === rec.month && r.employeeId === id);
            if (i >= 0) P.yearRecords[i] = rec; else P.yearRecords.push(rec);
            P.dirty = false;
            renderPayMonthBar();
            renderPayEmpList();
            renderPayMain();
            return rec;
        })
        .catch(err => { console.error("급여 저장 실패:", err); alert("저장 중 오류가 발생했습니다."); throw err; });
}

// ---------- 연간 현황 ----------
function renderPayYearPane() {
    const id = P.selectedId;
    const year = Number(P.month.slice(0, 4));
    const recs = P.yearRecords.filter(r => r.employeeId === id);
    const byMonth = {};
    recs.forEach(r => { byMonth[Number(r.month.slice(5))] = r; });
    const sum = (f) => recs.reduce((s, r) => s + f(r), 0);
    const bonusM = HOLIDAY_BONUS_MONTHS[year] || [];
    const rows = Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
        const r = byMonth[m];
        const ym = `${year}-${pad2(m)}`;
        const tag = bonusM.includes(m) ? ` <small class="sub">${m <= 6 ? '설' : '추석'}</small>` : '';
        if (!r) return `<tr class="fut"><td>${m}월${tag}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>`;
        const st = recordStatus(r);
        return `<tr class="${ym === P.month ? 'cur' : ''}" onclick="jumpPayMonth('${ym}')">
            <td>${m}월${tag}</td><td>${won(r.totals.pay)}</td><td>${won(r.totals.deduct)}</td><td>${won(r.totals.net)}</td>
            <td class="e">${r.expense && r.expense.pay ? won(r.expense.pay) : '-'}</td>
            <td style="text-align: center;"><span class="pay-pill p-${st}">${STATUS_TEXT[st].split(' ')[0]}</span></td></tr>`;
    }).join('');
    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-kpis">
            <div class="pay-kpi"><small>${year}년 지급 누계</small><b>${won(sum(r => r.totals.pay))}</b></div>
            <div class="pay-kpi"><small>공제 누계</small><b>${won(sum(r => r.totals.deduct))}</b></div>
            <div class="pay-kpi"><small>실수령 누계</small><b>${won(sum(r => r.totals.net))}</b></div>
            <div class="pay-kpi e"><small>경비 누계</small><b>${won(sum(r => (r.expense && r.expense.pay) || 0))}</b></div>
        </div>
        <table class="pay-year">
            <tr><th>월</th><th>지급</th><th>공제</th><th>실수령</th><th>경비</th><th style="text-align: center;">임금명세서</th></tr>
            ${rows}
        </table>
        <div class="sub" style="margin-top: 10px;">행을 클릭하면 그 달 '이번 달 급여' 화면으로 이동합니다</div>`;
}

function jumpPayMonth(ym) {
    const sel = document.getElementById('pay-month');
    if (![...sel.options].some(o => o.value === ym)) return;
    sel.value = ym;
    P.month = ym;
    P.subTab = 1;
    loadPayrollData();
}

// ---------- 사원 정보 ----------
function renderPayInfoPane() {
    const e = emp(P.selectedId), p = prof(P.selectedId);
    const s = calcPayStructure(p, e);
    const fixed = getFixOtLimits(e);
    const dl = (rows) => `<dl class="pay-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v || '-'}</dd>`).join('')}</dl>`;
    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-info-grid">
            <div class="pay-card"><h4>인적사항</h4>${dl([
                ['이름', esc(e.name)], ['사원번호', esc(e.empNo)], ['전화 뒷4자리', esc(e.phoneLast4)],
                ['생년월일 🔒', esc(p.birthDate)], ['이메일 🔒', esc(p.email)], ['입금 계좌 🔒', esc(p.bankAccount)]
            ])}</div>
            <div>
                <div class="pay-card"><h4>근무조건</h4>${dl([
                    ['부서 / 직급', `${esc(e.department || '-')} / ${esc(e.position || '-')}`],
                    ['입사일', esc(e.hireDate)], ['퇴사일', esc(e.resignDate)],
                    ['고정OT (월)', `연장 ${fixed.overtime}h · 휴일 ${fixed.holiday}h · 야간 ${fixed.night}h`]
                ])}</div>
                <div class="pay-card lock"><h4>🔒 급여조건</h4>${dl([
                    ['연봉', p.annualSalary ? won(p.annualSalary) : ''],
                    ['직책수당', p.positionAllowance ? `${won(p.positionAllowance)} / 월` : '0'],
                    ['식대', p.mealAllowance ? `${won(p.mealAllowance)} / 월` : '0'],
                    ['명절상여', p.holidayBonus ? `설·추석 각 ${won(p.holidayBonus)}` : '0'],
                    ['통상시급', s ? `${won2(s.ordinaryWage)}원 <small class="sub">자동</small>` : ''],
                    ['경비 시급', s ? `${won(s.expenseWage)}원 <small class="sub">연봉÷12÷209</small>` : (p.legacyHourlyWage ? `${won(p.legacyHourlyWage)}원 <small class="sub">예전 통상시급</small>` : '')]
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
const EMP_FIELDS = ['name', 'phone', 'empNo', 'birth', 'email', 'bank', 'dept', 'position', 'hire', 'resign', 'fixOt', 'fixHol', 'fixNight', 'annual', 'posAllow', 'meal', 'bonus'];

function openPayEmpModal(empId = null) {
    P.editingEmpId = empId;
    const e = empId ? emp(empId) : {};
    const p = empId ? prof(empId) : {};
    const fixed = getFixOtLimits(e);
    const v = {
        name: e.name, phone: e.phoneLast4, empNo: e.empNo, birth: p.birthDate, email: p.email, bank: p.bankAccount,
        dept: e.department, position: e.position, hire: e.hireDate, resign: e.resignDate,
        fixOt: fixed.overtime, fixHol: fixed.holiday, fixNight: fixed.night,
        annual: p.annualSalary ? won(p.annualSalary) : '', posAllow: p.positionAllowance ? won(p.positionAllowance) : '',
        meal: p.mealAllowance !== undefined ? won(p.mealAllowance) : '200,000', bonus: p.holidayBonus !== undefined ? won(p.holidayBonus) : '200,000'
    };
    EMP_FIELDS.forEach(k => { document.getElementById('pe-' + k).value = v[k] ?? ''; });
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

function onEmpMoneyInput(el) {
    const raw = String(el.value).replace(/[^0-9]/g, '');
    el.value = raw ? Number(raw).toLocaleString() : '';
    updateEmpCalcPreview();
}

function readEmpForm() {
    const g = (k) => document.getElementById('pe-' + k).value.trim();
    return {
        name: g('name'), phone: g('phone').replace(/\D/g, ''), empNo: g('empNo'),
        birthDate: g('birth'), email: g('email'), bankAccount: g('bank'),
        department: g('dept'), position: g('position'), hireDate: g('hire'), resignDate: g('resign'),
        fixedOt: { overtime: parseFloat(g('fixOt')) || 0, holiday: parseFloat(g('fixHol')) || 0, night: parseFloat(g('fixNight')) || 0 },
        annualSalary: num(g('annual')), positionAllowance: num(g('posAllow')), mealAllowance: num(g('meal')), holidayBonus: num(g('bonus'))
    };
}

function updateEmpCalcPreview() {
    const f = readEmpForm();
    const s = calcPayStructure(f, { fixedOt: f.fixedOt });
    const box = document.getElementById('pe-preview');
    if (!s) { box.innerHTML = '연봉을 입력하면 월급 구성이 자동 계산됩니다.'; return; }
    const year = new Date().getFullYear();
    const minWage = MIN_WAGE[year] || MIN_WAGE[Math.max(...Object.keys(MIN_WAGE).map(Number))];
    const ok = s.ordinaryWage >= minWage;
    box.innerHTML = `월급 ${won(s.monthly)} → 기본급 ${won(s.pay.base)} · 연장 ${won(s.pay.overtime)} · 휴일 ${won(s.pay.holiday)} · 야간 ${won(s.pay.night)}<br>
        통상시급 ${won2(s.ordinaryWage)}원 · 경비 시급 ${won(s.expenseWage)}원
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
        annualSalary: f.annualSalary, positionAllowance: f.positionAllowance, mealAllowance: f.mealAllowance, holidayBonus: f.holidayBonus
    };
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
    if (!confirm(`${e.name} 사원을 삭제할까요?\n※ 직원 로그인이 막히고 급여정보가 삭제됩니다. 이미 저장된 월별 급여(임금대장)는 보관됩니다.\n퇴사자는 삭제 대신 퇴사일을 입력하는 것을 권장합니다.`)) return;
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
// 회사 정보 (명세서 하단 문의처·회사명·지급일)
// ------------------------------------------
const COMPANY_FIELDS = ['companyName', 'ceoName', 'contactName', 'contactPhone', 'contactEmail', 'payDay'];
function openPayCompanyModal() {
    COMPANY_FIELDS.forEach(k => { document.getElementById('pc-' + k).value = P.settings[k] ?? ''; });
    document.getElementById('pay-company-modal').style.display = 'flex';
}
function closePayCompanyModal() { document.getElementById('pay-company-modal').style.display = 'none'; }
function savePayCompany() {
    const data = {};
    COMPANY_FIELDS.forEach(k => { data[k] = document.getElementById('pc-' + k).value.trim(); });
    data.payDay = Math.min(31, Math.max(1, parseInt(data.payDay, 10) || 10));
    db.collection("payroll_settings").doc("company").set(data).then(() => {
        P.settings = { ...DEFAULT_COMPANY, ...data };
        closePayCompanyModal();
        renderPayMonthBar();
    }).catch(err => { console.error("회사 정보 저장 실패:", err); alert("저장 중 오류가 발생했습니다."); });
}

// ------------------------------------------
// 명세서 HTML (화면 보기 · 인쇄 · 메일 PDF 공용)
// ------------------------------------------
function leaveSummaryFor(e, year) {
    if (!e.hireDate) return null;
    const entitlement = calcAnnualLeaveEntitlement(e.hireDate, year);
    const used = P.leaveRequests
        .filter(d => d.employeeName === e.name && d.employeePhone === e.phoneLast4 && d.fiscalYear === year && d.status === "승인" && isDeductible(d))
        .reduce((s, d) => s + (d.totalDays || 0), 0);
    return { entitlement, used, remaining: entitlement - used };
}

// 올해 누계 (이 달까지, 이 달은 지금 기록으로)
function ytdFor(rec) {
    const recs = P.yearRecords.filter(r => r.employeeId === rec.employeeId && r.month < rec.month).concat([rec]);
    return recs.reduce((s, r) => ({
        pay: s.pay + r.totals.pay, deduct: s.deduct + r.totals.deduct, net: s.net + r.totals.net,
        expense: s.expense + ((r.expense && r.expense.pay) || 0)
    }), { pay: 0, deduct: 0, net: 0, expense: 0 });
}

function slipHeadHtml(rec, title, sub, stamp) {
    return `
        <img class="ps-logo" src="${PAY_LOGO}" alt="">
        ${stamp ? `<div class="ps-stamp">수정본<small>${stamp} 수정</small></div>` : ''}
        <h1 class="ps-title">${title}</h1>
        <div class="ps-sub">${sub}</div>
        <table class="ps-info">
            <tr><th>성명</th><td>${esc(rec.name)}</td><th>사원번호</th><td>${esc(rec.empNo || '-')}</td></tr>
            <tr><th>부서</th><td>${esc(rec.department || '-')}</td><th>직급</th><td>${esc(rec.position || '-')}</td></tr>
        </table>`;
}

function slipFootHtml(left) {
    const s = P.settings;
    return `<div class="ps-foot">
        <div>${left}</div>
        <div class="co">귀하의 노고에 감사드립니다.<br><b>${esc(s.companyName)}</b>${s.ceoName ? ` 대표이사 ${esc(s.ceoName)}` : ''}</div>
    </div>`;
}

function renderWageSlipHtml(rec, opts = {}) {
    const e = emp(rec.employeeId) || {};
    const year = rec.year;
    const payRows = PAY_ITEMS.filter(it => it.key !== 'bonus' || rec.pay.bonus)
        .map(it => [it.label + (it.note ? ` (${it.note})` : ''), rec.pay[it.key]]);
    const dedRows = DEDUCT_ITEMS.map(it => [it.label, rec.deduct[it.key] || 0])
        .concat((rec.etc || []).map(x => [x.name || '기타', x.amount]));
    const n = Math.max(payRows.length, dedRows.length);
    const rows = Array.from({ length: n }, (_, i) => {
        const p = payRows[i], d = dedRows[i];
        return `<tr><td>${p ? esc(p[0]) : ''}</td><td class="num">${p ? won(p[1]) : ''}</td><td>${d ? esc(d[0]) : ''}</td><td class="num">${d ? won(d[1]) : ''}</td></tr>`;
    }).join('');
    const h = rec.hours || { fixed: FIX_OT_LIMITS, actual: {} };
    const ytd = ytdFor(rec);
    const leave = leaveSummaryFor(e, year);
    const c = rec.calc;
    const s = P.settings;
    const contact = [s.contactName && `${esc(s.contactName)}`, s.contactPhone && `☎ ${esc(s.contactPhone)}`, s.contactEmail && `✉ ${esc(s.contactEmail)}`].filter(Boolean);

    return `<div class="ps-paper">
        ${slipHeadHtml(rec, '임금명세서', `${monthLabel(rec.month)} · 지급일 ${rec.payDate} · 발급일 ${opts.issueDate || ymdOfDate(new Date())}`, opts.stamp)}

        <div class="ps-box pay">
            <div class="bt">① 급여 산출 내역</div>
            <div class="in">
                <table class="ps-tbl">
                    <tr><th colspan="2">지급</th><th colspan="2">공제</th></tr>
                    ${rows}
                    <tr class="tot"><th>지급액 계</th><th class="num">${won(rec.totals.pay)}</th><th>공제액 계</th><th class="num">${won(rec.totals.deduct)}</th></tr>
                </table>
                <div class="ps-taxline"><span>과세 ${won(rec.totals.taxable)}</span><span>비과세 ${won(rec.totals.nonTaxable)} (식대)</span></div>
                ${rec.prorate ? `<div class="ps-prorate">📅 <b>일할계산</b> · ${rec.prorate.start.slice(5)} ~ ${rec.prorate.end.slice(5)} 재직 ${rec.prorate.days}일 ÷ ${rec.prorate.monthDays}일 (입사·퇴사일 포함, 십원 반올림)</div>` : ''}
            </div>
        </div>

        <div class="ps-box hrs">
            <div class="bt">② 이번 달 근로시간</div>
            <div class="in">
                <table class="ps-tbl">
                    <tr><th>구분</th><th>고정 (계약)</th><th>실근로</th></tr>
                    ${['overtime', 'holiday', 'night'].map(k => `<tr><td>${OT_LABELS[k]}</td><td>${fmtH(h.fixed[k])}</td><td>${fmtH(h.actual[k])}</td></tr>`).join('')}
                </table>
                <div class="ps-small">소정근로일수 ${rec.workDays}일 · 소정근로 월 ${STD_MONTH_HOURS}h · 실근로는 연장근로 결재 '승인' 기록 기준</div>
            </div>
        </div>

        <div class="ps-big blue"><small>이번 달 실수령액</small><b>${won(rec.totals.net)}<span>원</span></b></div>
        ${rec.bankAccount ? `<div class="ps-acct">입금 계좌: ${esc(maskAccount(rec.bankAccount))} (${esc(rec.name)})</div>` : '<div class="ps-acct"></div>'}

        <div class="ps-info2">
            <div class="ps-mini">
                <div class="h">${year}년 누계 (1~${Number(rec.month.slice(5))}월)</div>
                <div class="g"><span>지급액</span><span>${won(ytd.pay)}</span><span>공제액</span><span>${won(ytd.deduct)}</span><span>실수령액</span><span>${won(ytd.net)}</span></div>
            </div>
            <div class="ps-mini leave">
                <div class="h">${year}년 연차 현황</div>
                ${leave ? `<div class="bar"><div style="width: ${leave.entitlement ? Math.min(100, Math.round(leave.used / leave.entitlement * 100)) : 0}%"></div></div>
                <div class="nums"><span>발생 <b>${formatDays(leave.entitlement)}</b></span><span>사용 <b>${formatDays(leave.used)}</b></span><span>잔여 <b class="ok">${formatDays(leave.remaining)}</b></span></div>
                <div class="ps-small">${ymdOfDate(new Date())} 기준</div>` : `<div class="ps-small">입사일 미등록</div>`}
            </div>
        </div>

        ${slipFootHtml(contact.length ? `<b>문의</b> ${contact.join(' · ')}` : '')}

        <div class="ps-legal">
            <div class="lh">법정 기재사항 (근로기준법 제48조 · 고정OT 산정 기준)</div>
            <table>
                <tr><th>소정근로</th><th>고정 연장</th><th>고정 휴일</th><th>고정 야간</th><th>통상시급</th></tr>
                <tr><td>${STD_MONTH_HOURS}h</td><td>${h.fixed.overtime}h</td><td>${h.fixed.holiday}h</td><td>${h.fixed.night}h</td><td>${c ? won2(c.ordinaryWage) + '원' : '-'}</td></tr>
            </table>
            연장 = 통상시급 × ${h.fixed.overtime}h × 1.5 · 휴일 = 통상시급 × ${h.fixed.holiday}h × 1.5 · 야간 = 통상시급 × ${h.fixed.night}h × 0.5 (십원 단위 반올림)<br>
            본 명세서는 근로기준법 제48조 제2항에 따라 교부합니다.
        </div>
    </div>`;
}

function renderExpenseSlipHtml(rec) {
    const h = rec.hours || { fixed: FIX_OT_LIMITS, actual: {}, over: {} };
    const x = rec.expense || { lines: [], pay: 0, wage: 0 };
    const ytd = ytdFor(rec);
    const rateText = { overtime: '150%', holiday: '150% / 200%', night: '50%' };
    const calcRows = x.lines.map(l => `
        <div class="row"><span class="k">${OT_LABELS[l.bucket]} 초과</span>
            <span class="f">${fmtH(l.hours)} × ${won(x.wage)}원 × ${Math.round(l.rate * 100)}%</span><span class="v">${won(l.pay)}원</span></div>`).join('');
    const s = P.settings;
    return `<div class="ps-paper exp">
        ${slipHeadHtml(rec, '초과근무수당 지급명세서', `${monthLabel(rec.month)} · 지급일 ${rec.payDate} · 경비 지급`)}

        <div class="ps-box exp">
            <div class="bt">① 근로시간 (고정OT 대비)</div>
            <div class="in">
                <table class="ps-tbl">
                    <tr><th>구분</th><th>고정 (계약)</th><th>실근로</th><th>초과</th><th>가산율</th></tr>
                    ${['overtime', 'holiday', 'night'].map(k => `<tr><td>${OT_LABELS[k]}</td><td>${fmtH(h.fixed[k])}</td><td>${fmtH(h.actual[k])}</td>
                        <td class="${(h.over || {})[k] > 0 ? 'over' : ''}">${(h.over || {})[k] > 0 ? fmtH(h.over[k]) : '-'}</td><td>${rateText[k]}</td></tr>`).join('')}
                </table>
            </div>
        </div>

        <div class="ps-box exp">
            <div class="bt">② 산출 내역</div>
            <div class="in">
                <div class="ps-calc">
                    <div class="row"><span class="k">적용 시급</span><span class="f">${x.annual ? `연봉 ${won(x.annual)} ÷ 12개월 ÷ ${STD_MONTH_HOURS}h` : '등록된 시급'}</span><span class="v">${won(x.wage)}원</span></div>
                    ${calcRows || `<div class="row"><span class="k">초과 시간</span><span class="f">고정OT 범위 내</span><span class="v">0h</span></div>`}
                    <div class="row final"><span class="k">지급액</span><span class="f">합계 (백원 단위 올림)</span><span class="v">${won(x.pay)}원</span></div>
                </div>
                <div class="ps-tip">
                    · 근로계약서의 고정 시간을 넘긴 근무에 대해 지급합니다.<br>
                    · 시급은 연봉 기준(연봉÷12÷209)으로 적용하며, 금액은 백원 단위 올림입니다.<br>
                    · 연장근로 결재 '승인' 건 기준이며, 급여와 별도로 경비로 지급됩니다.
                </div>
            </div>
        </div>

        <div class="ps-big org"><small>초과근무수당 지급액</small><b>${won(x.pay)}<span>원</span></b></div>
        <div class="ps-acct">${rec.year}년 누계 (1~${Number(rec.month.slice(5))}월): <b>${won(ytd.expense)}원</b></div>

        ${slipFootHtml(s.contactName ? `<b>작성</b> ${esc(s.contactName)}` : '')}
    </div>`;
}

// 수정본 도장: 이미 보낸 명세서를 고친 경우(재발송 전) 또는 수정본으로 재발송한 경우
function wageStampFor(rec) {
    if (rec.wageSentAt && rec.updatedAt > rec.wageSentAt) return msToDate(rec.updatedAt);
    if (rec.wageRevisedAt) return msToDate(rec.wageRevisedAt);
    return '';
}

function slipHtmlFor(rec, kind) {
    return kind === 'wage' ? renderWageSlipHtml(rec, { stamp: wageStampFor(rec) }) : renderExpenseSlipHtml(rec);
}

// 보기: 저장 전이면 지금 입력값으로 미리보기
let payDocCurrent = null;
function viewPayDoc(kind) {
    const rec = P.dirty || !P.records[P.selectedId] ? buildRecord(P.selectedId, true) : buildRecord(P.selectedId, false);
    payDocCurrent = { rec, kind };
    document.getElementById('pay-doc-title').innerText = kind === 'wage' ? '임금명세서' : '경비명세서 (관리자 보관용)';
    document.getElementById('pay-doc-body').innerHTML = (P.dirty || !P.records[P.selectedId]
        ? `<div class="pay-note warn" style="margin-bottom: 12px;">저장 전 미리보기입니다. 발송하려면 먼저 저장해 주세요.</div>` : '') + slipHtmlFor(rec, kind);
    document.getElementById('pay-doc-modal').style.display = 'flex';
}
function closePayDoc() { document.getElementById('pay-doc-modal').style.display = 'none'; }

function printPayDoc() {
    if (!payDocCurrent) return;
    const body = document.getElementById('pay-print-body');
    body.innerHTML = slipHtmlFor(payDocCurrent.rec, payDocCurrent.kind);
    const images = Array.from(body.querySelectorAll('img'));
    Promise.all(images.map(img => img.complete ? Promise.resolve()
        : new Promise(resolve => { img.onload = img.onerror = resolve; })))
        .then(() => window.print());
}

// ------------------------------------------
// 메일 발송 (Vercel 서버 /api/send-payslip → 생년월일 6자리 암호 PDF를 관리자 Gmail로 발송)
// ------------------------------------------
function captureSlipImage(html) {
    const box = document.getElementById('pay-capture');
    box.innerHTML = html;
    const images = Array.from(box.querySelectorAll('img'));
    return Promise.all(images.map(img => img.complete ? Promise.resolve()
        : new Promise(resolve => { img.onload = img.onerror = resolve; })))
        .then(() => html2canvas(box.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true }))
        .then(canvas => { box.innerHTML = ''; return canvas.toDataURL('image/jpeg', 0.92); });
}

function logPaySend(rec, kind, ok, error, revised) {
    return db.collection("payroll_send_logs").add({
        at: Date.now(), month: rec.month, employeeId: rec.employeeId, name: rec.name,
        kind, revised: !!revised, ok, error: error || ''
    }).catch(err => console.error("발송 이력 저장 실패:", err));
}

// 1명 · 1종 발송 (confirmEach=false면 일괄 발송에서 확인창 생략)
function sendPayDocCore(empId, kind) {
    const rec = buildRecord(empId, false);
    const p = prof(empId);
    const to = (p.email || '').trim();
    const pw = birth6(p.birthDate);
    if (!to) return Promise.reject(new Error('이메일 미등록'));
    if (!pw) return Promise.reject(new Error('생년월일 미등록'));

    const revised = kind === 'wage' && rec.wageSentAt && rec.updatedAt > rec.wageSentAt;
    const html = slipHtmlFor(rec, kind);
    const [y, m] = rec.month.split('-');
    const docName = kind === 'wage' ? '임금명세서' : '초과근무수당지급명세서';
    const subject = `[${P.settings.companyName}] ${y}년 ${Number(m)}월분 ${kind === 'wage' ? '임금명세서' : '초과근무수당 지급명세서'}${revised ? ' (수정본)' : ''}`;
    const text = `${rec.name}님, ${y}년 ${Number(m)}월분 ${kind === 'wage' ? '임금명세서' : '초과근무수당 지급명세서'}${revised ? '(수정본)' : ''}를 보내드립니다.\n\n첨부된 PDF는 생년월일 6자리(예: 900101)로 열 수 있습니다.\n\n${P.settings.companyName}`;

    return captureSlipImage(html)
        .then(image => auth.currentUser.getIdToken().then(token => fetch('/api/send-payslip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ to, subject, text, filename: `${rec.month}_${docName}_${rec.name}.pdf`, password: pw, image })
        })))
        .then(res => res.json().catch(() => ({})).then(body => {
            if (!res.ok || !body.ok) throw new Error(body.error || `서버 오류 (${res.status})`);
        }))
        .then(() => {
            const now = Date.now();
            const update = kind === 'wage'
                ? { wageSentAt: now, ...(revised ? { wageRevisedAt: rec.updatedAt } : {}) }
                : { expenseSentAt: now };
            return db.collection("payroll_records").doc(recordId(rec.month, empId)).update(update).then(() => {
                Object.assign(P.records[empId], update);
                logPaySend(rec, kind, true, '', revised);
            });
        })
        .catch(err => {
            logPaySend(rec, kind, false, err.message, revised);
            throw err;
        });
}

function sendPayDoc(empId, kind) {
    const go = () => {
        const p = prof(empId), e = emp(empId);
        const label = kind === 'wage' ? '임금명세서' : '경비명세서(초과근무수당)';
        const rec = P.records[empId];
        const resend = kind === 'wage' ? rec.wageSentAt : rec.expenseSentAt;
        const msg = `${e.name}님에게 ${label}를 메일로 보낼까요?\n\n받는 사람: ${p.email || '(이메일 미등록)'}\n첨부: 생년월일 6자리로 잠긴 PDF`
            + (kind === 'expense' ? '\n\n※ 경비명세서는 기본적으로 보관용입니다.' : '')
            + (resend ? `\n※ 이미 ${msToDateTime(resend)}에 보낸 적이 있습니다.` : '');
        if (!confirm(msg)) return;
        setPayBusy(true, `${e.name} ${label} 발송 중...`);
        sendPayDocCore(empId, kind)
            .then(() => { alert("발송했습니다."); })
            .catch(err => { console.error("발송 실패:", err); alert(`발송하지 못했습니다.\n사유: ${err.message}`); })
            .finally(() => { setPayBusy(false); renderPayMonthBar(); renderPayEmpList(); renderPayMain(); });
    };
    if (P.dirty || !P.records[empId]) {
        if (!confirm("저장되지 않은 내용이 있습니다. 저장한 뒤 발송할까요?")) return;
        savePayRecord().then(go);
        return;
    }
    go();
}

function bulkSendWage() {
    const targets = monthEmployees().filter(e => ['save', 'revised'].includes(recordStatus(P.records[e.id])));
    if (targets.length === 0) { alert("발송할 임금명세서가 없습니다. (저장됨·수정됨 상태만 발송)"); return; }
    const missing = targets.filter(e => !prof(e.id).email || !birth6(prof(e.id).birthDate));
    const ready = targets.filter(e => !missing.includes(e));
    let msg = `${monthLabel(P.month)} 임금명세서를 ${ready.length}명에게 발송할까요?\n\n${ready.map(e => `· ${e.name} (${prof(e.id).email})`).join('\n')}`;
    if (missing.length) msg += `\n\n제외 (이메일·생년월일 미등록): ${missing.map(e => e.name).join(', ')}`;
    msg += `\n\n※ 경비명세서는 일괄 발송에 포함되지 않습니다.`;
    if (ready.length === 0) { alert(msg); return; }
    if (!confirm(msg)) return;

    const results = [];
    setPayBusy(true, '일괄 발송 중...');
    ready.reduce((chain, e, i) => chain.then(() => {
        setPayBusy(true, `일괄 발송 중... (${i + 1}/${ready.length}) ${e.name}`);
        return sendPayDocCore(e.id, 'wage')
            .then(() => results.push(`✅ ${e.name}`))
            .catch(err => results.push(`❌ ${e.name} - ${err.message}`));
    }), Promise.resolve())
        .then(() => alert(`일괄 발송 결과\n\n${results.join('\n')}`))
        .finally(() => { setPayBusy(false); renderPayMonthBar(); renderPayEmpList(); renderPayMain(); });
}

function setPayBusy(on, text = '') {
    const el = document.getElementById('pay-busy');
    el.style.display = on ? 'flex' : 'none';
    el.querySelector('span').innerText = text;
}

function openPaySendLog() {
    const tbody = document.getElementById('pay-log-tbody');
    tbody.innerHTML = `<tr><td colspan="5">불러오는 중...</td></tr>`;
    document.getElementById('pay-log-modal').style.display = 'flex';
    db.collection("payroll_send_logs").orderBy("at", "desc").limit(200).get().then(snap => {
        if (snap.empty) { tbody.innerHTML = `<tr><td colspan="5" class="sub">발송 이력이 없습니다.</td></tr>`; return; }
        tbody.innerHTML = snap.docs.map(d => {
            const l = d.data();
            const doc = l.kind === 'wage' ? '임금명세서' : '경비명세서';
            return `<tr><td>${msToDateTime(l.at)}</td><td>${esc(l.name)}</td><td>${monthLabel(l.month)}</td>
                <td>${doc}${l.revised ? ' <span class="pay-pill p-revised">수정본</span>' : ''}</td>
                <td>${l.ok ? '✅ 성공' : `<span style="color: var(--danger-color);">❌ ${esc(l.error)}</span>`}</td></tr>`;
        }).join('');
    }).catch(err => { console.error("발송 이력 로드 실패:", err); tbody.innerHTML = `<tr><td colspan="5">불러오지 못했습니다.</td></tr>`; });
}
function closePaySendLog() { document.getElementById('pay-log-modal').style.display = 'none'; }

// ------------------------------------------
// 임금대장 · 경비대장 엑셀 (근로기준법상 임금대장 3년 보관용)
// ------------------------------------------
function downloadLedger(kind) {
    const scope = document.getElementById('pay-ledger-scope').value;
    const recs = (scope === 'year' ? P.yearRecords : P.yearRecords.filter(r => r.month === P.month))
        .slice().sort((a, b) => a.month.localeCompare(b.month) || (a.name || '').localeCompare(b.name || '', 'ko'));
    if (recs.length === 0) { alert("저장된 급여가 없습니다."); return; }

    let rows;
    if (kind === 'wage') {
        rows = recs.map(r => {
            const row = { '귀속월': r.month, '지급일': r.payDate, '사원번호': r.empNo, '성명': r.name, '부서': r.department, '직급': r.position, '소정근로일수': r.workDays };
            PAY_ITEMS.forEach(it => { row[it.label] = r.pay[it.key] || 0; });
            row['지급액 계'] = r.totals.pay;
            row['과세'] = r.totals.taxable;
            row['비과세'] = r.totals.nonTaxable;
            DEDUCT_ITEMS.forEach(it => { row[it.label] = r.deduct[it.key] || 0; });
            row['기타공제'] = (r.etc || []).reduce((s, e) => s + (e.amount || 0), 0);
            row['기타공제 내역'] = (r.etc || []).map(e => `${e.name} ${won(e.amount)}`).join(', ');
            row['공제액 계'] = r.totals.deduct;
            row['실수령액'] = r.totals.net;
            ['overtime', 'holiday', 'night'].forEach(k => { row[`${OT_LABELS[k]} 실근로(h)`] = Math.round(((r.hours && r.hours.actual[k]) || 0) * 10) / 10; });
            row['일할'] = r.prorate ? `${r.prorate.days}/${r.prorate.monthDays}` : '';
            row['발송일시'] = r.wageSentAt ? new Date(r.wageSentAt).toLocaleString() : '';
            return row;
        });
    } else {
        rows = recs.map(r => {
            const h = r.hours || { fixed: {}, actual: {}, over: {} };
            const x = r.expense || { wage: 0, pay: 0 };
            const row = { '귀속월': r.month, '지급일': r.payDate, '사원번호': r.empNo, '성명': r.name, '부서': r.department, '적용시급': Math.round(x.wage) };
            ['overtime', 'holiday', 'night'].forEach(k => {
                row[`${OT_LABELS[k]} 고정(h)`] = h.fixed[k] || 0;
                row[`${OT_LABELS[k]} 실근로(h)`] = Math.round((h.actual[k] || 0) * 10) / 10;
                row[`${OT_LABELS[k]} 초과(h)`] = Math.round(((h.over || {})[k] || 0) * 10) / 10;
            });
            row['초과근무수당'] = x.pay || 0;
            row['발송일시'] = r.expenseSentAt ? new Date(r.expenseSentAt).toLocaleString() : '';
            return row;
        });
    }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    const name = kind === 'wage' ? '임금대장' : '경비대장';
    XLSX.utils.book_append_sheet(wb, ws, name);
    XLSX.writeFile(wb, `${name}_${scope === 'year' ? P.month.slice(0, 4) + '년' : P.month}.xlsx`);
}
