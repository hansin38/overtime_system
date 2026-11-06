// ==========================================
// 💵 급여 관리 (관리자 전용) - 사원등록 · 월 급여 입력 · 임금명세서/경비명세서 · 메일 발송 · 대장 엑셀
// - 기본정보(employees): 이름·전화 뒷4자리·사원번호·부서·직급·입사/퇴사일·고정OT → 직원 로그인·연장근로·연차와 공유
// - 🔒 급여정보(payroll_profiles): 생년월일·이메일·계좌·급여조건·4대보험 기준 → 관리자 로그인 시에만 읽기/쓰기
// - 월별 급여(payroll_records, 문서ID "YYYY-MM_사원ID"): 저장 시점 금액을 그대로 보관 (명세서는 이 값으로 출력)
// - 공제는 회계사무소 급여대장을 불러와 그대로 반영 (불러오기 전에는 자동 예상값)
// - 초과근무수당은 경비로 별도 지급 → 임금명세서에는 넣지 않고 경비명세서(관리자 보관, 발송은 선택)에만 표시
// ==========================================

const STD_MONTH_HOURS = 209;
const TAX_FREE_LIMIT = 200000;                 // 식대·차량유지비 비과세 한도 (각 월)
const MIN_WAGE = { 2026: 10320 };              // 최저임금 (매년 추가)
// 명절상여 지급 월 (설·추석이 있는 달) - 매년 다음 해 추가
const HOLIDAY_BONUS_MONTHS = { 2026: [2, 9], 2027: [2, 9] };
// 4대보험 근로자 부담 (2026년) - 요율이 바뀌면 여기만 수정
const INSURANCE = {
    pension: 0.0475,                // 국민연금 (기준소득월액 × 4.75%)
    health: 0.03595,                // 건강보험 (보수월액 × 3.595%)
    care: 0.9448 / 7.19,            // 장기요양 (건강보험료 × 0.9448/7.19)
    employment: 0.009,              // 고용보험 (과세급여 × 0.9%)
    // 국민연금 기준소득월액 상·하한 (매년 7월 변경)
    pensionLimits: [{ from: '2026-07', min: 410000, max: 6590000 }, { from: '2025-07', min: 400000, max: 6370000 }]
};
const DEFAULT_COMPANY = { companyName: "(주)한신콘설탄트", ceoName: "", contactName: "", contactPhone: "", contactEmail: "", payDay: 10 };
const PAY_LOGO = "/images/hanshin-logo.png";

// 지급 항목 (회계사무소 급여대장 열 순서) - types: 해당 급여 형태에서만 입력칸 표시
const PAY_ITEMS = [
    { key: 'base', label: '기본급' },
    { key: 'overtime', label: '연장근로수당' },
    { key: 'holiday', label: '휴일근로수당', types: ['annual'] },
    { key: 'night', label: '야간근로수당', types: ['annual'] },
    { key: 'holidayNight', label: '휴일·야근수당', types: ['fixed'] },
    { key: 'meal', label: '식대', note: '비과세' },
    { key: 'vehicle', label: '차량유지비', note: '비과세' },
    { key: 'position', label: '직책수당' },
    { key: 'site', label: '현장수당' },
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
    editingEmpId: null,
    showOthers: false,
    importRows: [],
    otAll: [],            // 연장근로 신청 전체 (결재 대기 예상 금액용)
    expenses: {},         // 선택 월 경비(초과근무수당) { 사원ID: payroll_expenses 문서 }
    yearExpenses: []
};

// 급여조건 항목 (연봉 인상 등으로 바뀌면 '적용 시작 월'과 함께 payHistory에 쌓임)
const PAY_COND_FIELDS = ['payType', 'annualSalary', 'fixedPay', 'positionAllowance', 'mealAllowance', 'vehicleAllowance', 'siteAllowance', 'holidayBonus'];

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
// 4대보험·지방소득세 10원 미만 절사 (소수 6자리에서 정리: 28,199.997처럼 1원 미만이 남는 값을 28,200으로 올려버리지 않게)
function floor10(n) { return Math.floor(Math.round(n * 1e6) / 1e6 / 10) * 10; }
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
// 그 달에 적용되는 급여조건 (payHistory에서 '적용 시작 월'이 그 달 이하인 마지막 조건)
function condFor(profile, ym) {
    const hist = (profile.payHistory || []).filter(h => h.from <= ym).sort((a, b) => a.from.localeCompare(b.from));
    if (!hist.length) return profile;
    const { from, ...cond } = hist[hist.length - 1];
    return { ...profile, ...cond };
}
function profFor(id, ym) { return condFor(prof(id), ym); }
function payTypeOf(profile) { return profile.payType === 'fixed' ? 'fixed' : 'annual'; }
function isTarget(empId) { return prof(empId).payslipTarget === true; }
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
function sumValues(obj) { return Object.values(obj || {}).reduce((s, v) => s + (Number(v) || 0), 0); }
function emptyPay() { return Object.fromEntries(PAY_ITEMS.map(it => [it.key, 0])); }

// ------------------------------------------
// 지급액 계산 (회사 급여대장과 같은 식, 원 단위 반올림)
// [연봉 자동(포괄)] 엑셀 '급여산출계산' 고정OT 계약 표
//   통상시급 = (월급 + 명절상여 월할) ÷ (209 + 연장×1.5 + 휴일×1.5 + 야간×0.5)  ※ 가산시간은 0.5 단위 올림
//   연장수당 = 통상시급 × 연장 가산시간 / 휴일·야간수당 = 통상시급 × (휴일+야간 가산시간) → 둘 합계로 반올림 (회사 급여대장 방식)
//   기본급 = 월급 − 식대 − 차량유지비 − 직책수당 − 현장수당 − 고정OT 수당
// [고정 금액] 사원등록에 입력한 항목을 매달 그대로
// 초과수당(경비) 시급 = 월급 ÷ 209 (연봉형은 연봉 ÷ 12 ÷ 209)
// ------------------------------------------
function fixedAllowances(profile) {
    return { meal: num(profile.mealAllowance), vehicle: num(profile.vehicleAllowance), position: num(profile.positionAllowance), site: num(profile.siteAllowance) };
}

