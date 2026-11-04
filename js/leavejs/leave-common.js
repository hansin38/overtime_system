// ==========================================
// leave-common.js (연차 공통 규칙·휴가신청서 양식)
// 사원 연차신청 / 결재자 서명 / 관리자 연차관리 화면이 함께 사용
// ⚠️ 공휴일 목록(holidays)은 js/ot-rules.js에서 공통 관리 (이 파일보다 먼저 로드)
// ==========================================

const COMPANY_NAME = "(주)한신컨설턴트"; // 휴가신청서 인쇄 상단 회사명

// 휴가 종류 - deduct: 잔여 연차에서 차감 여부 (년차·월차만 차감)
const LEAVE_TYPES = {
    annual:  { label: '년차',     deduct: true },
    monthly: { label: '월차',     deduct: true },
    summer:  { label: '여름휴가', deduct: false },
    family:  { label: '경조사',   deduct: false },
    etc:     { label: '기타',     deduct: false }
};
const HALF_LABELS = { full: '전일', am: '오전반차', pm: '오후반차' };
const ACTIVE_STATUSES = ["대기", "승인", "재전송"]; // 사용량·중복 체크에 포함되는 상태
const WEEKDAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

// ✍️ 결재칸 (둘 중 1명만 서명해도 승인) / 서명 요청 링크 유효시간
// 서명 링크는 신청서당 1개 - 받은 사람이 비어 있는 칸을 골라 서명
const SIGN_SLOTS = { director: '전 무', manager: '과 장' };
const SIGN_LINK_HOURS = 3;

