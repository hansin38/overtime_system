// ==========================================
// 💵 급여 관리 ④ 회계사무소 급여대장 불러오기 · 🔍 검수 (payroll-import.js)
// 공제 6항목 반영, 사원정보로 계산한 지급액과 대조 → 원인 추정 → 정정신고 요청 / 업로드값 / 계산값 선택
// ==========================================

// ------------------------------------------
// 📥 회계사무소 급여대장 불러오기
// - 회계사무소 엑셀(.xls/.xlsx): 사원마다 3줄 (사원번호·성명·항목 / 입사일·공제합계 / 지급합계·차인지급액)
// - 머리글 글자로 열 위치를 찾으므로 열 순서가 바뀌어도 동작
// - 공제 6항목은 그대로 반영, 지급은 아래 🔍 검수 화면에서 사람별로 처리 방법 선택
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
    const btn = document.getElementById('pay-import-apply');
    btn.disabled = true;
    btn.innerText = '검수 후 저장';
    document.getElementById('pay-audit-status').innerHTML = '';
    document.getElementById('pay-audit-memo').style.display = 'none';
    document.getElementById('pay-import-drop').style.display = '';
    document.querySelector('#pay-import-modal .pay-modal').classList.remove('audit');
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

// ------------------------------------------
// 🔍 급여대장 검수 (불러오기 팝업이 화면 가득 커지면서 사람별 검수 보드로)
// - 비교 기준: 사원정보(연봉·수당·고정OT·입사일)로 계산한 금액 (= defaultPay, 명세서 자동값과 같은 계산)
// - 다른 항목마다 '이렇게 계산 ↔ 회계사무소는 이렇게 한 것 같아요'를 자주 나오는 실수(30일로 나눔, 재직일 ±1,
//   평일로 일할, 일할 누락, 항목 누락, 연봉 변경 미반영, 고정OT 시간 차이)에 대입해서 찾아 보여 줌
// - 사람마다 3가지 중 선택: 📮 정정신고 요청(저장 안 하고 보류) / 📥 업로드 자료 적용 / 🧮 계산한 자료 적용
// - 공제 6항목은 어느 쪽을 골라도 회계사무소 값 그대로 (4대보험은 공단 신고 기준액이라 참고만)
// ------------------------------------------
const AUDIT_CHOICES = {
    fix: { ic: '📮', t: '정정신고 요청', d: '이번엔 저장하지 않고 보류해요. 회계사무소에서 고친 대장을 받으면 다시 올려 주세요.' },
    acc: { ic: '📥', t: '업로드 자료 적용', d: '회계사무소 금액 그대로 명세서에 반영해요.' },
    calc: { ic: '🧮', t: '계산한 자료 적용', d: '사원정보로 계산한 금액으로 명세서를 만들어요. (공제는 회계사무소 값)' }
};
function auditDiffText(o, a) {
    return a > o ? `${won(a - o)}원 더 신고됨` : `${won(o - a)}원 덜 신고됨`;
}
function auditSigned(n) { return n === 0 ? '—' : `${n > 0 ? '+' : '−'}${won(Math.abs(n))}`; }