function calcPayStructure(profile, employee) {
    const allow = fixedAllowances(profile);
    if (payTypeOf(profile) === 'fixed') {
        const fp = profile.fixedPay || {};
        const pay = { ...emptyPay(), base: num(fp.base), overtime: num(fp.overtime), holidayNight: num(fp.holidayNight), ...allow };
        const monthly = sumValues(pay);
        if (!(monthly > 0)) return null;
        return { type: 'fixed', monthly, expenseWage: monthly / STD_MONTH_HOURS, fixed: getFixOtLimits(employee), pay };
    }
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
    const monthly = Math.round(monthlyRaw);
    const pay = { ...emptyPay(), ...allow };
    pay.overtime = Math.round(ordinaryWage * weighted.overtime);
    const holidayNight = Math.round(ordinaryWage * (weighted.holiday + weighted.night));
    pay.holiday = Math.round(ordinaryWage * weighted.holiday);
    pay.night = holidayNight - pay.holiday;
    pay.base = monthly - pay.meal - pay.vehicle - pay.position - pay.site - pay.overtime - holidayNight;
    return { type: 'annual', annual, monthly, monthlyRaw, bonusMonthly, ordinaryWage, expenseWage: monthlyRaw / STD_MONTH_HOURS, fixed, weighted, totalHours, pay };
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

// 기본 지급액 (급여조건 + 일할 + 명절상여)
// 일할(입사·퇴사 달)은 회사 급여대장 방식: 월급 × 재직일 ÷ 그달 일수를 전부 기본급으로, 식대는 전액
//   (연봉형은 연봉÷12 전체를, 고정형은 식대를 뺀 금액을 일할)
function defaultPay(empId, ym) {
    const employee = emp(empId), profile = profFor(empId, ym);
    const structure = calcPayStructure(profile, employee);
    const range = employmentRange(employee, ym);
    let pay = emptyPay();
    if (structure) {
        pay = { ...structure.pay };
        if (range && range.partial) {
            const f = range.days / range.monthDays;
            // 연봉형은 반올림 전 월급(연봉÷12)으로 일할해야 회사 급여대장과 원 단위까지 같음
            const prorated = structure.type === 'annual' ? structure.monthlyRaw : structure.monthly - structure.pay.meal;
            pay = { ...emptyPay(), base: Math.round(prorated * f), meal: structure.pay.meal };
        }
        const [y, m] = ym.split('-').map(Number);
        if ((HOLIDAY_BONUS_MONTHS[y] || []).includes(m)) pay.bonus = num(profile.holidayBonus);
    }
    return { pay, structure, range };
}

function taxableOf(pay) {
    return sumValues(pay) - Math.min(num(pay.meal), TAX_FREE_LIMIT) - Math.min(num(pay.vehicle), TAX_FREE_LIMIT);
}

// 공제 자동 예상값 (회계사무소 급여대장을 불러오면 그 값으로 바뀜)
// - 국민연금: 공단 기준소득월액 (불러오기로 학습, 0 = 미가입) · 입사한 달은 1일 입사가 아니면 0
// - 건강보험: 공단 보수월액이 있으면 그 값, 없으면 이번 달 과세급여 · 장기요양 = 건강보험료 × 비율
// - 고용보험: 이번 달 과세급여 × 0.9% (미가입 체크 시 0)
// - 소득세: 회계사무소 급여대장에서 마지막으로 불러온 금액 · 지방소득세 = 소득세 × 10%
function defaultDeduct(empId, ym, pay) {
    const e = emp(empId), p = prof(empId);
    const taxable = taxableOf(pay);
    const hireMonth = e.hireDate && e.hireDate.slice(0, 7) === ym && e.hireDate.slice(8) !== '01';
    const limits = INSURANCE.pensionLimits.find(l => ym >= l.from) || INSURANCE.pensionLimits[INSURANCE.pensionLimits.length - 1];
    let pension = 0;
    if (!hireMonth && p.pensionBase !== 0 && taxable > 0) {
        const base = Math.min(limits.max, Math.max(limits.min, Math.floor(num(p.pensionBase || taxable) / 1000) * 1000));
        pension = floor10(base * INSURANCE.pension);
    }
    const health = taxable > 0 ? floor10(num(p.healthBase || taxable) * INSURANCE.health) : 0;
    const care = floor10(health * INSURANCE.care);
    const employment = p.employmentInsured === false ? 0 : floor10(taxable * INSURANCE.employment);
    const incomeTax = num(p.incomeTaxDefault);
    return { pension, health, care, employment, incomeTax, localTax: floor10(incomeTax * 0.1) };
}

// 연장근로 신청의 귀속 월 = 마지막 근무일이 속한 달 (지난달 예외 줄은 이번 달 신청에 포함)
function requestMonth(req) {
    const dates = (req.detailLogs || []).map(l => l.date).filter(Boolean).sort();
    return dates.length ? dates[dates.length - 1].slice(0, 7) : '';
}

// 그 달 실근로시간·초과수당(경비) 계산 (requests = 그 사원의 연장근로 신청들, 귀속 월로 거름)
// cond = 그 달 급여조건 (연봉 인상 이력 반영)
function calcOvertimeFor(employee, cond, requests, ym) {
    const structure = calcPayStructure(cond, employee);
    const wage = structure ? structure.expenseWage : expenseHourlyWage(cond);
    const limits = getFixOtLimits(employee);
    const mine = requests.filter(r => r.employeeName === employee.name && r.employeePhone === employee.phoneLast4 && requestMonth(r) === ym);
    const result = calculateOvertimePay(mine.flatMap(r => r.detailLogs || []), wage, limits);
    return {
        wage, limits, count: mine.length,
        basis: structure ? (structure.type === 'annual' ? { annual: structure.annual } : { monthly: structure.monthly }) : {},
        actual: result.used, over: result.over, lines: result.lines, pay: result.overtimePay
    };
}

// 이번 달 실근로시간·초과수당 - 승인된 연장근로 신청 기준
function calcMonthOvertime(empId, ym) {
    return calcOvertimeFor(emp(empId), profFor(empId, ym), P.otRequests, ym);
}

// 경비(초과근무수당) 명세서 문서 - 연장근로 결재 '승인' 시점에 만들어짐 (payroll_expenses, 문서ID "YYYY-MM_사원ID")
function buildExpenseDoc(employee, cond, approved, ym, payDate, prev) {
    const ot = calcOvertimeFor(employee, cond, approved, ym);
    return {
        ...(prev || {}),
        month: ym, year: Number(ym.slice(0, 4)), employeeId: employee.id,
        name: employee.name, empNo: employee.empNo || '', department: employee.department || '', position: employee.position || '',
        payDate: (prev && prev.payDate) || payDate,
        requestCount: ot.count,
        hours: { fixed: ot.limits, actual: ot.actual, over: ot.over },
        expense: { wage: ot.wage, lines: ot.lines, pay: ot.pay, ...ot.basis },
        updatedAt: Date.now()
    };
}
function expenseDocChanged(a, b) {
    return !a || JSON.stringify([a.requestCount, a.hours, a.expense]) !== JSON.stringify([b.requestCount, b.hours, b.expense]);
}

// 급여 관리 화면을 열 때: 승인된 신청은 있는데 경비명세서가 없거나 내용이 바뀐 사원을 정리
function syncMonthExpenses() {
    const jobs = monthEmployees().map(e => {
        const prev = P.expenses[e.id];
        const doc = buildExpenseDoc(e, profFor(e.id, P.month), P.otRequests, P.month, defaultPayDate(P.month), prev);
        if (!doc.requestCount && !prev) return null;
        if (!expenseDocChanged(prev, doc)) return null;
        return db.collection("payroll_expenses").doc(recordId(P.month, e.id)).set(doc).then(() => { P.expenses[e.id] = doc; });
    }).filter(Boolean);
    return Promise.all(jobs).catch(err => console.error("경비명세서 정리 실패:", err));
}

// 연장근로 결재 탭에서 [승인]을 누른 직후 호출 (js/admin.js) - 그 사원·그 달 경비명세서를 만들거나 다시 계산
function onOvertimeApproved(requestId) {
    return db.collection("overtime_requests").doc(requestId).get().then(reqDoc => {
        const req = reqDoc.data();
        const ym = requestMonth(req);
        if (!ym) return;
        return db.collection("employees").where("name", "==", req.employeeName).where("phoneLast4", "==", req.employeePhone).get().then(empSnap => {
            if (empSnap.empty) return;
            const employee = { id: empSnap.docs[0].id, ...empSnap.docs[0].data() };
            return Promise.all([
                db.collection("payroll_profiles").doc(employee.id).get(),
                db.collection("overtime_requests").where("employeeName", "==", req.employeeName).where("status", "==", "승인").get(),
                db.collection("payroll_expenses").doc(recordId(ym, employee.id)).get(),
                db.collection("payroll_settings").doc("company").get()
            ]).then(([profDoc, reqSnap, expDoc, setDoc]) => {
                const profile = profDoc.exists ? profDoc.data() : {};
                if (profile.payslipTarget !== true) return; // 급여명세서 대상자만
                const settings = { ...DEFAULT_COMPANY, ...(setDoc.exists ? setDoc.data() : {}) };
                const next = shiftMonth(ym, 1);
                const payDate = `${next}-${pad2(Math.min(Number(settings.payDay) || 10, monthDays(next)))}`;
                const doc = buildExpenseDoc(employee, condFor(profile, ym), reqSnap.docs.map(d => d.data()), ym, payDate, expDoc.exists ? expDoc.data() : null);
                return db.collection("payroll_expenses").doc(recordId(ym, employee.id)).set(doc);
            });
        });
    }).catch(err => console.error("경비명세서 생성 실패:", err));
}

// 합계: 차인지급액(지급−공제)은 원 단위, 계좌 송금하는 실지급액은 10원 단위 반올림
function computeTotals(rec) {
    const pay = sumValues(rec.pay);
    const etcTotal = (rec.etc || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const deduct = sumValues(rec.deduct) + etcTotal;
    const taxable = taxableOf(rec.pay || {});
    const net = pay - deduct;
    const payout = round10(net);
    return { pay, deduct, net, payout, rounding: payout - net, taxable, nonTaxable: pay - taxable };
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
    return Promise.all([
        db.collection("employees").get(),
        db.collection("payroll_profiles").get(),
        db.collection("payroll_records").where("year", "==", year).get(),
        db.collection("overtime_requests").get(),
        db.collection("leave_requests").get(),
        db.collection("payroll_settings").doc("company").get(),
        db.collection("payroll_expenses").where("year", "==", year).get()
    ]).then(([empSnap, profSnap, recSnap, otSnap, leaveSnap, setDoc, expSnap]) => {
        P.employees = empSnap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
        P.profiles = {};
        profSnap.forEach(d => { P.profiles[d.id] = d.data(); });
        // 예전에 저장된 기록도 지금 합계 규칙(실지급액 10원 반올림 등)으로 다시 계산
        P.yearRecords = recSnap.docs.map(d => { const r = d.data(); r.pay = { ...emptyPay(), ...r.pay }; r.totals = computeTotals(r); return r; });
        P.records = {};
        P.yearRecords.filter(r => r.month === ym).forEach(r => { P.records[r.employeeId] = r; });
        P.otAll = otSnap.docs.map(d => d.data());
        P.otRequests = P.otAll.filter(r => r.status === "승인");
        P.yearExpenses = expSnap.docs.map(d => d.data());
        P.expenses = {};
        P.yearExpenses.filter(x => x.month === ym).forEach(x => { P.expenses[x.employeeId] = x; });
        P.leaveRequests = leaveSnap.docs.map(d => d.data());
        P.settings = { ...DEFAULT_COMPANY, ...(setDoc.exists ? setDoc.data() : {}) };

        const list = monthEmployees();
        if (!P.employees.find(e => e.id === P.selectedId)) P.selectedId = list.length ? list[0].id : null;
        P.dirty = false;
        return syncMonthExpenses().then(() => {
            P.yearExpenses = P.yearExpenses.filter(x => x.month !== ym).concat(Object.values(P.expenses));
            renderPayMonthBar();
            renderPayEmpList();
            renderPayMain();
        });
    }).catch(err => {
        console.error("급여 데이터 로드 실패:", err);
        document.getElementById('pay-main').innerHTML = `<div class="pay-empty">급여 데이터를 불러오지 못했습니다.<br><small>관리자 로그인 상태와 Firestore 보안 규칙을 확인해 주세요.</small></div>`;
    });
}

// 선택한 달에 재직한 급여명세서 대상자
function monthEmployees() {
    return P.employees.filter(e => isTarget(e.id) && isEmployedIn(e, P.month));
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
    const expDone = list.filter(e => P.expenses[e.id] && P.expenses[e.id].requestCount > 0).length;
    const expWait = list.filter(e => !(P.expenses[e.id] && P.expenses[e.id].requestCount > 0) && pendingRequests(e.id).length).length;
    document.getElementById('pay-stat-expense').innerHTML = `${expDone}/${list.length}${expWait ? ` <small>(결재 대기 ${expWait})</small>` : ''}`;
    const bulk = document.getElementById('pay-bulk-btn');
    bulk.innerText = `일괄 발송 (${pending}명)`;
    bulk.disabled = pending === 0;
}

function renderPayEmpList() {
    const q = (document.getElementById('pay-search').value || '').trim();
    const match = (e) => !q || (e.name || '').includes(q);
    const list = monthEmployees().filter(match);
    const box = document.getElementById('pay-emp-list');
    if (P.employees.length === 0) {
        box.innerHTML = `<div class="pay-emp-none">등록된 사원이 없습니다</div>`;
        document.getElementById('pay-emp-others').innerHTML = '';
        return;
    }
    box.innerHTML = list.map(e => {
        const st = recordStatus(P.records[e.id]);
        return `<div class="${e.id === P.selectedId ? 'sel' : ''}" onclick="selectPayEmployee('${e.id}')">
            <span class="pay-dot d-${st}"></span>${esc(e.name)}<small>${esc(e.empNo || '')}</small>
        </div>`;
    }).join('') || `<div class="pay-emp-none">${q ? '검색 결과가 없습니다' : '이번 달 급여명세서 대상자가 없습니다'}</div>`;

    // 대상 아님 · 이번 달 미재직 사원 (정보 수정은 가능, 기본은 접어둠)
    const others = P.employees.filter(e => !(isTarget(e.id) && isEmployedIn(e, P.month)) && match(e));
    const otherBox = document.getElementById('pay-emp-others');
    if (!others.length) { otherBox.innerHTML = ''; return; }
    const open = P.showOthers || !!q || others.some(e => e.id === P.selectedId);
    otherBox.innerHTML = `<div class="pay-others-title" onclick="P.showOthers = !P.showOthers; renderPayEmpList();">급여명세서 대상 아님 · 미재직 (${others.length}명) ${open ? '▾' : '▸'}</div>`
        + (open ? others.map(e => {
            const why = !isTarget(e.id) ? '대상 아님' : (e.resignDate && e.resignDate < `${P.month}-01` ? '퇴사' : '입사 전');
            return `<div class="${e.id === P.selectedId ? 'sel' : ''}" onclick="selectPayEmployee('${e.id}')">${esc(e.name)}<small>${why}</small></div>`;
        }).join('') : '');
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
    const profile = profFor(e.id, P.month);
    const st = recordStatus(P.records[e.id]);
    const fixed = getFixOtLimits(e);
    const active = isTarget(e.id) && isEmployedIn(e, P.month);
    const type = payTypeOf(profile);
    const s = calcPayStructure(profile, e);
    const chips = [
        type === 'annual'
            ? (profile.annualSalary ? `연봉 자동 · ${won(profile.annualSalary)}` : `<span class="warn">연봉 미등록</span>`)
            : (s ? `고정 금액 · 월 ${won(s.monthly)}` : `<span class="warn">급여 미등록</span>`),
        `고정OT 연장 ${fixed.overtime}h · 휴일 ${fixed.holiday}h · 야간 ${fixed.night}h`,
        e.hireDate ? `입사 ${e.hireDate}` : `<span class="warn">입사일 미등록</span>`,
        e.resignDate ? `퇴사 ${e.resignDate}` : '',
        isTarget(e.id) ? '' : `<span class="warn">급여명세서 대상 아님</span>`
    ].filter(Boolean);

    if (!active && P.subTab === 1) P.subTab = 3;
    const pill = active
        ? `<span class="pay-pill p-${st}">${Number(P.month.slice(5))}월 ${STATUS_TEXT[st]}</span>`
        : `<span class="pay-pill p-wait">${isTarget(e.id) ? '이번 달 미재직' : '대상 아님'}</span>`;
    box.innerHTML = `
        <div class="pay-emp-head">
            <span class="name">${esc(e.name)}</span>
            <span class="meta">${esc(e.department || '-')} · ${esc(e.position || '-')} · ${esc(e.empNo || '사원번호 없음')}</span>
            ${pill}
        </div>
        <div class="pay-chips">${chips.map(c => `<span class="pay-chip">${c}</span>`).join('')}</div>
        <div class="pay-subtabs">
            ${active ? `<button class="${P.subTab === 1 ? 'on' : ''}" onclick="switchPaySub(1)">이번 달 급여</button>` : ''}
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
function visiblePayItems(type, pay, editable) {
    return PAY_ITEMS.filter(it => {
        if (it.types && !it.types.includes(type) && !num(pay[it.key])) return false;
        return editable || ['base', 'meal'].includes(it.key) || num(pay[it.key]) !== 0;
    });
}

function renderPayMonthPane() {
    const id = P.selectedId;
    const rec = P.records[id];
    const def = defaultPay(id, P.month);
    const pay = rec ? { ...emptyPay(), ...rec.pay } : def.pay;
    const deduct = rec ? rec.deduct : defaultDeduct(id, P.month, pay);
    const deductClass = rec ? ({ accounting: 'acc', auto: 'auto' }[rec.deductSource] || '') : 'auto';
    const etc = rec ? (rec.etc || []) : [];
    const type = payTypeOf(profFor(id, P.month));
    const prorateNote = def.range && def.range.partial
        ? `<div class="pay-note blue">📅 일할계산 · ${def.range.start.slice(5)} ~ ${def.range.end.slice(5)} 재직 ${def.range.days}일 ÷ ${def.range.monthDays}일 → 전액 기본급, 식대는 전액 (회사 급여대장 방식)</div>` : '';
    const deductTag = rec && rec.deductSource === 'accounting'
        ? `<span class="tag acc">회계사무소 값 · ${msToDate(rec.accountingImportedAt)} 불러옴</span>`
        : `<span class="tag">자동 예상값</span>`;

    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-grid">
            <div>
                ${!def.structure ? `<div class="pay-note warn">급여조건이 등록되지 않아 지급액을 자동 계산할 수 없습니다. [사원 정보] 탭에서 급여조건을 입력해 주세요.</div>` : ''}
                <div class="pay-card">
                    <h4>지급 <span class="tag">${type === 'annual' ? '연봉에서 자동 계산' : '고정 금액'}</span>
                        <span class="link" onclick="togglePayEdit()">${P.payEditable ? '자동 계산값으로 되돌리기' : '금액 직접 수정'}</span></h4>
                    <div class="hint">${P.payEditable ? '그달만 다르게 지급할 금액을 고쳐 주세요' : '원 단위 · 0원 항목은 명세서에 표시하지 않아요'}${rec && rec.payEdited ? ' · <b>이 달은 금액을 직접 고쳤어요</b>' : ''}</div>
                    ${prorateNote}
                    <div class="pay-lines" id="pay-pay-lines">
                        ${visiblePayItems(type, pay, P.payEditable).map(it => `
                            <span>${it.label}${it.note ? ` <small class="sub">${it.note}</small>` : ''}${it.key === 'bonus' ? ` <small class="sub">설·추석 달</small>` : ''}</span>
                            <input data-pay="${it.key}" value="${won(pay[it.key])}" ${P.payEditable ? '' : 'readonly'} oninput="onPayInput(this)">`).join('')}
                        <span class="total">지급액 계</span><span class="num total" id="pay-sum-pay"></span>
                    </div>
                </div>

                <div class="pay-card">
                    <h4>공제 ${deductTag}<span class="link" onclick="resetDeductAuto()">자동 예상값으로 다시 계산</span></h4>
                    <div class="hint">회계사무소 급여대장을 불러오면 그 금액이 그대로 들어가요 (상단 [📥 회계사무소 급여대장]) · 직접 고친 칸은 노란색</div>
                    <div class="pay-lines">
                        ${DEDUCT_ITEMS.map(it => `<span>${it.label}</span><input data-deduct="${it.key}" class="${deductClass}" value="${deduct[it.key] ? won(deduct[it.key]) : ''}" placeholder="0" oninput="onPayInput(this)">`).join('')}
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
                <button class="pay-btn pay-admin-view" onclick="viewPayDoc('wage', true)">📋 관리자 확인용 명세서 보기 <small>발송 안 됨</small></button>
                <div class="sum-net"><small>실지급액 (계좌 송금)</small><b id="pay-sum-net"></b>
                    <div class="row"><span id="pay-sum-pay2"></span><span id="pay-sum-deduct2"></span></div>
                    <div class="round" id="pay-sum-round"></div></div>
                <div class="sum-exp" id="pay-sum-exp"></div>
                <div class="pay-save-row"><button class="pay-btn dark" onclick="savePayRecord()">저장</button></div>
                <div class="pay-docs">
                    <div class="pay-docs-h">📧 직원에게 보내는 명세서</div>
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

// 숫자 입력칸은 입력하면서 천 단위 쉼표 · 공제를 직접 고치면 노란색
function onPayInput(el) {
    if (el && (el.dataset.pay || el.dataset.deduct || el.classList.contains('etc-amount'))) {
        const raw = String(el.value).replace(/[^0-9-]/g, '');
        el.value = raw ? Number(raw).toLocaleString() : '';
    }
    if (el && el.dataset.deduct) {
        el.classList.remove('auto', 'acc');
        el.classList.add('edited');
        if (el.dataset.deduct === 'incomeTax') {
            const local = document.querySelector('input[data-deduct=localTax]');
            if (!local.classList.contains('edited')) local.value = won(floor10(num(el.value) * 0.1));
        }
    }
    P.dirty = true;
    refreshPaySummary();
}

function resetDeductAuto() {
    const d = defaultDeduct(P.selectedId, P.month, readPayForm().pay);
    document.querySelectorAll('input[data-deduct]').forEach(inp => {
        inp.value = d[inp.dataset.deduct] ? won(d[inp.dataset.deduct]) : '';
        inp.classList.remove('edited', 'acc');
        inp.classList.add('auto');
    });
    P.dirty = true;
    refreshPaySummary();
}

function togglePayEdit() {
    const values = readPayForm();
    if (P.payEditable) {
        values.pay = defaultPay(P.selectedId, P.month).pay; // 자동 계산값으로 되돌리기
        P.dirty = true;
    }
    P.payEditable = !P.payEditable;
    const deductClasses = {};
    document.querySelectorAll('input[data-deduct]').forEach(inp => { deductClasses[inp.dataset.deduct] = inp.className; });
    const rec = P.records[P.selectedId];
    // 입력 중이던 값을 유지한 채 다시 그리기
    P.records[P.selectedId] = { ...(rec || {}), pay: values.pay, deduct: values.deduct, etc: values.etc };
    renderPayMonthPane();
    if (rec) P.records[P.selectedId] = rec; else delete P.records[P.selectedId];
    document.querySelectorAll('input[data-deduct]').forEach(inp => { inp.className = deductClasses[inp.dataset.deduct] || ''; });
    refreshPaySummary();
}

function readPayForm() {
    const pay = emptyPay(), deduct = {};
    const shown = new Set();
    document.querySelectorAll('input[data-pay]').forEach(inp => { pay[inp.dataset.pay] = num(inp.value); shown.add(inp.dataset.pay); });
    // 화면에 안 보이는 0원 항목은 원래 값 유지
    const base = P.records[P.selectedId] ? P.records[P.selectedId].pay : defaultPay(P.selectedId, P.month).pay;
    PAY_ITEMS.forEach(it => { if (!shown.has(it.key)) pay[it.key] = num(base && base[it.key]); });
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
    document.getElementById('pay-sum-net').innerText = `${won(t.payout)}원`;
    document.getElementById('pay-sum-pay2').innerText = `지급 ${won(t.pay)}`;
    document.getElementById('pay-sum-deduct2').innerText = `공제 ${won(t.deduct)}`;
    document.getElementById('pay-sum-round').innerText = t.rounding ? `차인지급액 ${won(t.net)} → 10원 단위 반올림` : '';

    const rec = P.records[P.selectedId];
    document.getElementById('pay-sum-exp').innerHTML = expenseCardHtml(P.selectedId);

    const st = recordStatus(rec);
    document.getElementById('pay-doc-wage-st').innerText = rec
        ? (st === 'save' ? '저장됨 · 미발송' : st === 'revised' ? '수정됨 · 재발송 필요' : `${msToDateTime(rec.wageSentAt)} 발송완료`)
        : '저장 전';
    const x = P.expenses[P.selectedId];
    document.getElementById('pay-doc-exp-st').innerText = !(x && x.requestCount)
        ? (pendingRequests(P.selectedId).length ? '결재 대기 중' : '연장근로 신청 없음')
        : (x.expenseSentAt ? `${msToDateTime(x.expenseSentAt)} 발송함` : '승인 확정 · 보관');
}

// 결재 대기(대기·재전송) 중인 이번 달 연장근로 신청
function pendingRequests(empId) {
    const e = emp(empId);
    return P.otAll.filter(r => r.employeeName === e.name && r.employeePhone === e.phoneLast4
        && ['대기', '재전송'].includes(r.status) && requestMonth(r) === P.month);
}

// 오른쪽 경비 카드: 승인 확정 / 결재 대기(예상) / 신청 없음
function expenseCardHtml(empId) {
    const x = P.expenses[empId];
    const pending = pendingRequests(empId);
    const mo = `${Number(P.month.slice(5))}월분`;
    if (x && x.requestCount) {
        const line = x.expense.lines.map(l => `${OT_LABELS[l.bucket]} 초과 ${fmtH(l.hours)} × ${won(x.expense.wage)}원 × ${Math.round(l.rate * 100)}%`).join('<br>');
        return `<div class="h"><span>경비 · 초과근무수당</span><span class="pay-pill p-sent">승인 확정</span></div>
            <b>${won(x.expense.pay)}원</b>
            <div class="s">${line || '고정OT 범위 내 (지급 없음)'}</div>
            <div class="s">${mo} 승인 ${x.requestCount}건 · ${msToDateTime(x.updatedAt)} 계산${pending.length ? ` · 결재 대기 ${pending.length}건 더 있음` : ''}</div>`;
    }
    if (pending.length) {
        const est = calcOvertimeFor(emp(empId), profFor(empId, P.month), pending, P.month);
        return `<div class="h"><span>경비 · 초과근무수당</span><span class="pay-pill p-wait">결재 대기</span></div>
            <b class="est">예상 ${won(est.pay)}원</b>
            <div class="s">${mo} 신청 ${pending.length}건이 결재 대기 중 · 승인하면 경비명세서가 만들어져요</div>`;
    }
    return `<div class="h"><span>경비 · 초과근무수당</span><span class="pay-pill p-wait">신청 없음</span></div>
        <div class="s" style="margin-top: 6px;">${mo} 연장근로 신청이 아직 없어요</div>`;
}

// 현재 입력 화면(또는 저장된 기록)을 명세서용 기록으로 만들기
function buildRecord(empId, fromForm, override = null) {
    const e = emp(empId), profile = prof(empId);
    const def = defaultPay(empId, P.month);
    const saved = P.records[empId];
    const form = override || (fromForm ? readPayForm() : { pay: saved.pay, deduct: saved.deduct, etc: saved.etc || [] });
    const ot = calcMonthOvertime(empId, P.month);
    const s = def.structure;
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
        payType: payTypeOf(profFor(empId, P.month)),
        payDate: (saved && saved.payDate) || defaultPayDate(P.month),
        pay: { ...emptyPay(), ...form.pay },
        deduct: form.deduct,
        etc: form.etc || [],
        prorate: def.range && def.range.partial ? { start: def.range.start, end: def.range.end, days: def.range.days, monthDays: def.range.monthDays } : null,
        workDays: countWorkDays(def.range),
        hours: { fixed: ot.limits, actual: ot.actual, over: ot.over },
        expense: { wage: ot.wage, lines: ot.lines, pay: ot.pay, ...ot.basis },
        calc: s && s.type === 'annual' ? { ordinaryWage: s.ordinaryWage, weighted: s.weighted, totalHours: s.totalHours, monthly: s.monthly } : null
    };
    // 저장된 기록을 볼 때는 저장 당시 근로시간·경비를 그대로 사용
    if (!fromForm && !override && saved && saved.hours) { rec.hours = saved.hours; rec.expense = saved.expense; }
    rec.totals = computeTotals(rec);
    return rec;
}

function storeRecord(rec) {
    return db.collection("payroll_records").doc(recordId(rec.month, rec.employeeId)).set(rec).then(() => {
        P.records[rec.employeeId] = rec;
        const i = P.yearRecords.findIndex(r => r.month === rec.month && r.employeeId === rec.employeeId);
        if (i >= 0) P.yearRecords[i] = rec; else P.yearRecords.push(rec);
        return rec;
    });
}

function savePayRecord() {
    const id = P.selectedId;
    const rec = buildRecord(id, true);
    const now = Date.now();
    rec.updatedAt = now;
    if (!rec.savedAt) rec.savedAt = now;
    rec.payEdited = P.payEditable || !!(P.records[id] && P.records[id].payEdited);
    // 공제칸을 하나라도 직접 고쳤으면 출처 표시를 '직접 입력'으로
    const classes = Array.from(document.querySelectorAll('input[data-deduct]')).map(i => i.className);
    if (classes.some(c => c.includes('edited'))) rec.deductSource = 'manual';
    else if (classes.every(c => c.includes('auto'))) rec.deductSource = 'auto';
    return storeRecord(rec)
        .then(r => {
            P.dirty = false;
            renderPayMonthBar();
            renderPayEmpList();
            renderPayMain();
            return r;
        })
        .catch(err => { console.error("급여 저장 실패:", err); alert("저장 중 오류가 발생했습니다."); throw err; });
}

// ---------- 연간 현황 ----------
function expOf(empId, ym) {
    const x = P.yearExpenses.find(v => v.employeeId === empId && v.month === ym);
    return x ? x.expense.pay || 0 : 0;
}

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
            <td>${m}월${tag}</td><td>${won(r.totals.pay)}</td><td>${won(r.totals.deduct)}</td><td>${won(r.totals.payout)}</td>
            <td class="e">${expOf(id, ym) ? won(expOf(id, ym)) : '-'}</td>
            <td><span class="pay-pill p-${st}">${STATUS_TEXT[st].split(' ')[0]}</span></td></tr>`;
    }).join('');
    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-kpis">
            <div class="pay-kpi"><small>${year}년 지급 누계</small><b>${won(sum(r => r.totals.pay))}</b></div>
            <div class="pay-kpi"><small>공제 누계</small><b>${won(sum(r => r.totals.deduct))}</b></div>
            <div class="pay-kpi"><small>실지급 누계</small><b>${won(sum(r => r.totals.payout))}</b></div>
            <div class="pay-kpi e"><small>경비 누계</small><b>${won(P.yearExpenses.filter(x => x.employeeId === id).reduce((t, x) => t + (x.expense.pay || 0), 0))}</b></div>
        </div>
        <table class="pay-year">
            <tr><th>월</th><th>지급</th><th>공제</th><th>실지급</th><th>경비</th><th>임금명세서</th></tr>
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
    const e = emp(P.selectedId), p = profFor(P.selectedId, P.month);
    const s = calcPayStructure(p, e);
    const fixed = getFixOtLimits(e);
    const type = payTypeOf(p);
    const fp = p.fixedPay || {};
    const dl = (rows) => `<dl class="pay-dl">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v || '-'}</dd>`).join('')}</dl>`;
    const m = (v) => num(v) ? won(v) : '';
    const payRows = type === 'annual'
        ? [['급여 형태', '연봉 자동 (포괄)'], ['연봉', m(p.annualSalary)]]
        : [['급여 형태', '고정 금액'], ['기본급', m(fp.base)], ['연장근로수당', m(fp.overtime)], ['휴일·야근수당', m(fp.holidayNight)]];
    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-info-grid">
            <div>
                <div class="pay-card"><h4>인적사항</h4>${dl([
                    ['이름', esc(e.name)], ['사원번호', esc(e.empNo)], ['전화 뒷4자리', esc(e.phoneLast4)],
                    ['생년월일 🔒', esc(p.birthDate)], ['이메일 🔒', esc(p.email)], ['입금 계좌 🔒', esc(p.bankAccount)],
                    ['급여명세서', isTarget(e.id) ? '발급 대상' : '대상 아님']
                ])}</div>
                <div class="pay-card"><h4>근무조건</h4>${dl([
                    ['부서 / 직급', `${esc(e.department || '-')} / ${esc(e.position || '-')}`],
                    ['입사일', esc(e.hireDate)], ['퇴사일', esc(e.resignDate)],
                    ['고정OT (월)', `연장 ${fixed.overtime}h · 휴일 ${fixed.holiday}h · 야간 ${fixed.night}h`]
                ])}</div>
            </div>
            <div>
                <div class="pay-card lock"><h4>🔒 급여조건</h4>${dl([
                    ...payRows,
                    ['식대', m(p.mealAllowance)], ['차량유지비', m(p.vehicleAllowance)], ['직책수당', m(p.positionAllowance)],
                    ['현장수당', m(p.siteAllowance)], ['명절상여', p.holidayBonus ? `설·추석 각 ${won(p.holidayBonus)}` : ''],
                    ['월 지급 합계', s ? won(s.monthly) : ''],
                    (p.payHistory || []).length > 1 ? ['변경 이력', p.payHistory.slice().reverse().map(h =>
                        `${h.from === '0000-00' ? '처음' : h.from + '분부터'} · ${h.payType === 'fixed' ? '고정 ' + won(sumValues(h.fixedPay) + num(h.mealAllowance) + num(h.vehicleAllowance) + num(h.positionAllowance) + num(h.siteAllowance)) : '연봉 ' + won(h.annualSalary)}`).join('<br>')] : null,
                    s && s.type === 'annual' ? ['통상시급', `${won2(s.ordinaryWage)}원 <small class="sub">자동</small>`] : null,
                    ['경비 시급', s ? `${won(s.expenseWage)}원 <small class="sub">월급÷209</small>` : (p.legacyHourlyWage ? `${won(p.legacyHourlyWage)}원 <small class="sub">예전 통상시급</small>` : '')]
                ])}</div>
                <div class="pay-card"><h4>4대보험 · 소득세 기준 <small class="sub" style="font-weight: normal;">회계사무소 급여대장을 불러오면 자동 갱신</small></h4>${dl([
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
        ...pickCond(f),
        pensionBase: f.pensionBase, healthBase: f.healthBase, employmentInsured: f.employmentInsured,
        payslipTarget: f.payslipTarget
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
// 📥 회계사무소 급여대장 불러오기
// - 회계사무소 엑셀(.xls/.xlsx): 사원마다 3줄 (사원번호·성명·항목 / 입사일·공제합계 / 지급합계·차인지급액)
// - 머리글 글자로 열 위치를 찾으므로 열 순서가 바뀌어도 동작
// - 공제 6항목은 그대로 반영, 지급이 다르면 '회계사무소 값으로 맞추기' 선택
// - 국민연금·건강보험 기준액, 고용보험 가입 여부, 소득세는 사원별 기준으로 학습 → 다음 달 자동 예상값에 사용
// ------------------------------------------
const ACC_COLUMNS = {
    '기본급': 'base', '연장근로수당': 'overtime', '식대': 'meal', '차량유지비': 'vehicle', '직책수당': 'position',
    '현장수당': 'site', '휴일,야근수당': 'holidayNight', '상여': 'bonus',
    '국민연금': 'pension', '건강보험': 'health', '고용보험': 'employment', '장기요양보험료': 'care', '소득세': 'incomeTax', '지방소득세': 'localTax'
};
const ACC_PAY_KEYS = ['base', 'overtime', 'meal', 'vehicle', 'position', 'site', 'holidayNight', 'bonus'];
const ACC_PAY_LABELS = { base: '기본급', overtime: '연장근로수당', meal: '식대', vehicle: '차량유지비', position: '직책수당', site: '현장수당', holidayNight: '휴일·야근(야간)수당', bonus: '상여' };

function openPayImport() {
    P.importRows = [];
    document.getElementById('pay-import-file').value = '';
    document.getElementById('pay-import-result').innerHTML = '';
    document.getElementById('pay-import-apply').disabled = true;
    document.getElementById('pay-import-title').innerText = `📥 회계사무소 급여대장 불러오기 · ${monthLabel(P.month)}`;
    document.getElementById('pay-import-modal').style.display = 'flex';
}
function closePayImport() { document.getElementById('pay-import-modal').style.display = 'none'; }

function parseAccountingSheet(rows) {
    const norm = (v) => String(v ?? '').replace(/\s/g, '');
    const h = rows.findIndex(r => r.some(c => norm(c) === '사원번호'));
    if (h < 0) throw new Error('"사원번호" 머리글을 찾지 못했습니다. 회계사무소 급여대장 파일이 맞는지 확인해 주세요.');
    const cols = {};
    let payTotal = null, netPos = null;
    for (let k = 0; k < 3; k++) {
        (rows[h + k] || []).forEach((c, ci) => {
            const t = norm(c);
            if (ACC_COLUMNS[t] && k === 0 && cols[ACC_COLUMNS[t]] === undefined) cols[ACC_COLUMNS[t]] = ci;
            if (t === '지급합계') payTotal = { k, ci };
            if (t === '차인지급액') netPos = { k, ci };
        });
    }
    let accMonth = '';
    rows.slice(0, h + 1).forEach(r => r.forEach(c => {
        const m = /귀속\s*:\s*(\d{4})년\s*(\d{1,2})월/.exec(String(c));
        if (m) accMonth = `${m[1]}-${pad2(m[2])}`;
    }));
    const people = [];
    for (let r = h + 3; r < rows.length; r++) {
        const row = rows[r] || [];
        const no = norm(row[0]), name = norm(row[1]);
        if (!/^\d+$/.test(no) || !name || name === '성명') continue;
        const item = { empNo: no, name, pay: {}, deduct: {} };
        Object.entries(cols).forEach(([key, ci]) => {
            const v = num(row[ci]);
            if (ACC_PAY_KEYS.includes(key)) item.pay[key] = v; else item.deduct[key] = v;
        });
        if (payTotal) item.payTotal = num((rows[r + payTotal.k] || [])[payTotal.ci]);
        if (netPos) item.net = num((rows[r + netPos.k] || [])[netPos.ci]);
        people.push(item);
        r += 2;
    }
    if (!people.length) throw new Error('사원 행을 찾지 못했습니다.');
    return { accMonth, people };
}

// 우리 지급 항목을 회계사무소 열 기준으로 묶기 (휴일+야간 → 휴일·야근수당)
function payToAccShape(pay) {
    const o = {};
    ACC_PAY_KEYS.forEach(k => { o[k] = num(pay[k]); });
    o.holidayNight = num(pay.holiday) + num(pay.night) + num(pay.holidayNight);
    return o;
}

function onPayImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            const { accMonth, people } = parseAccountingSheet(rows);
            // 파일의 귀속월로 자동 이동 (달을 따로 고를 필요 없음)
            const sel = document.getElementById('pay-month');
            if (accMonth && accMonth !== P.month && [...sel.options].some(o => o.value === accMonth)) {
                sel.value = accMonth;
                P.month = accMonth;
                P.subTab = 1;
                document.getElementById('pay-import-title').innerText = `📥 회계사무소 급여대장 불러오기 · ${monthLabel(P.month)}`;
                loadPayrollData().then(() => buildImportRows(accMonth, people));
                return;
            }
            buildImportRows(accMonth, people);
        } catch (err) {
            console.error("급여대장 읽기 실패:", err);
            document.getElementById('pay-import-result').innerHTML = `<div class="pay-note warn">${esc(err.message)}</div>`;
        }
    };
    reader.readAsArrayBuffer(file);
}

function buildImportRows(accMonth, people) {
    const targets = monthEmployees();
    P.importRows = targets.map(e => {
        const acc = people.find(p => e.empNo && p.empNo === String(e.empNo)) || people.find(p => p.name === (e.name || '').replace(/\s/g, ''));
        const rec = P.records[e.id];
        const ourPay = rec ? { ...emptyPay(), ...rec.pay } : defaultPay(e.id, P.month).pay;
        if (!acc) return { emp: e, acc: null, ourPay };
        const ours = payToAccShape(ourPay);
        const accPay = { ...Object.fromEntries(ACC_PAY_KEYS.map(k => [k, 0])), ...acc.pay };
        const diffs = ACC_PAY_KEYS.filter(k => ours[k] !== num(accPay[k])).map(k => ({ key: k, ours: ours[k], acc: num(accPay[k]) }));
        return { emp: e, acc, accPay, ourPay, diffs, matchPay: diffs.length > 0 };
    });
    const unknown = people.filter(p => !P.importRows.some(r => r.acc === p)).length;
    const monthWarn = accMonth && accMonth !== P.month
        ? `<div class="pay-note warn">⚠️ 파일의 귀속월은 <b>${monthLabel(accMonth)}</b>인데, 지금 선택한 달은 <b>${monthLabel(P.month)}</b>입니다. 달을 확인해 주세요.</div>` : '';
    const rowsHtml = P.importRows.map((r, i) => {
        if (!r.acc) return `<tr class="bad"><td>${esc(r.emp.name)}</td><td colspan="6" class="bad" style="text-align: left;">회계사무소 파일에 없음 (사원번호 ${esc(r.emp.empNo || '-')})</td></tr>`;
        const ourTotal = sumValues(r.ourPay);
        const dTotal = sumValues(r.acc.deduct);
        const payout = round10(num(r.acc.payTotal || sumValues(r.accPay)) - dTotal);
        const ok = !r.diffs.length;
        return `<tr class="${ok ? '' : 'bad'}">
            <td>${esc(r.emp.name)}</td><td>${won(ourTotal)}</td><td>${won(r.acc.payTotal || sumValues(r.accPay))}</td>
            <td class="${ourTotal === sumValues(r.accPay) ? '' : 'bad'}">${won(sumValues(r.accPay) - ourTotal)}</td>
            <td>${won(dTotal)}</td><td>${won(payout)}</td>
            <td style="text-align: center;">${ok ? '<span class="ok">✅ 일치</span>' : '<span class="bad">⚠️ 항목 다름</span>'}</td></tr>`
            + (ok ? '' : `<tr class="bad-detail"><td colspan="7">
                ${r.diffs.map(d => `${ACC_PAY_LABELS[d.key]}: 우리 <b>${won(d.ours)}</b> ↔ 회계사무소 <b>${won(d.acc)}</b>`).join(' · ')}
                <label class="pay-import-chk"><input type="checkbox" ${r.matchPay ? 'checked' : ''} onchange="P.importRows[${i}].matchPay = this.checked"> 지급도 회계사무소 값으로 맞추기</label></td></tr>`);
    }).join('');
    document.getElementById('pay-import-result').innerHTML = `${monthWarn}
        <div class="sub" style="margin: 4px 0 8px;">사원번호·이름으로 짝 맞춤 · 이번 달 급여명세서 대상 ${P.importRows.length}명${unknown ? ` · 대상이 아닌 ${unknown}명은 건너뜀` : ''}</div>
        <table class="pay-import-tbl">
            <tr><th>이름</th><th>우리 지급합계</th><th>회계사무소 지급합계</th><th>차이</th><th>공제 합계</th><th>실지급액</th><th style="text-align:center;">상태</th></tr>
            ${rowsHtml}
        </table>`;
    const n = P.importRows.filter(r => r.acc).length;
    const btn = document.getElementById('pay-import-apply');
    btn.disabled = n === 0;
    btn.innerText = `공제 반영하고 저장 (${n}명)`;
}

// 회계사무소 지급값을 우리 항목으로 (휴일·야근수당은 연봉형이면 휴일/야간 비율로 나눔)
function accPayToOurs(empId, accPay, ourPay) {
    const pay = { ...emptyPay() };
    ACC_PAY_KEYS.forEach(k => { pay[k] = num(accPay[k]); });
    const hn = pay.holidayNight;
    pay.holidayNight = 0;
    if (payTypeOf(profFor(empId, P.month)) === 'annual') {
        if (num(ourPay.holiday) + num(ourPay.night) === hn) {
            pay.holiday = num(ourPay.holiday); pay.night = num(ourPay.night);
        } else {
            const s = calcPayStructure(profFor(empId, P.month), emp(empId));
            const share = s ? s.weighted.holiday / (s.weighted.holiday + s.weighted.night) : 0.5;
            pay.holiday = Math.round(hn * share); pay.night = hn - pay.holiday;
        }
    } else {
        pay.holidayNight = hn;
    }
    return pay;
}

function applyPayImport() {
    const rows = P.importRows.filter(r => r.acc);
    if (!rows.length) return;
    const now = Date.now();
    setPayBusy(true, '회계사무소 급여대장 반영 중...');
    const jobs = rows.map(r => {
        const id = r.emp.id;
        const pay = r.matchPay ? accPayToOurs(id, r.accPay, r.ourPay) : r.ourPay;
        const deduct = Object.fromEntries(DEDUCT_ITEMS.map(it => [it.key, num(r.acc.deduct[it.key])]));
        const saved = P.records[id];
        const rec = buildRecord(id, false, { pay, deduct, etc: saved ? saved.etc || [] : [] });
        rec.updatedAt = now;
        if (!rec.savedAt) rec.savedAt = now;
        rec.deductSource = 'accounting';
        rec.accountingImportedAt = now;
        if (r.matchPay) rec.payEdited = true;

        // 사원별 기준 학습 (입사한 달 국민연금 0원은 미가입으로 보지 않음)
        const e = r.emp, taxable = taxableOf(pay);
        const learn = { incomeTaxDefault: deduct.incomeTax, incomeTaxMonth: P.month, employmentInsured: deduct.employment > 0 || taxable <= 0 };
        const hireMonth = e.hireDate && e.hireDate.slice(0, 7) === P.month;
        if (deduct.pension > 0) learn.pensionBase = Math.round(deduct.pension / INSURANCE.pension / 1000) * 1000;
        else if (!hireMonth) learn.pensionBase = 0;
        if (deduct.health > 0) {
            const auto = floor10(taxable * INSURANCE.health);
            if (auto === deduct.health) learn.healthBase = null;
            else {
                const k = Math.round(deduct.health / INSURANCE.health / 1000) * 1000;
                learn.healthBase = floor10(k * INSURANCE.health) === deduct.health ? k : Math.ceil(deduct.health / INSURANCE.health);
            }
        }
        return storeRecord(rec)
            .then(() => db.collection("payroll_profiles").doc(id).set(learn, { merge: true }))
            .then(() => { P.profiles[id] = { ...prof(id), ...learn }; });
    });
    Promise.all(jobs)
        .then(() => {
            setPayBusy(false); P.dirty = false; renderPayMonthBar(); renderPayEmpList(); renderPayMain();
            closePayImport();
            // 반영 끝나면 바로 일괄 발송으로 (발송할 명단 확인창이 한 번 더 떠요)
            if (confirm(`${rows.length}명의 임금명세서가 회계사무소 값으로 준비됐어요.

