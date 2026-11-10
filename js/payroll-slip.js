// ==========================================
// 💵 급여 관리 ⑤ 명세서 · 메일 · 대장 엑셀 (payroll-slip.js)
// 임금명세서·경비명세서 HTML(화면·인쇄·메일 PDF 공용), 메일 발송, 일괄 발송 창, 임금대장·경비대장 엑셀
// ==========================================

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
            ${wageLegalHtml()}
        </div>
    </div>`;
}

// 직원 발송본 (메일 PDF) - 법정 기재사항만: 근로자 정보·지급일·항목별 금액·총액·공제내역·고정OT 시간과 계산방법
function renderWageSlipEmployeeHtml(rec, opts = {}) {
    return `<div class="ps-paper a4 emp">
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
        <div class="ps-netbox"><small>이번 달 실지급액</small><b>${won(rec.totals.payout)}<span>원</span></b></div>
        </div></div>

        <div class="ps-bottom">
            ${slipFootHtml('')}
            ${wageLegalHtml()}
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
    // 📅 일할계산 | 10-13 ~ 10-31 (19일) | 19일 ÷ 31일
    const p = rec.prorate;
    return p ? `<div class="ps-prorate">📅 <b>일할계산</b><i class="sep">|</i>${p.start.slice(5)} ~ ${p.end.slice(5)} (${p.days}일)<i class="sep">|</i>${p.days}일 ÷ ${p.monthDays}일</div>` : '';
}

// 맨 아래 작은 글씨 한 줄만 (제목·안내문 없음 - 일할계산은 위 📅 줄이 계산방법 역할) (사용자 결정 2026-11-06)
function wageLegalHtml() {
    return `<div class="ps-legal">본 명세서는 근로기준법 제48조 제2항에 따라 교부합니다.</div>`;
}