// 우리 계산 설명 (항목별)
function auditExplainOurs(k, def, profile) {
    const s = def.structure, r = def.range, mo = Number(P.month.slice(5));
    if (!s) return '사원정보에 급여조건(연봉 또는 고정 금액)이 없어요';
    const label = ACC_PAY_LABELS[k];
    if (r && r.partial) {
        if (k === 'base') {
            return s.type === 'annual'
                ? `연봉 ${won(s.annual)} ÷ 12 = ${won(s.monthlyRaw)}<br>× 재직 ${r.days}일 ÷ ${r.monthDays}일 <span class="sub">(${r.start.slice(5)} ~ ${r.end.slice(5)})</span>`
                : `월급(식대 제외) ${won(s.monthly - s.pay.meal)}<br>× 재직 ${r.days}일 ÷ ${r.monthDays}일 <span class="sub">(${r.start.slice(5)} ~ ${r.end.slice(5)})</span>`;
        }
        if (k === 'meal') return '식대는 일할 없이 전액';
        if (k === 'bonus') return (HOLIDAY_BONUS_MONTHS[Number(P.month.slice(0, 4))] || []).includes(mo) ? `명절상여 ${won(profile.holidayBonus)}` : `${mo}월은 명절상여 달이 아님`;
        return `입사·퇴사 달은 전부 기본급으로 일할 → ${label} 0원`;
    }
    if (['meal', 'vehicle', 'position', 'site'].includes(k)) return `사원정보 › ${label} ${won(s.pay[k])}`;
    if (k === 'bonus') {
        return (HOLIDAY_BONUS_MONTHS[Number(P.month.slice(0, 4))] || []).includes(mo)
            ? `사원정보 › 명절상여 ${won(profile.holidayBonus)} <span class="sub">(${mo}월은 명절상여 달)</span>` : `${mo}월은 명절상여 달이 아님 → 0원`;
    }
    if (s.type === 'fixed') return `사원정보 › 고정 금액 ${label} ${won(s.pay[k])}`;
    if (k === 'overtime') return `통상시급 ${won2(s.ordinaryWage)} × 고정 연장 ${s.fixed.overtime}h × 1.5 = ${s.weighted.overtime}h`;
    if (k === 'holidayNight') return `통상시급 ${won2(s.ordinaryWage)} × (휴일 ${s.fixed.holiday}h × 1.5 + 야간 ${s.fixed.night}h × 0.5) = ${s.weighted.holiday + s.weighted.night}h`;
    if (k === 'base') return `연봉 ${won(s.annual)} ÷ 12 = ${won(s.monthly)}<br>− 식대·차량·직책·현장수당 − 고정OT 수당`;
    return '';
}

// 일할 계산이 틀린 경우: 자주 나오는 실수에 대입해서 맞는 것 찾기
function auditGuessProrate(a, def) {
    const s = def.structure, r = def.range, ym = P.month, mo = Number(ym.slice(5));
    const raw = s.type === 'annual' ? s.monthlyRaw : s.monthly - s.pay.meal;
    const md = r.monthDays, d = r.days;
    const near = (x) => Math.abs(Math.round(x) - a) <= 1;
    for (const dd of [30, 31, 28, 29].filter(x => x !== md)) {
        if (near(raw * d / dd)) return { accCalc: `${won(raw)} × ${d}일 ÷ <mark>${dd}일</mark>`, why: `${mo}월은 <b>${md}일</b>까지 있는데 회계사무소는 <b>${dd}일</b>로 나눈 것 같아요. 회사 방식(그달 달력 일수)으로는 ${md}일이 맞아요.` };
    }
    for (const n of [d - 1, d + 1]) {
        if (n > 0 && near(raw * n / md)) return { accCalc: `${won(raw)} × <mark>${n}일</mark> ÷ ${md}일`, why: `재직일을 <b>${n}일</b>로 센 것 같아요. ${r.start.slice(5)} ~ ${r.end.slice(5)}는 양쪽 날짜를 포함하면 <b>${d}일</b>이에요.` };
    }
    const wd = countWorkDays(r), wm = countWorkDays({ start: `${ym}-01`, end: `${ym}-${pad2(md)}` });
    if (wm > 0 && near(raw * wd / wm)) return { accCalc: `${won(raw)} × <mark>평일 ${wd}일 ÷ ${wm}일</mark>`, why: `달력 날짜 대신 <b>평일(근무일) ${wd}일 ÷ ${wm}일</b>로 계산한 것 같아요. 회사 방식은 달력 일수(${d}일 ÷ ${md}일)예요.` };
    if (s.type === 'annual' && near((raw - s.pay.meal) * d / md)) return { accCalc: `(${won(raw)} <mark>− 식대 ${won(s.pay.meal)}</mark>) × ${d}일 ÷ ${md}일`, why: `식대를 뺀 금액으로 일할한 것 같아요. 회사 방식은 연봉÷12 전체를 일할하고 식대는 따로 전액이에요.` };
    if (near(raw) || a === s.pay.base) return { accCalc: `<mark>일할 없이</mark> 한 달 치`, why: `${r.start.slice(5)} 입사(또는 퇴사)인데 <b>일할계산 없이 한 달 치</b>가 들어갔어요.` };
    return null;
}