지금 일괄 발송할까요? (취소하면 화면에서 하나씩 확인 후 발송)`)) bulkSendWage();
        })
        .catch(err => {
            console.error("급여대장 반영 실패:", err);
            alert("반영 중 오류가 발생했습니다. 일부만 저장됐을 수 있으니 다시 불러와 주세요.");
            setPayBusy(false); P.dirty = false; renderPayMonthBar(); renderPayEmpList(); renderPayMain();
        });
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
function expenseYtd(x) {
    return P.yearExpenses.filter(v => v.employeeId === x.employeeId && v.month <= x.month).reduce((t, v) => t + (v.expense.pay || 0), 0);
}

function ytdFor(rec) {
    const recs = P.yearRecords.filter(r => r.employeeId === rec.employeeId && r.month < rec.month).concat([rec]);
    return recs.reduce((s, r) => ({
        pay: s.pay + r.totals.pay, deduct: s.deduct + r.totals.deduct, payout: s.payout + r.totals.payout,
    }), { pay: 0, deduct: 0, payout: 0 });
}

// 명세서 3종(관리자 확인용·직원 발송본·경비) 공통 A4 한 장 틀
//  [위 고정] 로고·제목·날짜  /  [가운데] 내용 (넘치면 fitSlipBodies()가 축소)  /  [아래 고정] 인사말~마지막 줄
// 맨 위 고정 영역: 로고·제목·날짜 줄
function slipTopHtml(title, sub, stamp) {
    return `<div class="ps-top">
        <img class="ps-logo" src="${PAY_LOGO}" alt="">
        <h1 class="ps-title">${title}${stamp ? `<span class="ps-rev">수정본</span>` : ''}</h1>
        <div class="ps-sub">${sub}${stamp ? ` <span class="ps-rev-date">(${stamp.slice(5)} 수정)</span>` : ''}</div>
    </div>`;
}
function slipInfoHtml(rec) {
    return `
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

