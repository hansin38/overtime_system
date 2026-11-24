// 연장근로 신청 확인서 양식 - 직원 화면(employee.html) 상세보기·인쇄와 관리자 화면(admin.html) 상세보기 인쇄가 함께 씀
// (양식을 고치면 두 화면이 같이 바뀜, 모양은 css/style.css 의 .ot-sheet)

const OT_COMPANY_NAME = "(주)한신콘설탄트";
const OT_COMPANY_LOGO = "/images/hanshin-logo.png";

function escapeOtHtml(text) {
    return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// 진행 상태 칸: 네 가지 중 해당 상태만 ■ 표시 (재전송 = 반송 후 재작성해서 다시 제출한 건)
const OT_STATUS_BOXES = [
    { label: '승인',   statuses: ['승인'] },
    { label: '반송',   statuses: ['반송'] },
    { label: '작성',   statuses: ['작성'] },
    { label: '재작성', statuses: ['재전송'] }
];

// 연장근로 신청 확인서 양식 (화면 상세보기·인쇄 공용)
function renderOvertimeSheetHtml(data) {
    const submitted = data.submittedAt?.toDate ? data.submittedAt.toDate() : new Date();
    const pad = n => String(n).padStart(2, '0');
    const submittedText = `${submitted.getFullYear()}. ${pad(submitted.getMonth() + 1)}. ${pad(submitted.getDate())}.`;
    const name = escapeOtHtml(data.employeeName || '');
    const logs = Array.isArray(data.detailLogs) ? data.detailLogs : [];
    const totalH = logs.reduce((sum, log) => sum + (parseFloat(log.hours) || 0), 0);

    const rows = logs.length
        ? logs.map(log => `
            <tr>
                <td>${escapeOtHtml(log.date || '-')}</td>
                <td>${log.type === 'weekday' ? '평일 야근' : '주말/공휴일'}</td>
                <td>${escapeOtHtml(log.start || '-')}</td>
                <td>${escapeOtHtml(log.end || '-')}</td>
                <td class="ot-reason">${escapeOtHtml(log.reason || log.memo || '-')}</td>
                <td>${(parseFloat(log.hours) || 0).toFixed(1)}</td>
            </tr>`).join('')
        : `<tr><td colspan="6">상세 내역이 없습니다.</td></tr>`;

    const status = data.status || '작성';
    const statusBoxes = OT_STATUS_BOXES.map(box =>
        `<span class="ot-status${box.statuses.includes(status) ? ' on' : ''}">${box.statuses.includes(status) ? '■' : '□'} ${box.label}</span>`
    ).join('');
    const statusPill = status === '재전송' ? '재작성' : status;

    // 머리글(로고·문서정보 / 제목)은 B안, 본문(신청인·요약 3칸·가로줄 표)은 E안
    return `
        <div class="ot-sheet">
            <div class="ot-top">
                <img class="ot-logo" src="${OT_COMPANY_LOGO}" alt="${OT_COMPANY_NAME}">
                <div class="ot-title">연장근로 신청 확인서</div>
                <div class="ot-meta">문서번호　-<br>작성일자　${submittedText}</div>
            </div>

            <div class="ot-name"><span>신청인</span><b>${name}</b><span class="ot-pill">${escapeOtHtml(statusPill)}</span></div>
            <div class="ot-subject">${escapeOtHtml(data.title || '제목 없음')}</div>

            <div class="ot-stats">
                <div><small>총 연장근로</small><strong>${totalH.toFixed(1)}<em>시간</em></strong></div>
                <div><small>근로 일수</small><strong>${logs.length}<em>건</em></strong></div>
                <div><small>진행 상태</small><div class="ot-statuses">${statusBoxes}</div></div>
            </div>

            <table class="ot-items">
                <thead>
                    <tr><th style="width:16%;">날짜</th><th style="width:15%;">구분</th><th style="width:10%;">시작</th><th style="width:10%;">종료</th><th>사유</th><th style="width:10%;">시간</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>

            <p class="ot-lead">위와 같이 연장근로 내역을 제출합니다.</p>
            <p class="ot-date">${submitted.getFullYear()}년 ${submitted.getMonth() + 1}월 ${submitted.getDate()}일</p>
            <div class="ot-signer">신청인<br><b>${name}</b>　(서명 생략)</div>
        </div>
    `;
}