// ==========================================
// 💵 급여 관리 ② 화면 틀 · 이번 달 급여 · 연간 현황 · 회사 정보 (payroll-month.js)
// 탭 열기·데이터 로드, 상단 현황·직원 목록, 오른쪽 사원 상세(탭 전환), 이번 달 급여 입력·저장, 연간 현황
// 계산식은 payroll-core.js
// ==========================================

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
        // 경비명세서를 다시 계산하기 전에 경비 시급 기준(1회 설정)부터 맞춤
        return applyExpenseBasisDefaults(P.profiles, P.employees).then(syncMonthExpenses).then(() => {
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
    bulk.disabled = list.length === 0;   // 미발송이 0명이어도 창을 열어 발송완료 사원에게 다시 보낼 수 있게
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

// 급여대장을 안 올린 달: 예상 금액 대신 '미등록' 안내만 (경비는 급여대장과 별개라 그대로)

function renderPayUnregisteredPane(id) {
    const mo = `${Number(P.month.slice(5))}월`;
    document.getElementById('pay-pane').innerHTML = `
        <div class="pay-grid">
            <div>
                <div class="pay-card" style="text-align: center; padding: 48px 24px;">
                    <div style="font-size: 32px; margin-bottom: 12px;">📭</div>
                    <h4 style="justify-content: center; margin-bottom: 8px;">${mo} 급여대장이 아직 등록되지 않았어요</h4>
                    <div class="hint" style="margin-bottom: 20px;">회계사무소에서 받은 ${mo} 급여대장을 올리면 임금명세서가 만들어져요</div>
                    <button class="pay-btn" onclick="openPayImport()">📥 회계사무소 급여대장 불러오기</button>
                    <div style="margin-top: 16px;"><span class="link sub" style="cursor: pointer; text-decoration: underline;" onclick="P.manualEntry['${P.month}|${id}'] = true; renderPayMonthPane();">급여대장 없이 직접 입력하기</span></div>
                </div>
            </div>
            <div class="pay-summary">
                <div class="sum-exp" id="pay-sum-exp" style="margin-top: 0;">${expenseCardHtml(id)}</div>
                <div class="pay-docs">
                    <div class="pay-docs-h">📧 직원에게 보내는 명세서</div>
                    <div class="pay-doc">
                        <div class="t">📄 경비명세서<small id="pay-doc-exp-st"></small></div>
                        <div class="a"><button class="pay-btn sm" onclick="viewPayDoc('expense')">보기</button><button class="pay-btn sm org" onclick="sendPayDoc('${id}', 'expense')">발송</button></div>
                    </div>
                </div>
            </div>
        </div>`;
    const x = P.expenses[id];
    document.getElementById('pay-doc-exp-st').innerText = !(x && x.requestCount)
        ? (pendingRequests(id).length ? '결재 대기 중' : '연장근로 신청 없음')
        : (x.expenseSentAt ? `${msToDateTime(x.expenseSentAt)} 발송함` : '승인 확정 · 보관');
}

function renderPayMonthPane() {
    const id = P.selectedId;
    const rec = P.records[id];
    if (!rec && !P.manualEntry[`${P.month}|${id}`]) return renderPayUnregisteredPane(id);
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

