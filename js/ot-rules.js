// ==========================================
// 연장근로 공통 규칙 (사원/관리자 화면 공용)
// 공휴일·고정OT·가산율은 이 파일 한 곳에서만 수정
// ==========================================

// 공휴일·대체공휴일·노동절 (유급휴일) - 「관공서의 공휴일에 관한 규정」 기준, 매년 다음 해 날짜 추가
const holidays = [
    // 2026
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-03-01", "2026-03-02", "2026-05-01", "2026-05-05", "2026-05-24", "2026-05-25", "2026-06-03", "2026-06-06", "2026-07-17", "2026-08-15", "2026-08-17", "2026-09-24", "2026-09-25", "2026-09-26", "2026-10-03", "2026-10-05", "2026-10-09", "2026-12-25",
    // 2027
    "2027-01-01", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09", "2027-03-01", "2027-05-01", "2027-05-03", "2027-05-05", "2027-05-13", "2027-06-06", "2027-07-17", "2027-07-19", "2027-08-15", "2027-08-16", "2027-09-14", "2027-09-15", "2027-09-16", "2027-10-03", "2027-10-04", "2027-10-09", "2027-10-11", "2027-12-25", "2027-12-27"
];

// 💰 고정OT (근로계약서 기준) - 구분별로 고정시간을 넘긴 시간만 수당 지급
// - 연장: 65.5시간(150% 환산) = 43.67시간 → 근무가 0.5시간 단위라 43.5시간 적용 / 휴일: 9시간 / 야간: 11시간 (야간 가산 50%분만)
// - 야간 시간은 연장(또는 휴일)과 야간 양쪽에서 함께 차감됨
const FIX_OT_LIMITS = { overtime: 43.5, holiday: 9, night: 11 };

// 사원별 고정OT (사원등록의 fixedOt 값, 없으면 기본값) - 근로계약서마다 시간이 다를 수 있음
function getFixOtLimits(emp) {
    const fixed = (emp && emp.fixedOt) || {};
    const pick = (k) => {
        const n = parseFloat(fixed[k]);
        return isNaN(n) || n < 0 ? FIX_OT_LIMITS[k] : n;
    };
    return { overtime: pick('overtime'), holiday: pick('holiday'), night: pick('night') };
}

// 근무 1건을 { 고정OT 구분, 가산율, 시간 } 조각으로 분리 (야간 50%는 별도 조각)
// - 평일·토요일(무급휴무일): 연장 150% + 야간(22:00~06:00) 50%
// - 일요일/공휴일: 출근 후 실근무 8시간까지 휴일 150%, 8시간 초과분 휴일 200% + 야간(22:00~06:00) 50%
// (점심 12:00~13:00, 저녁 18:00~18:30 공제는 사원 화면 시간 계산과 동일)
function splitWorkLog(log) {
    if (!log.date || !log.start || !log.end) return [];
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const sMin = toMin(log.start);
    let eMin = toMin(log.end);
    if (eMin < sMin) eMin += 24 * 60;
    const overlap = (from, to) => Math.max(0, Math.min(eMin, to) - Math.max(sMin, from)) / 60;
    const nightPart = { bucket: 'night', rate: 0.5, hours: overlap(1320, 1800) }; // 22:00~다음날 06:00

    if (log.type !== 'weekend') {
        return [{ bucket: 'overtime', rate: 1.5, hours: overlap(0, Infinity) }, nightPart];
    }

    let workHours = (eMin - sMin) / 60;
    if (sMin <= 720 && eMin >= 780) workHours -= 1;
    if (sMin < 1080 && eMin > 1080) workHours -= 0.5;

    // 토요일은 연장근로로 연장 고정시간에서 차감, 일요일·공휴일만 휴일 9h에서 차감
    const isSaturday = new Date(log.date).getDay() === 6 && !holidays.includes(log.date);
    if (isSaturday) {
        return [{ bucket: 'overtime', rate: 1.5, hours: workHours }, nightPart];
    }
    return [
        { bucket: 'holiday', rate: 1.5, hours: Math.min(workHours, 8) },
        { bucket: 'holiday', rate: 2.0, hours: Math.max(0, workHours - 8) },
        nightPart
    ];
}