// 다른 항목마다 원인 추정 → [{ key, label, ours, acc, oursCalc, accCalc, verdict, rec }]
function auditDiagnose(e, def, ours, accPay) {
    const s = def.structure, r = def.range;
    const profile = profFor(e.id, P.month);
    const sameTotal = sumValues(ours) === sumValues(accPay);
    return ACC_PAY_KEYS.filter(k => ours[k] !== num(accPay[k])).map(k => {
        const o = ours[k], a = num(accPay[k]), label = ACC_PAY_LABELS[k];
        const it = { key: k, label, ours: o, acc: a, oursCalc: auditExplainOurs(k, def, profile), accCalc: won(a), verdict: '', rec: null };
        const diff = ` → <b>${auditDiffText(o, a)}</b>`;
        const g = k === 'base' && s && r && r.partial ? auditGuessProrate(a, def) : null;
        if (g) {
            it.accCalc = g.accCalc; it.verdict = g.why + diff; it.rec = 'fix';
        } else if (a === 0 && o > 0) {
            it.accCalc = `${label} <mark>0원</mark> (대장에 없음)`;
            it.verdict = `사원정보에는 ${label} ${won(o)}원이 있는데 회계사무소 대장에는 없어요. 전달이 안 됐을 수 있어요.` + diff;
            it.rec = 'fix';
        } else if (o === 0 && a > 0) {
            it.accCalc = `${label} <mark>${won(a)}</mark>`;
            it.verdict = `회계사무소 대장에만 있는 금액이에요. 사원정보에 빠져 있지 않은지 확인해 주세요.` + diff;
            it.rec = 'acc';
        } else if (sameTotal) {
            if (s && s.type === 'annual' && k === 'overtime' && s.ordinaryWage > 0) {
                it.accCalc = `통상시급 × 약 <mark>${(a / s.ordinaryWage).toFixed(1)}h</mark>`;
                it.verdict = `월급 합계는 같고 <b>항목 나누는 방식만</b> 달라요. 고정 연장시간이 사원정보(${s.fixed.overtime}h, 가산 ${s.weighted.overtime}h)와 다르게 들어간 것 같아요. 받는 돈은 같아요.`;
            } else {
                it.verdict = `월급 합계는 같고 <b>항목 나누는 방식만</b> 달라요. 받는 돈은 같아요.`;
            }
            if (['meal', 'vehicle'].includes(k)) it.verdict += ' (비과세 금액이 달라서 세금은 달라질 수 있어요)';
            it.rec = 'calc';
        } else if (k === 'base' && s && s.type === 'annual' && !(r && r.partial)) {
            const accMonthly = sumValues(accPay) - num(accPay.bonus);
            const implied = accMonthly * 12;
            if (Math.abs(implied - s.annual) > 12) {
                it.accCalc = `월 합계 ${won(accMonthly)} × 12 = <mark>연봉 ${won(implied)}</mark>`;
                it.verdict = `회계사무소는 <b>연봉 ${won(implied)}원</b> 기준으로 계산했어요. 사원정보 연봉은 ${won(s.annual)}원이에요. 연봉 변경이 전달 안 됐는지 확인해 주세요.` + diff;
                it.rec = 'fix';
            } else {
                it.verdict = `원인을 찾지 못했어요. 금액만 달라요.` + diff;
            }
        } else {
            it.verdict = `원인을 찾지 못했어요. 금액만 달라요.` + diff;
        }
        return it;
    });
}

