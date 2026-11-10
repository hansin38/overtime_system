// ==========================================
// 💵 급여 관리 ① 공통 (payroll-core.js) - 상수 · 상태(P) · 도우미 · 급여/공제/경비 계산식
// - 기본정보(employees): 이름·전화 뒷4자리·사원번호·부서·직급·입사/퇴사일·고정OT → 직원 로그인·연장근로·연차와 공유
// - 🔒 급여정보(payroll_profiles): 생년월일·이메일·계좌·급여조건·4대보험 기준 → 관리자 로그인 시에만 읽기/쓰기
// - 월별 급여(payroll_records, 문서ID "YYYY-MM_사원ID"): 저장 시점 금액을 그대로 보관 (명세서는 이 값으로 출력)
// - 공제는 회계사무소 급여대장을 불러와 그대로 반영 (불러오기 전에는 자동 예상값)
// - 초과근무수당은 경비로 별도 지급 → 임금명세서에는 넣지 않고 경비명세서(관리자 보관, 발송은 선택)에만 표시
//
// 📂 급여 관리 파일 (admin.html에서 이 순서로 불러옴, 함수는 모두 전역이라 서로 부를 수 있음)
//   ① payroll-core.js     상수 · 상태(P) · 도우미 · 계산식 (급여·공제·경비)  ← 계산은 여기 한 곳에만
//   ② payroll-month.js    탭 열기·데이터 로드 · 이번 달 급여 · 연간 현황 · 회사 정보
//   ③ payroll-employee.js 사원 정보 화면 · 사원 등록/수정 · 사원정보 엑셀 받기/올리기
//   ④ payroll-import.js   회계사무소 급여대장 불러오기 · 🔍 검수
//   ⑤ payroll-slip.js     명세서 HTML · 메일 발송 · 일괄 발송 · 임금/경비대장 엑셀
// 새 탭은 새 파일(⑥ …)로 만들고 admin.html에 ⑤ 다음 줄로 추가, 쓰는 상태는 P에 선언
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
    otAll: [],            // 연장근로 신청 전체 (결재 대기 예상 금액용)
    expenses: {},         // 선택 월 경비(초과근무수당) { 사원ID: payroll_expenses 문서 }
    yearExpenses: [],
    manualEntry: {},      // 급여대장 없이 직접 입력하기로 연 사원 { 'YYYY-MM|사원ID': true }
    // 📥 급여대장 불러오기 · 🔍 검수 (payroll-import.js)
    importRows: [],       // 사원별 대조 결과
    importMeta: null,     // { accMonth, unknown }
    auditSel: null,       // 검수 보드에서 고른 사원ID
    // 📄📤 사원정보 엑셀 (payroll-employee.js)
    empXlRows: [],        // 올린 엑셀 미리보기 줄
    empXlTemplate: undefined   // 올린 엑셀 양식 (undefined = 아직 안 읽음, null = 없음)
};
// ※ 새 탭·기능을 만들 때 쓰는 상태는 여기에 이름과 설명을 추가해 주세요 (다른 파일에서 같은 이름을 쓰지 않도록)

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
// 초과수당(경비) 시급 = 기본은 월급÷209(연봉형은 연봉÷12÷209), 사원 정보에서 '통상시급'을 고른 연봉형 사원만 통상시급(고정OT 시급)
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
    // 경비(초과근무수당) 시급: 기본은 월급÷209, 사원 정보에서 '통상시급'을 고른 사원만 통상시급(고정OT 시급)
    const ordinaryBasis = profile.expenseWageBasis === 'ordinary';
    const monthly = Math.round(monthlyRaw);
    const pay = { ...emptyPay(), ...allow };
    pay.overtime = Math.round(ordinaryWage * weighted.overtime);
    const holidayNight = Math.round(ordinaryWage * (weighted.holiday + weighted.night));
    pay.holiday = Math.round(ordinaryWage * weighted.holiday);
    pay.night = holidayNight - pay.holiday;
    pay.base = monthly - pay.meal - pay.vehicle - pay.position - pay.site - pay.overtime - holidayNight;
    return { type: 'annual', annual, monthly, monthlyRaw, bonusMonthly, ordinaryWage, ordinaryBasis,
        expenseWage: ordinaryBasis ? ordinaryWage : monthlyRaw / STD_MONTH_HOURS, fixed, weighted, totalHours, pay };
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

// 1회 설정 (2026-11-06): 경비 시급은 월급÷209가 기본, 이 사원들만 통상시급(고정OT 시급)
// 관리자 로그인 상태에서 아직 설정이 없을 때만 저장 → 이후 사원 정보에서 바꾼 값은 건드리지 않음
const EXPENSE_ORDINARY_BASIS_NAMES = ['최성욱', '김경범', '장용덕'];
function applyExpenseBasisDefaults(profiles, employees) {
    const jobs = employees.filter(e => EXPENSE_ORDINARY_BASIS_NAMES.includes((e.name || '').trim()))
        .filter(e => !(profiles[e.id] || {}).expenseWageBasis)
        .map(e => {
            profiles[e.id] = { ...(profiles[e.id] || {}), expenseWageBasis: 'ordinary' };
            return db.collection("payroll_profiles").doc(e.id).set({ expenseWageBasis: 'ordinary' }, { merge: true });
        });
    return Promise.all(jobs).catch(err => console.error("경비 시급 기준 설정 실패:", err));
}

// ★ 경비(초과근무수당) 시급 - 하나의 계산: 급여 관리와 연장근로 결재 화면(js/admin.js)이 함께 씀
//   profile = payroll_profiles 문서, ym 을 주면 그 달 급여조건(연봉 인상 이력) 기준
//   연봉형: 통상시급(기본) 또는 연봉÷12÷209(사원 정보에서 월급÷209 선택) · 고정 금액형: 월급÷209
//   급여조건 미등록: 예전 통상시급 → 10,000원
function expenseWageInfo(profile, employee, ym) {
    const cond = ym ? condFor(profile || {}, ym) : (profile || {});
    const s = calcPayStructure(cond, employee || {});
    if (s) return { wage: s.expenseWage, label: s.type === 'annual' ? (s.ordinaryBasis ? '통상시급' : '연봉÷12÷209') : '월급÷209', ordinary: s.type === 'annual' && s.ordinaryBasis };
    const legacy = Number(cond.legacyHourlyWage);
    return { wage: legacy > 0 ? legacy : 10000, label: legacy > 0 ? '예전 통상시급' : '급여조건 미등록', ordinary: false };
}

// 그 달 실근로시간·초과수당(경비) 계산 (requests = 그 사원의 연장근로 신청들, 귀속 월로 거름)
// cond = 그 달 급여조건 (연봉 인상 이력 반영)
function calcOvertimeFor(employee, cond, requests, ym) {
    const structure = calcPayStructure(cond, employee);
    const wage = expenseWageInfo(cond, employee).wage;
    const limits = getFixOtLimits(employee);
    const mine = requests.filter(r => r.employeeName === employee.name && r.employeePhone === employee.phoneLast4 && requestMonth(r) === ym);
    const result = calculateOvertimePay(mine.flatMap(r => r.detailLogs || []), wage, limits);
    return {
        wage, limits, count: mine.length,
        basis: structure ? (structure.type === 'annual' ? { annual: structure.annual, ordinary: !!structure.ordinaryBasis } : { monthly: structure.monthly }) : {},
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
const STATUS_TEXT = { wait: '급여대장 미등록', save: '저장됨', sent: '발송완료', revised: '수정됨 (재발송 필요)' };

