// 연장근로 신청 확인서 양식 - 직원 화면(employee.html)과 관리자 화면(admin.html)이 함께 씀
// (양식을 고치면 두 화면이 같이 바뀜, 모양은 css/style.css 의 .ot-sheet)
// - 화면 상세보기: renderOvertimeSheetHtml(data)
// - 인쇄: printOvertimeSheetA4(data) → 경비명세서와 같은 폭(700px)·로고 비율, 내역이 길면 축소 없이 다음 장으로 넘김

const OT_COMPANY_NAME = "(주)한신콘설탄트";
const OT_COMPANY_LOGO = "/images/hanshin-logo.png";

function escapeOtHtml(text) {
    return String(text ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// 진행 상태는 요약 칸에만 표시 (이름 옆 표시는 겹쳐서 뺌)
// 진행 상태 칸: 네 가지 중 해당 상태만 ■ 표시 (재전송 = 반송 후 재작성해서 다시 제출한 건)
const OT_STATUS_BOXES = [
    { label: '승인',   statuses: ['승인'] },
    { label: '반송',   statuses: ['반송'] },
    { label: '작성',   statuses: ['작성'] },
    { label: '재작성', statuses: ['재전송'] }
];

// opts.a4 = true → 인쇄용 A4 틀 (위·가운데·아래 3칸)
function renderOvertimeSheetHtml(data, opts = {}) {
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

    const top = `
            <div class="ot-top">
                <img class="ot-logo" src="${OT_COMPANY_LOGO}" alt="${OT_COMPANY_NAME}">
                <div class="ot-title">연장근로 신청 확인서</div>
                <div></div>
            </div>`;
    const body = `
            <div class="ot-name"><span>성명</span><b>${name}</b><span class="ot-meta">작성일자　${submittedText}</span></div>

            <div class="ot-stats">
                <div><small>총 연장근로</small><strong>${totalH.toFixed(1)}<em>시간</em></strong></div>
                <div><small>근로 일수</small><strong>${logs.length}<em>건</em></strong></div>
                <div><small>진행 상태</small><div class="ot-statuses">${statusBoxes}</div></div>
            </div>

            <div class="ot-subject"><span>제목</span>${escapeOtHtml(data.title || '제목 없음')}</div>
            <table class="ot-items">
                <thead>
                    <tr><th style="width:16%;">날짜</th><th style="width:15%;">구분</th><th style="width:10%;">시작</th><th style="width:10%;">종료</th><th>사유</th><th style="width:10%;">시간</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>`;
    const bottom = `
            <p class="ot-lead">위와 같이 연장근로 내역을 제출합니다.</p>
            <p class="ot-date">${submitted.getFullYear()}년 ${submitted.getMonth() + 1}월 ${submitted.getDate()}일</p>
            <div class="ot-signer"><span>성명</span><b>${name}</b>(서명 생략)</div>`;

    if (opts.a4) {
        return `<div class="ot-sheet ot-a4">${top}
            <div class="ot-body"><div class="ot-body-in">${body}</div></div>
            <div class="ot-bottom">${bottom}</div>
        </div>`;
    }
    return `<div class="ot-sheet">${top}${body}${bottom}</div>`;
}

// 🖨️ 인쇄: 따로 만든 인쇄 창(iframe)에서 A4 가로 가운데로 (급여 관리 명세서 인쇄와 같은 방식)
function printOvertimeSheetA4(data) {
    const old = document.getElementById('ot-print-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'ot-print-frame';
    frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>연장근로 신청 확인서 - ${escapeOtHtml(data.employeeName || '')}</title>
        <link rel="stylesheet" href="${new URL('css/style.css', location.href).href}">
        <style>
            @page { size: A4; margin: 10mm 0; }
            html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
            body, body * { visibility: visible !important; }   /* style.css 인쇄 규칙(#print-modal만 보이게) 해제 */
            .sheet { width: 210mm; display: flex; justify-content: center; }
            .sheet .ot-a4 { flex: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style></head>
        <body><div class="sheet">${renderOvertimeSheetHtml(data, { a4: true })}</div></body></html>`);
    doc.close();
    const link = doc.querySelector('link');
    const waits = [new Promise(resolve => { if (link.sheet) resolve(); else link.onload = link.onerror = resolve; })]
        .concat(Array.from(doc.images).map(img => img.complete ? Promise.resolve()
            : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    Promise.all(waits).then(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
    });
}