function buildImportRows(accMonth, people) {
    const targets = monthEmployees();
    P.importRows = targets.map(e => {
        const acc = people.find(p => e.empNo && p.empNo === String(e.empNo)) || people.find(p => p.name === (e.name || '').replace(/\s/g, ''));
        const def = defaultPay(e.id, P.month);
        const ourPay = def.pay;
        if (!acc) return { emp: e, acc: null, ourPay, issues: [] };
        const ours = payToAccShape(ourPay);
        const accPay = { ...Object.fromEntries(ACC_PAY_KEYS.map(k => [k, 0])), ...acc.pay };
        const issues = auditDiagnose(e, def, ours, accPay);
        const recs = issues.map(i => i.rec);
        const rec = recs.includes('fix') ? 'fix' : recs.length && recs.every(x => x === 'calc') ? 'calc' : recs.includes('acc') ? 'acc' : null;
        // 지급액이 달라 고용보험도 따라 달라진 경우 안내
        let chain = '';
        if (issues.length && sumValues(ours) !== sumValues(accPay) && num(acc.deduct.employment) > 0) {
            const ourEmp = floor10(taxableOf(ourPay) * INSURANCE.employment);
            if (ourEmp !== num(acc.deduct.employment)) chain = `고용보험도 지급액 따라 달라요 (계산 ${won(ourEmp)} ↔ 대장 ${won(acc.deduct.employment)})`;
        }
        return { emp: e, acc, accPay, ours, ourPay, issues, rec, chain, choice: null };
    });
    P.importMeta = { accMonth, unknown: people.filter(p => !P.importRows.some(r => r.acc === p)).length };
    const order = (r) => r.issues.length ? 0 : !r.acc ? 1 : 2;
    const first = [...P.importRows].sort((a, b) => order(a) - order(b))[0];
    P.auditSel = first ? first.emp.id : null;
    document.querySelector('#pay-import-modal .pay-modal').classList.add('audit');
    document.getElementById('pay-import-drop').style.display = 'none';
    document.getElementById('pay-import-title').innerText = `🔍 급여대장 검수 · ${monthLabel(P.month)}`;
    renderAudit();
}

function auditChoose(empId, c) {
    const r = P.importRows.find(x => x.emp.id === empId);
    if (r) r.choice = c;
    renderAudit();
}
function auditSelect(empId) { P.auditSel = empId; renderAudit(); }

function renderAudit() {
    const rows = P.importRows, meta = P.importMeta || {};
    const matched = rows.filter(r => r.acc);
    const bad = matched.filter(r => r.issues.length);
    const missing = rows.filter(r => !r.acc);
    const diffSum = matched.reduce((s, r) => s + sumValues(r.accPay) - sumValues(r.ours), 0);
    const monthWarn = meta.accMonth && meta.accMonth !== P.month
        ? `<div class="pay-note warn">⚠️ 파일의 귀속월은 <b>${monthLabel(meta.accMonth)}</b>인데, 지금 선택한 달은 <b>${monthLabel(P.month)}</b>입니다. 달을 확인해 주세요.</div>` : '';
    const chip = (r) => !r.acc ? '<span class="pa-chip gray">대장에 없음</span>'
        : !r.issues.length ? '<span class="pa-chip ok">✅ 일치</span>'
        : r.choice ? `<span class="pa-chip done">${AUDIT_CHOICES[r.choice].ic} ${AUDIT_CHOICES[r.choice].t}</span>`
        : `<span class="pa-chip bad">⚠️ ${r.issues.length}건 다름</span>`;
    const order = (r) => r.issues.length ? 0 : !r.acc ? 1 : 2;
    const list = [...rows].sort((a, b) => order(a) - order(b)).map(r => `
        <div class="pa-person ${r.emp.id === P.auditSel ? 'on' : ''}" onclick="auditSelect('${r.emp.id}')">
            <div><div class="nm">${esc(r.emp.name)}</div><div class="ds">${esc([r.emp.department, r.emp.position].filter(Boolean).join(' · '))}</div></div>
            ${chip(r)}
        </div>`).join('');

    document.getElementById('pay-import-result').innerHTML = `${monthWarn}
        <div class="pa-summary">
            <div class="pa-sum"><div class="k">검수 대상</div><div class="v">${rows.length}명</div></div>
            <div class="pa-sum ok"><div class="k">일치</div><div class="v">${matched.length - bad.length}명</div></div>
            <div class="pa-sum bad"><div class="k">다름</div><div class="v">${bad.length}명 · ${bad.reduce((s, r) => s + r.issues.length, 0)}건</div></div>
            <div class="pa-sum warn"><div class="k">지급 차액 합계 (대장 − 계산)</div><div class="v">${auditSigned(diffSum)}원</div></div>
        </div>
        ${missing.length || meta.unknown ? `<div class="sub" style="margin: -6px 0 16px;">${missing.length ? `회계사무소 대장에 없는 사람 ${missing.length}명은 저장하지 않아요` : ''}${missing.length && meta.unknown ? ' · ' : ''}${meta.unknown ? `급여명세서 대상이 아닌 ${meta.unknown}명은 건너뜀` : ''}</div>` : ''}
        <div class="pa-board">
            <div class="pa-list"><div class="lh">사원 ${rows.length}명 · 다른 사람이 위로</div>${list}</div>
            <div class="pa-detail">${renderAuditDetail(rows.find(r => r.emp.id === P.auditSel))}</div>
        </div>`;

    const need = bad.filter(r => !r.choice).length;
    const fixN = bad.filter(r => r.choice === 'fix').length;
    const saveN = matched.length - fixN;
    document.getElementById('pay-audit-status').innerHTML = bad.length
        ? `처리 선택 <b>${bad.length - need} / ${bad.length}명</b>${fixN ? ` · 정정 요청 <b>${fixN}명</b> (보류)` : ''}` : '모두 일치해요';
    document.getElementById('pay-audit-memo').style.display = fixN ? '' : 'none';
    const btn = document.getElementById('pay-import-apply');
    btn.disabled = need > 0 || matched.length === 0;
    btn.innerText = need > 0 ? `처리 방법을 골라 주세요 (${need}명 남음)` : saveN ? `저장 (${saveN}명)` : '닫기 (모두 보류)';
}