// opts.admin = true → 관리자 보관용(실근로·실지급액·누계·연차·계좌·문의처 포함, '관리자 보관용' 도장)
// 그 외(기본값) → 직원 발송본: 법정 기재사항(근로기준법 시행령 제27조의2)만
function renderWageSlipHtml(rec, opts = {}) {
    if (!opts.admin) return renderWageSlipEmployeeHtml(rec, opts);
    const e = emp(rec.employeeId) || {};
    const year = rec.year;
    const t = rec.totals;
    const h = rec.hours || { fixed: FIX_OT_LIMITS, actual: {} };
    const ytd = ytdFor(rec);
    const leave = leaveSummaryFor(e, year);
    const s = P.settings;
    const contact = [s.contactName && `${esc(s.contactName)}`, s.contactPhone && `☎ ${esc(s.contactPhone)}`, s.contactEmail && `✉ ${esc(s.contactEmail)}`].filter(Boolean);
    const nonTaxNames = ['meal', 'vehicle'].filter(k => num(rec.pay[k])).map(k => k === 'meal' ? '식대' : '차량유지비').join('·');

    return `<div class="ps-paper a4 adm">
        <div class="ps-admin-mark">관리자 보관용 · 직원 발송 안 됨</div>
        ${slipTopHtml('임금명세서', `${monthLabel(rec.month)} · 지급일 ${rec.payDate} · 발급일 ${opts.issueDate || ymdOfDate(new Date())}`, opts.stamp)}
        <div class="ps-body"><div class="ps-body-in">
        ${slipInfoHtml(rec)}

        <div class="ps-box pay">
            <div class="bt">① 급여 산출 내역</div>
            <div class="in">
                ${wagePayTableHtml(rec)}
                <div class="ps-taxline"><span>과세 ${won(t.taxable)}</span><span>비과세 ${won(t.nonTaxable)}${nonTaxNames ? ` (${nonTaxNames})` : ''}</span></div>
                ${wageProrateHtml(rec)}
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

        <div class="ps-netlines">
            <div><span>지급액 계</span><span>${won(t.pay)}</span></div>
            <div><span>공제액 계</span><span>− ${won(t.deduct)}</span></div>
            ${t.rounding ? `<div><span>단수 조정 <small>(10원 단위 반올림)</small></span><span>${t.rounding > 0 ? '+' : '−'} ${won(Math.abs(t.rounding))}</span></div>` : ''}
        </div>
        <div class="ps-big blue"><small>이번 달 실지급액</small><b>${won(t.payout)}<span>원</span></b></div>
        ${rec.bankAccount ? `<div class="ps-acct">입금 계좌: ${esc(maskAccount(rec.bankAccount))} (${esc(rec.name)})</div>` : '<div class="ps-acct"></div>'}

        <div class="ps-info2">
            <div class="ps-mini">
                <div class="h">${year}년 누계 (1~${Number(rec.month.slice(5))}월)</div>
                <div class="g"><span>지급액</span><span>${won(ytd.pay)}</span><span>공제액</span><span>${won(ytd.deduct)}</span><span>실지급액</span><span>${won(ytd.payout)}</span></div>
            </div>
            <div class="ps-mini leave">
                <div class="h">${year}년 연차 현황</div>
                ${leave ? `<div class="bar"><div style="width: ${leave.entitlement ? Math.min(100, Math.round(leave.used / leave.entitlement * 100)) : 0}%"></div></div>
                <div class="nums"><span>발생 <b>${formatDays(leave.entitlement)}</b></span><span>사용 <b>${formatDays(leave.used)}</b></span><span>잔여 <b class="ok">${formatDays(leave.remaining)}</b></span></div>
                <div class="ps-small">${ymdOfDate(new Date())} 기준</div>` : `<div class="ps-small">입사일 미등록</div>`}
            </div>
        </div>
        </div></div>

        <div class="ps-bottom">
            ${slipFootHtml(contact.length ? `<b>문의</b> ${contact.join(' · ')}` : '')}
            ${wageLegalHtml(rec, '본 명세서는 근로기준법 제48조 제2항에 따라 교부합니다.')}
        </div>
    </div>`;
}