// rec = 경비명세서 문서 (payroll_expenses)
// 디자인 (2026-11-06 확정): 상단 로고·월 태그·이름 / 연장근무 달력 / 고정·초과·수당 요약 / 계산식 / 인사말
// 달력은 그 사원의 승인된 연장근로 신청(P.otRequests) 중 이 달 날짜의 시간으로 그림
function renderExpenseSlipHtml(rec) {
    const h = rec.hours || { fixed: FIX_OT_LIMITS, actual: {}, over: {} };
    const x = rec.expense || { lines: [], pay: 0, wage: 0 };
    const over = h.over || {};
    const [y, mm] = rec.month.split('-');
    const mon = Number(mm);
    const e = emp(rec.employeeId) || {};
    const logs = (P.otRequests || [])
        .filter(r => r.employeeName === (e.name || rec.name) && (!e.phoneLast4 || r.employeePhone === e.phoneLast4) && requestMonth(r) === rec.month)
        .flatMap(r => r.detailLogs || []);
    const byDay = {};
    logs.forEach(l => {
        if (String(l.date || '').startsWith(rec.month)) {
            const d = Number(l.date.slice(8));
            byDay[d] = (byDay[d] || 0) + (parseFloat(l.hours) || 0);
        }
    });
    const totalHours = logs.reduce((s, l) => s + (parseFloat(l.hours) || 0), 0);
    const hTxt = v => `${Math.round(v * 10) / 10}h`;

    const first = new Date(Number(y), mon - 1, 1).getDay();
    let cal = ['일', '월', '화', '수', '목', '금', '토'].map(w => `<div class="w">${w}</div>`).join('');
    for (let i = 0; i < first; i++) cal += '<div class="dd x"></div>';
    for (let d = 1; d <= monthDays(rec.month); d++) {
        cal += byDay[d] ? `<div class="dd ot">${d}<span class="hr">${hTxt(byDay[d])}</span></div>` : `<div class="dd">${d}</div>`;
    }

    const overTotal = ['overtime', 'holiday', 'night'].reduce((s, k) => s + (over[k] || 0), 0);
    const wageLabel = x.ordinary ? '통상시급' : '시급';
    const multi = x.lines.length > 1;
    const formula = x.lines.length
        ? x.lines.map(l => `${wageLabel} × ${Math.round(l.rate * 100)}% × ${fmtH(l.hours)}${multi || l.bucket !== 'overtime' ? ` (${OT_LABELS[l.bucket]})` : ''}`).join(' + ') + ` = ${won(x.pay)}원`
        : '고정 시간 범위 내 — 초과 없음';
    const within = ['holiday', 'night'].filter(k => !(over[k] > 0))
        .map(k => `${OT_LABELS[k]} ${fmtH(h.actual[k] || 0)} / ${fmtH(h.fixed[k] || 0)}`);

    return `<div class="ps-paper a4 xp">
        <div class="ps-top">
            <div class="xp-head"><img src="${PAY_LOGO}" alt=""><span class="xp-tag">${y}년 ${mon}월 · 경비</span></div>
            <div class="xp-name"><b>${esc(rec.name)}</b> ${esc(rec.position || '')}${rec.department ? ` · ${esc(rec.department)}` : ''}</div>
        </div>
        <div class="ps-body"><div class="ps-body-in">
            <div class="xp-hl">${mon}월에 <em>${hTxt(totalHours).replace('h', '시간')}</em> 연장근무 하셨어요</div>
            <div class="xp-cal">${cal}</div>
            <div class="xp-sum">
                <div class="xp-box">고정 연장<b>${fmtH(h.fixed.overtime || 0)}</b></div>
                <div class="xp-box over">초과<b>${fmtH(overTotal)}</b></div>
                <div class="xp-box pay">초과근무수당<b>${won(x.pay)}원</b></div>
            </div>
            <div class="xp-calc">계산 &nbsp;<b>${formula}</b>${within.length ? `<br>${within.join(' · ')} — 고정 시간 범위 내` : ''}</div>
        </div></div>
        <div class="ps-bottom">
            <div class="xp-sign"><span>이번 달도 수고 많으셨습니다.</span><b>${esc(P.settings.companyName)}</b></div>
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
// 명세서 보기 창·일괄 발송 창: ESC로 닫기 (일괄 발송은 보내는 중에는 안 닫힘)
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('pay-doc-modal');
    if (modal && modal.style.display === 'flex') closePayDoc();
    const bulk = document.getElementById('pay-bulk-modal');
    if (bulk && bulk.style.display === 'flex') closeBulkSend();
});

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

// 1명 · 1종 발송 (toOverride: 일괄 발송 창에서 고친 이메일로 보낼 때)
function sendPayDocCore(empId, kind, toOverride) {
    const rec = kind === 'wage' ? buildRecord(empId, false) : P.expenses[empId];
    const p = prof(empId);
    const to = (toOverride || p.email || '').trim();
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

// 잠깐 떴다가 사라지는 알림 (확인 버튼 없음)
function payToast(text) {
    const old = document.getElementById('pay-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'pay-toast';
    t.className = 'pay-toast';
    t.textContent = `✅ ${text}`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
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
            .then(() => { payToast(`${e.name}님에게 ${label}를 발송했습니다.`); })
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

// ------------------------------------------
// 임금명세서 일괄 발송 창: 체크해서 고르고, 이메일을 바로 고치고, 실패한 사람만 다시 발송
// ------------------------------------------
const BULK = { rows: [], sending: false };   // rows: { id, email, origEmail, checked, result: ''|'ok'|'fail', at, error }

function bulkSendWage() {
    BULK.rows = monthEmployees().map(e => {
        const email = (prof(e.id).email || '').trim();
        // 이메일이 없는 사원은 자동 체크하지 않음 (이메일을 입력한 뒤 직접 체크하면 발송 가능)
        return { id: e.id, email, origEmail: email, checked: !!email && ['save', 'revised'].includes(recordStatus(P.records[e.id])), result: '', at: 0, error: '' };
    });
    BULK.rows.forEach(r => { if (bulkBlockReason(r)) r.checked = false; });
    document.getElementById('pay-bulk-title').innerText = `📧 임금명세서 일괄 발송 · ${monthLabel(P.month)}`;
    renderBulkSend();
    document.getElementById('pay-bulk-modal').style.display = 'flex';
}

// 보낼 수 없는 이유 (있으면 체크 불가)
function bulkBlockReason(r) {
    if (!P.records[r.id]) return '급여 저장 필요';
    if (!birth6(prof(r.id).birthDate)) return '생년월일 미등록';
    return '';
}

function renderBulkSend(summary) {
    const statusTag = id => {
        const rec = P.records[id], st = recordStatus(rec);
        if (st === 'wait') return '<span class="bs-tag off">저장 전</span>';
        if (st === 'save') return '<span class="bs-tag save">저장됨</span>';
        if (st === 'revised') return '<span class="bs-tag rev">수정됨</span>';
        return `<span class="bs-tag sent">${msToDate(rec.wageSentAt).slice(5)} 발송완료</span>`;
    };
    const rows = BULK.rows.map((r, i) => {
        const e = emp(r.id), block = bulkBlockReason(r);
        const res = r.result === 'ok' ? `<span class="ok">✅ ${msToDateTime(r.at).slice(-5)}</span>`
            : r.result === 'fail' ? `<span class="fail">❌ ${esc(r.error)}</span>`
            : r.result === 'sending' ? '<span class="wait">보내는 중...</span>'
            : block ? esc(block) : (r.checked ? '<span class="wait">대기</span>' : '<span class="wait">-</span>');
        const cls = [r.email !== r.origEmail ? 'edited' : '', r.result === 'fail' ? 'bad' : ''].join(' ');
        return `<tr class="${block ? 'dis' : ''}">
            <td class="c"><input type="checkbox" ${r.checked ? 'checked' : ''} ${block || BULK.sending ? 'disabled' : ''} onchange="BULK.rows[${i}].checked = this.checked; renderBulkSend()"></td>
            <td>${esc(e.name)}</td><td>${esc(e.department || '-')}</td>
            <td><input type="email" class="${cls}" value="${esc(r.email)}" placeholder="이메일 입력" ${BULK.sending ? 'disabled' : ''}
                oninput="BULK.rows[${i}].email = this.value.trim(); this.classList.toggle('edited', BULK.rows[${i}].email !== BULK.rows[${i}].origEmail)"></td>
            <td>${statusTag(r.id)}</td><td class="res">${res}</td>
        </tr>`;
    }).join('');
    const n = BULK.rows.filter(r => r.checked).length;
    const sentAny = BULK.rows.some(r => r.result);
    document.getElementById('pay-bulk-sub').innerHTML = summary
        || '저장됨·수정됨 사원은 자동으로 체크돼요. 발송완료 사원도 체크하면 다시 보낼 수 있어요. 경비명세서는 포함되지 않아요.';
    document.getElementById('pay-bulk-tbody').innerHTML = rows;
    const all = BULK.rows.filter(r => !bulkBlockReason(r));
    const allBox = document.getElementById('pay-bulk-all');
    allBox.checked = all.length > 0 && all.every(r => r.checked);
    allBox.disabled = BULK.sending;
    const go = document.getElementById('pay-bulk-go');
    go.disabled = BULK.sending || n === 0;
    go.innerText = BULK.sending ? '보내는 중...' : `선택한 ${n}명 ${sentAny ? '다시 ' : ''}발송`;
}

function bulkSelect(mode) {
    if (BULK.sending) return;
    BULK.rows.forEach(r => {
        if (bulkBlockReason(r)) { r.checked = false; return; }
        if (mode !== 'none' && !r.email) { r.checked = false; return; }   // 빠른 선택도 이메일 없는 사원은 건너뜀
        const st = recordStatus(P.records[r.id]);
        r.checked = mode === 'all' ? true : mode === 'none' ? false
            : mode === 'unsent' ? ['save', 'revised'].includes(st) : st === 'revised';
    });
    renderBulkSend();
}

function closeBulkSend() {
    if (BULK.sending) return;
    document.getElementById('pay-bulk-modal').style.display = 'none';
}

function runBulkSend() {
    const targets = BULK.rows.filter(r => r.checked && !bulkBlockReason(r));
    if (!targets.length) return;
    const bad = targets.find(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email));
    if (bad) { alert(`${emp(bad.id).name}님의 이메일 형식을 확인해 주세요.`); return; }
    const saveEmail = document.getElementById('pay-bulk-save-email').checked;
    BULK.sending = true;
    targets.forEach(r => { r.result = ''; r.error = ''; });
    renderBulkSend();

    targets.reduce((chain, r, i) => chain.then(() => {
        r.result = 'sending';
        renderBulkSend(`보내는 중... (${i + 1}/${targets.length}) ${esc(emp(r.id).name)}`);
        // 고친 이메일을 사원 정보에도 저장 (체크했을 때만)
        const saveFirst = saveEmail && r.email !== r.origEmail
            ? db.collection("payroll_profiles").doc(r.id).set({ email: r.email }, { merge: true })
                .then(() => { P.profiles[r.id] = { ...prof(r.id), email: r.email }; r.origEmail = r.email; })
            : Promise.resolve();
        return saveFirst
            .then(() => sendPayDocCore(r.id, 'wage', r.email))
            .then(() => { r.result = 'ok'; r.at = Date.now(); r.checked = false; })
            .catch(err => { r.result = 'fail'; r.error = err.message || '발송 실패'; r.checked = true; });
    }), Promise.resolve()).then(() => {
        BULK.sending = false;
        const ok = targets.filter(r => r.result === 'ok').length, fail = targets.length - ok;
        renderBulkSend(`<b class="ok">${ok}명 발송 완료</b>${fail ? ` · <b class="fail">${fail}명 실패</b> — 실패한 사람은 체크된 채로 남아 있어요. 이메일을 고치고 다시 보내 보세요.` : ''}`);
        renderPayMonthBar(); renderPayEmpList(); renderPayMain();
        if (!fail) payToast(`${ok}명에게 임금명세서를 발송했습니다.`);
    });
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