function renderAuditDetail(r) {
    if (!r) return '';
    const e = r.emp;
    const head = `<div class="pa-dh"><h3>${esc(e.name)}</h3><span class="sub">${esc([e.department, e.position, e.empNo ? `사원번호 ${e.empNo}` : ''].filter(Boolean).join(' · '))}</span></div>`;
    if (!r.acc) return `${head}<div class="pa-okbox gray">회계사무소 대장에 이 사람이 없어요 (사원번호 ${esc(e.empNo || '-')})<br><small>저장하지 않아요. 대장에서 빠졌는지 회계사무소에 확인해 주세요.</small></div>`;
    const keys = ACC_PAY_KEYS.filter(k => r.ours[k] || num(r.accPay[k]));
    const tr = (label, o, a, cls = '') => `<tr class="${cls} ${o !== a ? 'diff' : ''}"><td>${label}</td><td>${won(o)}</td><td>${won(a)}</td><td class="d">${auditSigned(a - o)}</td></tr>`;
    const table = `<table class="pa-cmp">
        <tr><th>항목</th><th>🧮 계산 (사원정보 기준)</th><th>📥 회계사무소 대장</th><th>차이</th></tr>
        ${keys.map(k => tr(ACC_PAY_LABELS[k], r.ours[k], num(r.accPay[k]))).join('')}
        ${tr('지급 합계', sumValues(r.ours), sumValues(r.accPay), 'tot')}
    </table>
    <div class="pa-deduct">공제 (회계사무소 값 그대로 반영) · ${DEDUCT_ITEMS.map(it => `${it.label} ${won(r.acc.deduct[it.key])}`).join(' · ')}</div>`;
    if (!r.issues.length) return `${head}${table}<div class="pa-okbox">✅ 모든 지급 항목이 사원정보로 계산한 금액과 같아요</div>`;
    const issues = r.issues.map((it, i) => `
        <div class="pa-issue">
            <div class="ih"><b>${i + 1}. ${it.label}</b><span>계산 ${won(it.ours)} ↔ 대장 ${won(it.acc)}</span><span class="pa-chip bad" style="margin-left: auto;">${auditSigned(it.acc - it.ours)}원</span></div>
            <div class="ib">
                <div class="pa-why">
                    <div class="pa-calc ours"><div class="t">🧮 이렇게 계산했어요</div><div class="f">${it.oursCalc}</div><div class="r">= ${won(it.ours)}</div></div>
                    <div class="pa-calc acc"><div class="t">📥 회계사무소는 이렇게 한 것 같아요</div><div class="f">${it.accCalc}</div><div class="r">= ${won(it.acc)}</div></div>
                </div>
                <div class="pa-verdict">💡 ${it.verdict}</div>
            </div>
        </div>`).join('');
    const choices = `<div class="pa-choose-h">이 사람은 어떻게 처리할까요?</div>
        <div class="pa-choices">${['fix', 'acc', 'calc'].map(c => `
            <button class="pa-choice ${r.choice === c ? 'sel' : ''}" onclick="auditChoose('${e.id}', '${c}')">
                <div class="ct">${AUDIT_CHOICES[c].ic} ${AUDIT_CHOICES[c].t} ${r.rec === c ? '<span class="rec">추천</span>' : ''}</div>
                <div class="cd">${AUDIT_CHOICES[c].d}</div>
            </button>`).join('')}</div>
        ${r.choice === 'fix' ? `<div class="pa-memo">${esc(auditMemoFor(r))}</div>` : ''}`;
    return `${head}${table}${issues}${r.chain ? `<div class="pa-chain">함께 영향: <span>${esc(r.chain)}</span></div>` : ''}${choices}`;
}