// 직원 발송본 (메일 PDF) - 법정 기재사항만: 근로자 정보·지급일·항목별 금액·총액·공제내역·고정OT 시간과 계산방법
function renderWageSlipEmployeeHtml(rec, opts = {}) {
    return `<div class="ps-paper a4">
        ${slipTopHtml('임금명세서', `${monthLabel(rec.month)} · 지급일 ${rec.payDate} · 발급일 ${opts.issueDate || ymdOfDate(new Date())}`, opts.stamp)}
        <div class="ps-body"><div class="ps-body-in">
        ${slipInfoHtml(rec)}

        <div class="ps-box pay">
            <div class="bt">① 급여 산출 내역</div>
            <div class="in">
                ${wagePayTableHtml(rec)}
                ${wageProrateHtml(rec)}
            </div>
        </div>
        </div></div>

        <div class="ps-bottom">
            ${slipFootHtml('')}
            ${wageLegalHtml(rec, '')}
        </div>
    </div>`;
}

function wagePayTableHtml(rec) {
    const t = rec.totals;
    const payRows = PAY_ITEMS.filter(it => it.key === 'base' || num(rec.pay[it.key]))
        .map(it => [it.label + (it.note ? ` (${it.note})` : ''), rec.pay[it.key]]);
    const dedRows = DEDUCT_ITEMS.map(it => [it.label, rec.deduct[it.key] || 0])
        .concat((rec.etc || []).map(x => [x.name || '기타', x.amount]));
    const n = Math.max(payRows.length, dedRows.length);
    const rows = Array.from({ length: n }, (_, i) => {
        const p = payRows[i], d = dedRows[i];
        return `<tr><td>${p ? esc(p[0]) : ''}</td><td class="num">${p ? won(p[1]) : ''}</td><td>${d ? esc(d[0]) : ''}</td><td class="num">${d ? won(d[1]) : ''}</td></tr>`;
    }).join('');
    return `<table class="ps-tbl">
                    <tr><th colspan="2">지급</th><th colspan="2">공제</th></tr>
                    ${rows}
                    <tr class="tot"><th>지급액 계</th><th class="num">${won(t.pay)}</th><th>공제액 계</th><th class="num">${won(t.deduct)}</th></tr>
                </table>`;
}