// 휴가 종류가 없는 예전 신청서는 년차로 간주
function isDeductible(data) {
    const t = LEAVE_TYPES[data.leaveType];
    return t ? t.deduct : true;
}
function leaveTypeLabel(data) {
    if (!data.leaveType) return '년차';
    if (data.leaveType === 'etc') return data.leaveTypeEtc ? `기타(${data.leaveTypeEtc})` : '기타';
    return LEAVE_TYPES[data.leaveType]?.label || data.leaveType;
}
function formatDays(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 날짜 도우미 (YYYY-MM-DD 문자열을 시간대 영향 없이 다룸)
const pad2 = (n) => String(n).padStart(2, '0');
function parseYmd(ymd) { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); }
function toYmd(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
function isOffDay(ymd) {
    const day = parseYmd(ymd).getDay();
    return day === 0 || day === 6 || holidays.includes(ymd);
}
function formatKoreanDate(ymd) {
    const dt = parseYmd(ymd);
    return `${dt.getFullYear()}년 ${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEKDAY_NAMES[dt.getDay()]}요일)`;
}
// 반차 표시: 하루면 "오전반차", 여러 날이면 "(첫날 오후반차)" / "(마지막 날 오전반차)"
function halfDayNote(d) {
    if (!d.halfDay || d.halfDay === 'full') return '';
    if (d.startDate === d.endDate) return ` ${HALF_LABELS[d.halfDay]}`;
    return d.halfDay === 'pm' ? ' (첫날 오후반차)' : ' (마지막 날 오전반차)';
}
function periodSummary(d) {
    if (!d.startDate) return '-';
    if (d.startDate === d.endDate) return `${d.startDate}${halfDayNote(d)}`;
    return `${d.startDate} ~ ${d.endDate}${halfDayNote(d)}`;
}

/**
 * 입사일자와 회계연도를 기준으로 해당 연도의 "발생 연차 일수"를 계산합니다.
 * - 입사 연도: 입사월부터 12월까지 근무 개월수만큼 부여 (최대 11일) = 월차
 * - 1년 이상 근속: 15일, 3년차부터 2년마다 1일씩 가산 (최대 25일) - 근로기준법 제60조 기준
 * 회사의 실제 취업규칙과 다를 수 있으니, 정책이 다르면 이 함수만 수정하면 됩니다.
 */
function calcAnnualLeaveEntitlement(hireDateStr, fiscalYear) {
    if (!hireDateStr) return 0;
    const hireDate = new Date(hireDateStr);
    if (isNaN(hireDate.getTime())) return 0;

    const hireYear = hireDate.getFullYear();
    const hireMonth = hireDate.getMonth() + 1; // 1~12

    if (fiscalYear < hireYear) return 0;

    if (fiscalYear === hireYear) {
        // 입사 연도: 입사월 포함 12월까지 근무 개월수 (최대 11일)
        const monthsWorked = 12 - hireMonth + 1;
        return Math.max(0, Math.min(monthsWorked, 11));
    }

    // 만 1년 이상 근속: (해당 회계연도 1/1 기준) 근속 연수
    const serviceYears = fiscalYear - hireYear;
    const entitlement = 15 + Math.floor((serviceYears - 1) / 2);
    return Math.min(entitlement, 25);
}

// -----------------------------------------------------------------
// 월별 사용 현황 (년차·월차 누적) - requests: 한 사원의 [{ id, data }]
// -----------------------------------------------------------------
function computeMonthlyUsage(year, requests) {
    const items = [];
    requests.forEach(({ id, data }) => {
        if (data.fiscalYear !== year || !ACTIVE_STATUSES.includes(data.status) || !isDeductible(data)) return;
        (data.detailLogs || []).forEach(log => items.push({ ...log, reqId: id, pending: data.status !== "승인" }));
    });
    items.sort((a, b) => a.date.localeCompare(b.date));

    // 신청서 단위로 묶고, 괄호에 누적 사용일수 표시
    const months = Array.from({ length: 12 }, () => []);
    let cumulative = 0;
    items.forEach(item => {
        cumulative += item.days;
        const m = Number(item.date.slice(5, 7)) - 1;
        const day = Number(item.date.slice(8, 10));
        const last = months[m][months[m].length - 1];
        if (last && last.reqId === item.reqId) {
            last.lastDay = day;
            last.cumulative = cumulative;
        } else {
            months[m].push({ reqId: item.reqId, firstDay: day, lastDay: day, half: item.type !== 'full', cumulative, pending: item.pending });
        }
    });
    return months;
}

function renderMonthlyTableHtml(year, requests, tableClass) {
    const months = computeMonthlyUsage(year, requests);
    const head = months.map((_, i) => `<th>${i + 1}월</th>`).join('');
    const cells = months.map(entries => `<td>${entries.map(e => {
        const dayText = e.firstDay === e.lastDay ? `${e.firstDay}일${e.half ? '(반)' : ''}` : `${e.firstDay}~${e.lastDay}일`;
        return `<div class="${e.pending ? 'leave-pending' : ''}">${dayText}<br>(${formatDays(e.cumulative)})</div>`;
    }).join('')}</td>`).join('');
    return `<table class="${tableClass}"><thead><tr>${head}</tr></thead><tbody><tr>${cells}</tr></tbody></table>`;
}

// -----------------------------------------------------------------
// 휴가신청서 양식 (종이 양식과 같은 배치)
// options.signable: 결재자 서명 화면 → 비어 있는 결재칸을 강조하고 클릭 시 openSignPad(칸) 호출
// -----------------------------------------------------------------
function signatureDateText(sign) {
    if (!sign || !sign.signedAt) return '/';
    const dt = sign.signedAt.toDate ? sign.signedAt.toDate() : new Date(sign.signedAt);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

// 결재란 표 (휴가신청서·작성자 화면 공용)
function renderApprovalTableHtml(signatures, signable) {
    const signs = signatures || {};
    const signCells = Object.keys(SIGN_SLOTS).map(slot => {
        const sign = signs[slot];
        if (sign && sign.img) return `<td><img src="${sign.img}" alt="서명"></td>`;
        if (signable) return `<td class="lp-sign-target" onclick="openSignPad('${slot}')">👉 여기를 눌러<br>서명하세요</td>`;
        return `<td></td>`;
    }).join('');
    return `
        <table class="lp-approval">
            <tr><th rowspan="3" class="lp-approval-label">결<br><br>재</th>${Object.values(SIGN_SLOTS).map(l => `<th>${l}</th>`).join('')}</tr>
            <tr class="lp-sign-row">${signCells}</tr>
            <tr>${Object.keys(SIGN_SLOTS).map(slot => `<td>${signatureDateText(signs[slot])}</td>`).join('')}</tr>
        </table>`;
}

function renderLeaveSheetHtml(data, requests, options = {}) {
    const submitted = data.submittedAt?.toDate ? data.submittedAt.toDate() : new Date();
    const submittedText = `${submitted.getFullYear()}. ${pad2(submitted.getMonth() + 1)}. ${pad2(submitted.getDate())}.`;
    const dept = data.department || '';
    const position = data.position || '';

    const typeBoxes = Object.keys(LEAVE_TYPES).map(key => {
        const mark = (data.leaveType || 'annual') === key ? '■' : '□';
        const label = key === 'etc' ? `기 타 ( ${data.leaveType === 'etc' ? (data.leaveTypeEtc || '') : '　　'} )` : LEAVE_TYPES[key].label;
        return `<span class="lp-type">${mark} ${label}</span>`;
    }).join('');

    let periodText = '-';
    if (data.startDate) {
        periodText = data.startDate === data.endDate
            ? `${formatKoreanDate(data.startDate)}${halfDayNote(data)}`
            : `${formatKoreanDate(data.startDate)} ~ ${formatKoreanDate(data.endDate)}${halfDayNote(data)}`;
        periodText += `　　${formatDays(data.totalDays || 0)}일 간`;
    }

    return `
        <div class="lp-sheet">
            <table class="lp-header">
                <tr>
                    <td class="lp-company" rowspan="4">${COMPANY_NAME}</td>
                    <td class="lp-title" rowspan="4">휴 가 신 청 서</td>
                    <th>문서번호</th><td></td>
                </tr>
                <tr><th>페이지번호</th><td>1/1페이지</td></tr>
                <tr><th>작 성 자</th><td>${data.employeeName || ''}</td></tr>
                <tr><th>작성일자</th><td>${submittedText}</td></tr>
            </table>

            <div class="lp-approval-row">
                <p>아래와 같은 사유로 휴가신청서를 제출합니다.</p>
                ${renderApprovalTableHtml(data.signatures, options.signable)}
            </div>

            <table class="lp-main">
                <tr><th>소　　속</th><td>${dept}</td></tr>
                <tr><th>성　　명</th><td>${data.employeeName || ''}</td></tr>
                <tr><th>직　　위</th><td>${position}</td></tr>
                <tr><th>휴가 종류</th><td><div class="lp-types">${typeBoxes}</div></td></tr>
                <tr><th>휴가 사유</th><td>${data.reason || ''}</td></tr>
                <tr><th>휴가 기간</th><td>${periodText}</td></tr>
                <tr><th>비상연락처</th><td>${data.emergencyContact || ''}</td></tr>
            </table>

            ${renderMonthlyTableHtml(data.fiscalYear || new Date().getFullYear(), requests, 'lp-monthly')}

            <p class="lp-request">위와 같이 휴가를 신청하오니 허락하여 주시기 바랍니다.</p>
            <p class="lp-date">${submitted.getFullYear()} 년　${submitted.getMonth() + 1} 월　${submitted.getDate()} 일</p>
            <div class="lp-signer">
                <div>소　속 : ${dept}</div>
                <div>성　명 : ${data.employeeName || ''}　(서명 생략)</div>
            </div>
        </div>
    `;
}