function auditMemoFor(r) {
    const strip = (h) => h.replace(/<[^>]+>/g, '');
    return `■ ${r.emp.name}${r.emp.empNo ? ` (사원번호 ${r.emp.empNo})` : ''}\n`
        + r.issues.map(it => `- ${it.label}: ${won(it.acc)}원 → ${won(it.ours)}원\n  사유: ${strip(it.verdict)}`).join('\n')
        + (r.chain ? `\n- ${r.chain}` : '');
}
function copyAuditMemo() {
    const fixes = P.importRows.filter(r => r.acc && r.choice === 'fix');
    if (!fixes.length) return;
    const text = `${monthLabel(P.month)} 급여대장 정정 요청드립니다.\n\n${fixes.map(auditMemoFor).join('\n\n')}\n\n확인 후 정정된 급여대장 다시 보내주세요. 감사합니다.`;
    navigator.clipboard.writeText(text)
        .then(() => payToast('정정 요청 메모를 복사했어요'))
        .catch(() => prompt('아래 내용을 복사해 주세요', text));
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
    // 📮 정정신고 요청을 고른 사람은 저장하지 않고 보류 (고친 대장을 다시 올리면 그때 검수)
    const held = P.importRows.filter(r => r.acc && r.choice === 'fix').length;
    const rows = P.importRows.filter(r => r.acc && r.choice !== 'fix');
    if (!rows.length) {
        closePayImport();
        if (held) payToast(`${held}명 정정 요청으로 보류했어요 · 고친 대장을 받으면 다시 올려 주세요`);
        return;
    }
    const now = Date.now();
    setPayBusy(true, '회계사무소 급여대장 반영 중...');
    const jobs = rows.map(r => {
        const id = r.emp.id;
        const useAcc = r.issues.length && r.choice === 'acc';
        const pay = useAcc ? accPayToOurs(id, r.accPay, r.ourPay) : r.ourPay;
        const deduct = Object.fromEntries(DEDUCT_ITEMS.map(it => [it.key, num(r.acc.deduct[it.key])]));
        const saved = P.records[id];
        const rec = buildRecord(id, false, { pay, deduct, etc: saved ? saved.etc || [] : [] });
        rec.updatedAt = now;
        if (!rec.savedAt) rec.savedAt = now;
        rec.deductSource = 'accounting';
        rec.accountingImportedAt = now;
        if (useAcc) rec.payEdited = true;

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
            // 등록만 알리고 끝 (메일 발송은 나중에 '일괄 발송' 버튼으로)
            payToast(`${rows.length}명 급여대장이 등록됐어요${held ? ` · ${held}명은 정정 요청으로 보류` : ''}`);
        })
        .catch(err => {
            console.error("급여대장 반영 실패:", err);
            alert("반영 중 오류가 발생했습니다. 일부만 저장됐을 수 있으니 다시 불러와 주세요.");
            setPayBusy(false); P.dirty = false; renderPayMonthBar(); renderPayEmpList(); renderPayMain();
        });
}