function wageProrateHtml(rec) {
    return rec.prorate ? `<div class="ps-prorate">📅 <b>일할계산</b> · ${rec.prorate.start.slice(5)} ~ ${rec.prorate.end.slice(5)} 재직 ${rec.prorate.days}일 ÷ ${rec.prorate.monthDays}일 (입사·퇴사일 포함)</div>` : '';
}

// 법정 기재사항: 모든 사원 2줄 (제목 + 안내 한 줄) - 고정OT 표·계산식은 넣지 않음 (사용자 결정 2026-11-06)
function wageLegalHtml(rec, tail) {
    const body = rec.prorate ? `입사·퇴사한 달로 월급을 재직일수로 일할 계산했습니다.<br>` : `각 수당은 근로계약서에 정한 금액입니다.<br>`;
    return `<div class="ps-legal">
            <div class="lh">법정 기재사항 (근로기준법 제48조)</div>
            ${body}
            ${tail}
        </div>`;
}

// rec = 경비명세서 문서 (payroll_expenses)
function renderExpenseSlipHtml(rec) {
    const h = rec.hours || { fixed: FIX_OT_LIMITS, actual: {}, over: {} };
    const x = rec.expense || { lines: [], pay: 0, wage: 0 };
    const rateText = { overtime: '150%', holiday: '150% / 200%', night: '50%' };
    const calcRows = x.lines.map(l => `
        <div class="row"><span class="k">${OT_LABELS[l.bucket]} 초과</span>
            <span class="f">${fmtH(l.hours)} × ${won(x.wage)}원 × ${Math.round(l.rate * 100)}%</span><span class="v">${won(l.pay)}원</span></div>`).join('');
    const basis = x.annual ? `연봉 ${won(x.annual)} ÷ 12개월 ÷ ${STD_MONTH_HOURS}h` : (x.monthly ? `월급 ${won(x.monthly)} ÷ ${STD_MONTH_HOURS}h` : '등록된 시급');
    const s = P.settings;
    return `<div class="ps-paper exp a4">
        ${slipTopHtml('초과근무수당 지급명세서', `${monthLabel(rec.month)} · 지급일 ${rec.payDate} · 경비 지급`)}
        <div class="ps-body"><div class="ps-body-in">
        ${slipInfoHtml(rec)}

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
                    <div class="row"><span class="k">적용 시급</span><span class="f">${basis}</span><span class="v">${won(x.wage)}원</span></div>
                    ${calcRows || `<div class="row"><span class="k">초과 시간</span><span class="f">고정OT 범위 내</span><span class="v">0h</span></div>`}
                    <div class="row final"><span class="k">지급액</span><span class="f">합계 (10원 단위 반올림)</span><span class="v">${won(x.pay)}원</span></div>
                </div>
                <div class="ps-tip">
                    · 근로계약서의 고정 시간을 넘긴 근무에 대해 지급합니다.<br>
                    · 시급은 월급 기준(연봉÷12÷209)으로 적용하며, 금액은 10원 단위 반올림입니다.<br>
                    · 연장근로 결재 '승인' 건 기준이며, 급여와 별도로 경비로 지급됩니다.
                </div>
            </div>
        </div>

        <div class="ps-big org"><small>초과근무수당 지급액</small><b>${won(x.pay)}<span>원</span></b></div>
        <div class="ps-acct">${rec.year}년 누계 (1~${Number(rec.month.slice(5))}월): <b>${won(expenseYtd(rec))}원</b></div>
        </div></div>

        <div class="ps-bottom">
            ${slipFootHtml(s.contactName ? `<b>작성</b> ${esc(s.contactName)}` : '')}
        </div>
    </div>`;
}

// 수정본 도장: 이미 보낸 명세서를 고친 경우(재발송 전) 또는 수정본으로 재발송한 경우
function wageStampFor(rec) {
    if (rec.wageSentAt && rec.updatedAt > rec.wageSentAt) return msToDate(rec.updatedAt);
    if (rec.wageRevisedAt) return msToDate(rec.wageRevisedAt);
    return '';
}

// admin=true일 때만 관리자 보관용. 메일 발송은 admin을 넘기지 않으므로 항상 직원 발송본
function slipHtmlFor(rec, kind, admin = false) {
    return kind === 'wage' ? renderWageSlipHtml(rec, { stamp: wageStampFor(rec), admin }) : renderExpenseSlipHtml(rec);
}

// 보기: 임금명세서는 저장 전이면 지금 입력값으로 미리보기 / 경비명세서는 승인된 연장근로 기준
// admin=true → 오른쪽 맨 위 [관리자 확인용 명세서 보기], 그 외 → 직원 발송본 (메일로 나가는 모양)
let payDocCurrent = null;
function viewPayDoc(kind, admin = false) {
    if (kind === 'expense') {
        const x = P.expenses[P.selectedId];
        const mo = `${monthLabel(P.month)}`;
        payDocCurrent = x && x.requestCount ? { rec: x, kind } : null;
        document.getElementById('pay-doc-title').innerText = '경비명세서 (관리자 보관용)';
        document.getElementById('pay-doc-body').innerHTML = payDocCurrent
            ? slipHtmlFor(x, kind)
            : `<div class="pay-empty" style="background: #fff;">${mo} 승인된 연장근로 신청이 없어 경비명세서가 아직 없어요.<br>
                <small>${pendingRequests(P.selectedId).length ? '결재 대기 중인 신청이 있어요. 연장근로 결재 탭에서 승인하면 자동으로 만들어져요.' : '직원이 연장근로 신청을 제출하고 승인되면 자동으로 만들어져요.'}</small></div>`;
        document.getElementById('pay-doc-modal').style.display = 'flex';
        fitSlipBodies(document.getElementById('pay-doc-body'));
        return;
    }
    const unsaved = P.dirty || !P.records[P.selectedId];
    const rec = buildRecord(P.selectedId, unsaved);
    payDocCurrent = { rec, kind, admin };
    document.getElementById('pay-doc-title').innerText = admin ? '임금명세서 (관리자 확인용)' : '임금명세서 (직원 발송본)';
    const notes = (unsaved ? `<div class="pay-note warn" style="margin-bottom: 12px;">저장 전 미리보기입니다. 발송하려면 먼저 저장해 주세요.</div>` : '')
        + (admin ? '' : `<div class="pay-note blue" style="margin-bottom: 12px;">📧 직원에게는 이 모양 그대로 암호 PDF로 발송돼요.</div>`);
    document.getElementById('pay-doc-body').innerHTML = notes + slipHtmlFor(rec, kind, admin);
    document.getElementById('pay-doc-modal').style.display = 'flex';
    fitSlipBodies(document.getElementById('pay-doc-body'));
}
function closePayDoc() { document.getElementById('pay-doc-modal').style.display = 'none'; }

// 임금명세서는 A4 한 장 고정: 위(제목·날짜)·아래(인사말~법정 기재사항)는 그대로,
// 가운데 내용(.ps-body-in)이 남는 칸보다 길면 그 비율만큼만 줄여서 한 장에 맞춤 (화면에 보이는 상태에서 호출)
function fitSlipBodies(root) {
    root.querySelectorAll('.ps-paper.a4').forEach(paper => {
        const body = paper.querySelector('.ps-body'), inner = paper.querySelector('.ps-body-in');
        if (!body || !inner) return;
        inner.style.transform = '';
        const s = body.clientHeight / inner.offsetHeight;
        if (s < 1) inner.style.transform = `scale(${s.toFixed(4)})`;   // 모양 그대로 비율만 축소 (가운데 정렬)
    });
}

// 명세서 인쇄: 관리자 화면의 인쇄 설정(연장근로·연차용 @page 등)과 섞이지 않게 숨은 iframe에서 따로 인쇄
// A4 한 장(210×296mm) 칸 정중앙에 명세서(700×990px ≈ 185×262mm)를 놓아 위아래 여백이 같고 항상 1장
function printPayDoc() {
    if (!payDocCurrent) return;
    const old = document.getElementById('pay-print-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'pay-print-frame';
    frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>명세서</title>
        <link rel="stylesheet" href="${new URL('css/payroll.css', location.href).href}">
        <style>
            @page { size: A4; margin: 0; }
            html, body { margin: 0; padding: 0; background: #fff; }
            .sheet { width: 210mm; height: 296mm; overflow: hidden; display: flex; align-items: center; justify-content: center; }
            .sheet .ps-paper { width: 700px !important; margin: 0 !important; flex: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style></head>
        <body><div class="sheet">${slipHtmlFor(payDocCurrent.rec, payDocCurrent.kind, payDocCurrent.admin)}</div></body></html>`);
    doc.close();
    // 보기 창에서 맞춘 가운데 축소 비율을 그대로 사용
    const shown = document.querySelector('#pay-doc-body .ps-body-in'), target = doc.querySelector('.ps-body-in');
    if (shown && target) target.style.transform = shown.style.transform;
    const link = doc.querySelector('link');
    const waits = [new Promise(resolve => { if (link.sheet) resolve(); else link.onload = link.onerror = resolve; })]
        .concat(Array.from(doc.images).map(img => img.complete ? Promise.resolve()
            : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    Promise.all(waits).then(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    });
}

// ------------------------------------------
// 메일 발송 (Vercel 서버 /api/send-payslip → 생년월일 6자리 암호 PDF를 관리자 Gmail로 발송)
// ------------------------------------------
function captureSlipImage(html) {
    const box = document.getElementById('pay-capture');
    box.innerHTML = html;
    fitSlipBodies(box);
    const images = Array.from(box.querySelectorAll('img'));
    return Promise.all(images.map(img => img.complete ? Promise.resolve()
        : new Promise(resolve => { img.onload = img.onerror = resolve; })))
        // 4배 캡처(A4 약 500dpi) + PNG(무손실) - JPEG는 글자·표 선 주변이 뭉개져 흐릿해 보임
        .then(() => html2canvas(box.firstElementChild, { scale: 4, backgroundColor: '#ffffff', useCORS: true }))
        .then(canvas => {
            box.innerHTML = '';
            const png = canvas.toDataURL('image/png');
            // Vercel 서버 요청 한도(4.5MB) 안전장치: 너무 크면 고화질 JPEG로
            return png.length < 4000000 ? png : canvas.toDataURL('image/jpeg', 0.97);
        });
}

function logPaySend(rec, kind, ok, error, revised) {
    return db.collection("payroll_send_logs").add({
        at: Date.now(), month: rec.month, employeeId: rec.employeeId, name: rec.name,
        kind, revised: !!revised, ok, error: error || ''
    }).catch(err => console.error("발송 이력 저장 실패:", err));
}

// 1명 · 1종 발송
function sendPayDocCore(empId, kind) {
    const rec = kind === 'wage' ? buildRecord(empId, false) : P.expenses[empId];
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
    const text = `${rec.name}님,\n\n${y}년 ${Number(m)}월분 ${kind === 'wage' ? '임금명세서' : '초과근무수당 지급명세서'}${revised ? '(수정본)' : ''}를 보내드립니다.\n\n첨부된 PDF는 생년월일 6자리(예: 900101)로 열 수 있습니다.\n\n귀하의 노고에 감사드립니다.\n${P.settings.companyName} 관리부`;

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
            const col = kind === 'wage' ? "payroll_records" : "payroll_expenses";
            return db.collection(col).doc(recordId(rec.month, empId)).update(update).then(() => {
                Object.assign(kind === 'wage' ? P.records[empId] : P.expenses[empId], update);
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
        const resend = kind === 'wage' ? P.records[empId].wageSentAt : P.expenses[empId].expenseSentAt;
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
    if (kind === 'expense') {
        if (!(P.expenses[empId] && P.expenses[empId].requestCount)) { alert("승인된 연장근로 신청이 없어 보낼 경비명세서가 없습니다."); return; }
        go();
        return;
    }
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
    const source = kind === 'wage' ? P.yearRecords : P.yearExpenses.filter(x => x.requestCount > 0);
    const recs = (scope === 'year' ? source : source.filter(r => r.month === P.month))
        .slice().sort((a, b) => a.month.localeCompare(b.month) || (a.name || '').localeCompare(b.name || '', 'ko'));
    if (recs.length === 0) { alert(kind === 'wage' ? "저장된 급여가 없습니다." : "승인된 경비(초과근무수당)가 없습니다."); return; }

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
            row['차인지급액'] = r.totals.net;
            row['단수조정'] = r.totals.rounding;
            row['실지급액'] = r.totals.payout;
            ['overtime', 'holiday', 'night'].forEach(k => { row[`${OT_LABELS[k]} 실근로(h)`] = Math.round(((r.hours && r.hours.actual[k]) || 0) * 10) / 10; });
            row['일할'] = r.prorate ? `${r.prorate.days}/${r.prorate.monthDays}` : '';
            row['공제 출처'] = r.deductSource === 'accounting' ? '회계사무소' : (r.deductSource === 'manual' ? '직접 입력' : '자동 예상');
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
