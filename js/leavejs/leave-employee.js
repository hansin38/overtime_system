// ==========================================
// leave-employee.js (연차 신청 화면 전용 로직)
// ⚠️ 로그인/라우팅은 index.html + index.js가 담당합니다.
//    이 파일은 employee.js와 같은 역할 - "로그인 이후" 화면 로직입니다.
// ⚠️ 휴가 종류·연차 계산·휴가신청서 양식은 leave-common.js, 공휴일은 ot-rules.js에서 공통 관리
// ==========================================

// -----------------------------------------------------------------
// 1. 초기화
// -----------------------------------------------------------------
const firebaseConfig = {
    apiKey: "AIzaSyCpMIytCpZ5F5JRoKABJE7kkgv_RZReFRc",
    authDomain: "hansin-df749.firebaseapp.com",
    projectId: "hansin-df749",
    storageBucket: "hansin-df749.firebasestorage.app",
    messagingSenderId: "908820835514",
    appId: "1:908820835514:web:0e02c604c7cf775d5f2683",
    measurementId: "G-LP10H2WN94"
};
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

let currentUser = { name: "", phone: "" };
let currentTempDocId = null;      // 불러온 임시저장 문서 ID
let originDocIdForRewrite = null; // 반려 후 재작성 시 원본 문서 ID
let myEmployeeData = null;        // employees 컬렉션에서 읽어온 내 정보(hireDate·소속·직위 포함)
let myLeaveRequests = [];         // 내 연차 신청 내역 전체 [{ id, data }]

const FISCAL_YEAR = new Date().getFullYear(); // 회계연도 = 달력 연도(1/1~12/31) 기준

// -----------------------------------------------------------------
// 2. 로그인 가드 / 로그아웃 (employee.js와 동일한 패턴)
// -----------------------------------------------------------------
// 작성 중인 내용이 있는지 (연차 페이지는 자동 저장이 없으므로 이동 전 확인용)
function isLeaveFormDirty() {
    if (getSelectedLeaveType()) return true;
    return ['leave-start-date', 'leave-reason', 'leave-emergency-contact', 'leave-type-etc']
        .some(id => (document.getElementById(id)?.value || '').trim() !== '');
}
function confirmLeaveDiscard() {
    return !isLeaveFormDirty() || confirm("작성 중인 내용이 사라집니다. 이동할까요?\n(보관하려면 [임시저장]을 먼저 눌러주세요)");
}

// 메뉴·연장근무 화면으로 이동 (로그인 유지)
function leaveNavigate(url) {
    if (confirmLeaveDiscard()) location.href = url;
}

function logoutLeaveUser() {
    if (!confirmLeaveDiscard()) return;
    currentUser = { name: "", phone: "" };
    sessionStorage.removeItem('currentUser');
    location.href = '../index.html';
}

window.addEventListener('DOMContentLoaded', () => {
    const savedUser = sessionStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
    }

    if (!currentUser || !currentUser.name || !currentUser.phone) {
        alert("로그인 권한이 없습니다. 로그인 페이지로 이동합니다.");
        location.href = '../index.html';
        return;
    }

    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerText = `${currentUser.name}(${currentUser.phone})`;

    const dateSpan = document.getElementById('top-today-date');
    if (dateSpan) {
        const today = new Date();
        dateSpan.textContent = `${today.getFullYear()}. ${String(today.getMonth() + 1).padStart(2, '0')}. ${String(today.getDate()).padStart(2, '0')}.`;
    }

    // 날짜 입력 범위 제한 (연도 4자리 초과 입력 방지)
    ['leave-start-date', 'leave-end-date'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.min = `${FISCAL_YEAR - 1}-01-01`; el.max = `${FISCAL_YEAR + 1}-12-31`; }
    });

    resetFormRows();
    loadMyLeaveBalance();
});

// -----------------------------------------------------------------
// 3. 연차 현황 (계산 규칙은 leave-common.js의 calcAnnualLeaveEntitlement)
// -----------------------------------------------------------------

// 해당 연도의 발생/사용/잔여 (사용 = 대기+재전송+승인 중 년차·월차)
function getLeaveBalance(year) {
    const entitlement = calcAnnualLeaveEntitlement(myEmployeeData?.hireDate, year);
    let used = 0;
    myLeaveRequests.forEach(({ data }) => {
        if (data.fiscalYear === year && ACTIVE_STATUSES.includes(data.status) && isDeductible(data)) {
            used += (data.totalDays || 0);
        }
    });
    return { entitlement, used, remaining: Math.max(0, entitlement - used) };
}

/**
 * 내 정보(입사일자)와 신청 내역을 불러와 상단 연차 현황(발생/사용/잔여)과 월별 사용 현황을 갱신합니다.
 * '작성'(회수됨)·'반려' 상태는 사용량에서 제외합니다.
 */
function loadMyLeaveBalance() {
    const box = document.getElementById('leave-balance-box');
    if (box) box.innerHTML = `연차 정보를 불러오는 중...`;

    db.collection("employees")
        .where("name", "==", currentUser.name)
        .where("phoneLast4", "==", currentUser.phone)
        .get()
        .then((snapshot) => {
            myEmployeeData = snapshot.empty ? null : snapshot.docs[0].data();
            return db.collection("leave_requests")
                .where("employeeName", "==", currentUser.name)
                .where("employeePhone", "==", currentUser.phone)
                .get();
        })
        .then((reqSnap) => {
            myLeaveRequests = reqSnap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
            renderBalanceBox();
            renderMonthlyUsage();
        })
        .catch(err => {
            console.error("연차 정보 조회 실패:", err);
            if (box) box.innerHTML = `<span style="color:#dc3545;">연차 정보 조회 중 오류가 발생했습니다.</span>`;
        });
}

function renderBalanceBox() {
    const box = document.getElementById('leave-balance-box');
    if (!box) return;
    if (!myEmployeeData) {
        box.innerHTML = `<span style="color:#dc3545;">사원 정보를 찾을 수 없습니다. 관리자에게 문의해주세요.</span>`;
        return;
    }
    if (!myEmployeeData.hireDate) {
        box.innerHTML = `<span style="color:#dc3545;">입사일자가 등록되지 않았습니다. 관리자에게 등록을 요청해주세요.</span>`;
        return;
    }
    const { entitlement, used, remaining } = getLeaveBalance(FISCAL_YEAR);
    box.innerHTML = `
        <span>${FISCAL_YEAR}년도 발생 연차: <b>${entitlement}일</b></span>
        <span style="margin-left:14px;">사용(대기+승인): <b>${formatDays(used)}일</b></span>
        <span style="margin-left:14px; color:#007bff;">잔여 연차: <b>${formatDays(remaining)}일</b></span>
    `;
}

// -----------------------------------------------------------------
// 4. 월별 사용 현황 (년차·월차 누적)
// -----------------------------------------------------------------
function renderMonthlyUsage() {
    const box = document.getElementById('leave-monthly-box');
    const title = document.getElementById('leave-monthly-title');
    if (title) title.innerText = `📅 ${FISCAL_YEAR}년 연차 사용 현황 (년차·월차)`;
    if (box) box.innerHTML = renderMonthlyTableHtml(FISCAL_YEAR, myLeaveRequests, 'leave-monthly-table');
}

// -----------------------------------------------------------------
// 5. 신청 폼 (휴가 종류 / 기간 / 사유 / 비상연락처)
// -----------------------------------------------------------------

// 기간 → 날짜별 내역 (주말·공휴일 제외, 하루만 선택 시 반차 0.5일)
function buildLeaveLogs(startDate, endDate, halfDay) {
    if (!startDate || !endDate || startDate > endDate) return [];
    const logs = [];
    const cur = parseYmd(startDate);
    const last = parseYmd(endDate);
    for (let guard = 0; cur <= last && guard < 366; guard++) {
        const ymd = toYmd(cur);
        if (!isOffDay(ymd)) logs.push({ date: ymd, type: 'full', days: 1 });
        cur.setDate(cur.getDate() + 1);
    }
    // 반차: 하루면 그날, 여러 날이면 오후반차=첫날 / 오전반차=마지막 날만 0.5일
    if (logs.length > 0 && halfDay !== 'full') {
        const target = halfDay === 'pm' ? logs[0] : logs[logs.length - 1];
        target.type = halfDay;
        target.days = 0.5;
    }
    return logs;
}

function getSelectedLeaveType() {
    const checked = document.querySelector('input[name="leave-type"]:checked');
    return checked ? checked.value : "";
}

function onLeaveTypeChange() {
    const type = getSelectedLeaveType();
    const etcInput = document.getElementById('leave-type-etc');
    if (etcInput) etcInput.style.display = (type === 'etc') ? 'inline-block' : 'none';
    const hint = document.getElementById('leave-type-hint');
    if (hint) {
        if (!type) hint.innerText = "휴가 종류를 선택해 주세요.";
        else if (LEAVE_TYPES[type].deduct) hint.innerText = "잔여 연차에서 차감됩니다.";
        else hint.innerText = "잔여 연차에서 차감되지 않습니다.";
    }
}

// 기간·반차 변경 시 일수 재계산 (반차는 항상 선택 가능)
const PERIOD_HINT = "주말·공휴일은 자동으로 제외됩니다. 여러 날 + 반차: 오후반차는 첫날, 오전반차는 마지막 날이 0.5일입니다.";

function updateLeavePeriod() {
    const startEl = document.getElementById('leave-start-date');
    const endEl = document.getElementById('leave-end-date');
    const halfEl = document.getElementById('leave-half-day');

    if (startEl.value && (!endEl.value || endEl.value < startEl.value)) endEl.value = startEl.value;
    endEl.min = startEl.value || `${FISCAL_YEAR - 1}-01-01`;

    const logs = buildLeaveLogs(startEl.value, endEl.value, halfEl.value);
    const total = logs.reduce((sum, l) => sum + l.days, 0);
    document.getElementById('leave-total-days').innerText = `${total.toFixed(1)} 일`;

    const hint = document.getElementById('leave-period-hint');
    if (hint) {
        if (startEl.value && logs.length === 0) {
            hint.innerHTML = `<span style="color:#dc3545;">선택한 기간이 모두 주말·공휴일입니다.</span>`;
        } else {
            hint.innerText = PERIOD_HINT;
        }
    }
}

function readLeaveForm() {
    const leaveType = getSelectedLeaveType();
    const startDate = document.getElementById('leave-start-date').value;
    const endDate = document.getElementById('leave-end-date').value;
    const halfDay = document.getElementById('leave-half-day').value;
    const detailLogs = buildLeaveLogs(startDate, endDate, halfDay);
    return {
        leaveType,
        leaveTypeEtc: leaveType === 'etc' ? document.getElementById('leave-type-etc').value.trim() : "",
        startDate,
        endDate,
        halfDay,
        reason: document.getElementById('leave-reason').value.trim(),
        emergencyContact: document.getElementById('leave-emergency-contact').value.trim(),
        detailLogs,
        totalDays: detailLogs.reduce((sum, l) => sum + l.days, 0)
    };
}

function resetFormRows() {
    document.querySelectorAll('input[name="leave-type"]').forEach(r => { r.checked = false; });
    ['leave-type-etc', 'leave-start-date', 'leave-end-date', 'leave-reason', 'leave-emergency-contact'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    const halfEl = document.getElementById('leave-half-day');
    if (halfEl) halfEl.value = 'full';
    onLeaveTypeChange();
    updateLeavePeriod();
    currentTempDocId = null;
    originDocIdForRewrite = null;
}

// 임시저장/재작성 내역을 입력 폼으로 복원
function loadLeaveTempData(data) {
    document.querySelectorAll('input[name="leave-type"]').forEach(r => { r.checked = (r.value === data.leaveType); });
    document.getElementById('leave-type-etc').value = data.leaveTypeEtc || "";
    document.getElementById('leave-start-date').value = data.startDate || "";
    document.getElementById('leave-end-date').value = data.endDate || "";
    document.getElementById('leave-reason').value = data.reason || "";
    document.getElementById('leave-emergency-contact').value = data.emergencyContact || "";
    document.getElementById('leave-half-day').value = data.halfDay || 'full';
    onLeaveTypeChange();
    updateLeavePeriod();
}

// -----------------------------------------------------------------
// 6. 임시저장
// -----------------------------------------------------------------
function saveLeaveTemporary(event) {
    if (event) event.preventDefault();
    const form = readLeaveForm();

    if (!form.leaveType && !form.startDate && !form.reason && !form.emergencyContact) {
        alert("내용이 없습니다. 내용을 입력해 주세요.");
        return;
    }

    const now = new Date();
    const timestampStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + "_" + String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
    // 불러온 임시저장본이 있으면 그 문서를 덮어씀
    const docId = currentTempDocId || `${currentUser.name}_${currentUser.phone}_leavetemp_${timestampStr}`;

    db.collection("leave_temp_requests").doc(docId).set({
        ...form,
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        savedAt: firebase.firestore.FieldValue.serverTimestamp()
    })
    .then(() => {
        alert("임시저장 되었습니다.");
        resetFormRows();
    })
    .catch(err => {
        console.error("임시저장 실패:", err);
        alert("임시저장 중 오류가 발생했습니다.");
    });
}

// -----------------------------------------------------------------
// 7. 최종 제출
// -----------------------------------------------------------------
function submitLeaveForm(event) {
    event.preventDefault();
    const form = readLeaveForm();

    if (!form.leaveType) { alert("휴가 종류를 선택해주세요."); return; }
    if (form.leaveType === 'etc' && !form.leaveTypeEtc) { alert("기타 휴가 내용을 입력해주세요."); document.getElementById('leave-type-etc').focus(); return; }
    if (!form.startDate || !form.endDate) { alert("휴가 기간을 입력해주세요."); document.getElementById('leave-start-date').focus(); return; }
    if (form.startDate.slice(0, 4) !== form.endDate.slice(0, 4)) { alert("연도가 바뀌는 휴가는 연도별로 나누어 신청해주세요."); return; }
    if (form.totalDays <= 0) { alert("선택한 기간이 모두 주말·공휴일입니다. 기간을 다시 확인해주세요."); return; }
    if (!form.reason) { alert("휴가 사유를 입력해주세요."); document.getElementById('leave-reason').focus(); return; }
    if (!form.emergencyContact) { alert("비상연락처를 입력해주세요. (없으면 - 입력)"); document.getElementById('leave-emergency-contact').focus(); return; }

    // 이미 신청(대기·승인)된 날짜와 겹치는지 확인
    const newDates = new Set(form.detailLogs.map(l => l.date));
    const overlapDates = [];
    myLeaveRequests.forEach(({ data }) => {
        if (!ACTIVE_STATUSES.includes(data.status)) return;
        (data.detailLogs || []).forEach(l => { if (newDates.has(l.date)) overlapDates.push(l.date); });
    });
    if (overlapDates.length > 0) {
        alert(`이미 신청된 날짜가 포함되어 있습니다.\n${[...new Set(overlapDates)].sort().join(', ')}`);
        return;
    }

    const fiscalYear = Number(form.startDate.slice(0, 4));
    const deductible = LEAVE_TYPES[form.leaveType].deduct;
    if (deductible && myEmployeeData?.hireDate) {
        const { remaining } = getLeaveBalance(fiscalYear);
        if (form.totalDays > remaining &&
            !confirm(`신청 일수(${formatDays(form.totalDays)}일)가 ${fiscalYear}년 잔여 연차(${formatDays(remaining)}일)보다 많습니다.\n그래도 제출하시겠습니까?`)) {
            return;
        }
    }

    const periodText = form.startDate === form.endDate
        ? `${form.startDate} ${HALF_LABELS[form.halfDay]}`
        : `${form.startDate} ~ ${form.endDate}`;
    if (!confirm(`${leaveTypeLabel(form)} ${formatDays(form.totalDays)}일 (${periodText})\n신청하시겠습니까?`)) return;

    const finalStatus = originDocIdForRewrite ? "재전송" : "대기";
    const leaveData = {
        ...form,
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        department: myEmployeeData?.department || "",
        position: myEmployeeData?.position || "",
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        deductible: deductible,
        fiscalYear: fiscalYear,
        status: finalStatus
    };

    db.collection("leave_requests").add(leaveData)
        .then((ref) => {
            lastSubmittedDocId = ref.id;
            lastSubmittedData = leaveData;
            let promises = [];
            if (originDocIdForRewrite) {
                promises.push(db.collection("leave_requests").doc(originDocIdForRewrite).delete());
            }
            if (currentTempDocId) {
                promises.push(db.collection("leave_temp_requests").doc(currentTempDocId).delete());
            }
            return Promise.all(promises);
        })
        .then(() => {
            showLeaveDone(form); // 완료 창에서 바로 결재 요청 링크 복사
            resetFormRows();
            loadMyLeaveBalance();
        })
        .catch(err => {
            console.error("제출 중 오류 발생:", err);
            alert("제출에 실패했습니다.");
        });
}

// -----------------------------------------------------------------
// 8. 내역 조회 모달 (제출내역 / 임시저장내역 공용)
// -----------------------------------------------------------------
function viewMyLeaveRequests() {
    openLeaveHistoryModal("submitted");
}
function viewLeaveTempRequests() {
    openLeaveHistoryModal("temp");
}

function openLeaveHistoryModal(mode) {
    const modal = document.getElementById('leave-history-modal');
    const tbody = document.getElementById('leave-history-tbody');
    const title = document.getElementById('leave-history-title');
    const detailBox = document.getElementById('leave-detail-view');
    if (!modal || !tbody) return;

    if (detailBox) detailBox.style.display = 'none';
    modal.style.display = 'block';
    title.innerText = (mode === 'temp') ? "나의 임시저장 내역" : "나의 연차 신청 내역";
    tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#888;">불러오는 중...</td></tr>`;

    const colName = (mode === 'temp') ? 'leave_temp_requests' : 'leave_requests';

    db.collection(colName)
        .where("employeeName", "==", currentUser.name)
        .where("employeePhone", "==", currentUser.phone)
        .get()
        .then(snapshot => {
            let items = [];
            snapshot.forEach(doc => items.push({ id: doc.id, data: doc.data() }));
            if (mode !== 'temp') myLeaveRequests = items.slice(); // 서명 진행 상황 최신화
            items.sort((a, b) => {
                const ta = (mode === 'temp') ? (a.data.savedAt?.toDate?.().getTime() || 0) : (a.data.submittedAt?.toDate?.().getTime() || 0);
                const tb = (mode === 'temp') ? (b.data.savedAt?.toDate?.().getTime() || 0) : (b.data.submittedAt?.toDate?.().getTime() || 0);
                return tb - ta;
            });

            tbody.innerHTML = "";
            if (items.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#888;">내역이 없습니다.</td></tr>`;
                return;
            }

            items.forEach(item => {
                const d = item.data;
                const statusCell = (mode === 'temp') ? '' : `<td style="padding:10px; text-align:center;">${renderStatusBadge(d.status)}</td>`;
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.innerHTML = `
                    <td style="padding:10px; text-align:center;"><input type="checkbox" class="leave-row-check" data-doc-id="${item.id}" style="cursor:pointer;" onclick="event.stopPropagation(); this.closest('tr').classList.toggle('leave-row-selected', this.checked);"></td>
                    <td style="padding:10px; text-align:center; font-weight:bold;">${d.leaveType || d.startDate ? leaveTypeLabel(d) + ' · ' : ''}${d.reason || '(사유 없음)'}</td>
                    <td style="padding:10px; text-align:center;">${periodSummary(d)} / ${formatDays(d.totalDays || 0)}일</td>
                    ${statusCell}
                `;
                // 행 아무 데나 클릭해도 선택 (연장근무 제출내역과 동일한 방식)
                tr.onclick = () => {
                    const check = tr.querySelector('.leave-row-check');
                    if (mode === 'temp') {
                        // 임시저장: 여러 건 선택 삭제가 가능하도록 클릭할 때마다 체크 켜기/끄기
                        check.checked = !check.checked;
                        tr.classList.toggle('leave-row-selected', check.checked);
                    } else {
                        // 제출내역: 한 건만 선택 (인쇄·회수·재작성·링크 복사 대상)
                        tbody.querySelectorAll('tr').forEach(row => {
                            row.classList.remove('leave-row-selected');
                            const cb = row.querySelector('.leave-row-check');
                            if (cb) cb.checked = false;
                        });
                        check.checked = true;
                        tr.classList.add('leave-row-selected');
                    }
                    showLeaveDetail(d, item.id, mode);
                };
                tbody.appendChild(tr);
            });
        })
        .catch(err => {
            console.error("내역 조회 실패:", err);
            tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#dc3545;">조회 중 오류가 발생했습니다.</td></tr>`;
        });

    // 하단 액션 버튼
    const actionBox = document.getElementById('leave-history-actions');
    if (actionBox) {
        if (mode === 'temp') {
            actionBox.innerHTML = `
                <button type="button" class="btn-batch-delete" onclick="loadCheckedLeaveTemp()">불러오기</button>
                <button type="button" class="btn-batch-delete" onclick="deleteCheckedLeaveTemp()">선택 삭제</button>
            `;
        } else {
            actionBox.innerHTML = `
                <button type="button" class="btn-submit" onclick="copyCheckedSignLink(this)">🔗 결재 요청 링크 복사</button>
                <button type="button" class="btn-batch-delete" onclick="printCheckedLeaveRequest()">인쇄</button>
                <button type="button" class="btn-batch-delete" onclick="withdrawCheckedLeaveRequest()">회수</button>
                <button type="button" class="btn-batch-delete" onclick="rewriteCheckedLeaveRequest()">재작성</button>
            `;
        }
    }
}

function renderStatusBadge(status) {
    const colors = { "승인": "#007bff", "반려": "#dc3545", "승인취소": "#dc3545", "작성": "#e67e22", "대기": "#2c3e50", "재전송": "#2c3e50" };
    const c = colors[status] || "#6c757d";
    return `<span style="color:${c}; font-weight:bold;">${status || '-'}</span>`;
}

function showLeaveDetail(data, docId, mode) {
    const detailBox = document.getElementById('leave-detail-view');
    if (!detailBox) return;
    detailBox.style.display = 'block';
    detailBox.dataset.docId = docId;
    detailBox.dataset.mode = mode;

    const rowsHtml = (data.detailLogs || []).map(log => {
        const typeLabel = HALF_LABELS[log.type] || log.type;
        return `<tr><td style="text-align:center;">${log.date}</td><td style="text-align:center;">${typeLabel}</td><td style="text-align:center;">${log.days}일</td></tr>`;
    }).join('');

    // 제출된 신청서는 결재란(서명 이미지 포함)을 위에 표시
    const approvalHtml = data.status
        ? `<div class="lp-sheet" style="display: flex; justify-content: flex-end; margin-bottom: 10px;">${renderApprovalTableHtml(data.signatures, false)}</div>`
        : '';

    detailBox.innerHTML = `
        ${approvalHtml}
        <table style="margin:0;">
            <tr><th style="width:20%;">휴가 종류</th><td colspan="3">${leaveTypeLabel(data)}</td></tr>
            <tr><th>휴가 기간</th><td colspan="3">${periodSummary(data)} (${formatDays(data.totalDays || 0)}일)</td></tr>
            <tr><th>사유</th><td colspan="3">${data.reason || '-'}</td></tr>
            <tr><th>비상연락처</th><td colspan="3">${data.emergencyContact || '-'}</td></tr>
            ${data.status ? `<tr><th>상태</th><td colspan="3">${renderStatusBadge(data.status)}</td></tr>` : ''}
            ${data.status ? `<tr><th>결재</th><td colspan="3">${Object.keys(SIGN_SLOTS).map(slot =>
                `${SIGN_SLOTS[slot].replace(' ', '')} ${data.signatures && data.signatures[slot] ? '✅ 서명 완료' : '⬜ 미서명'}`).join('　')}</td></tr>` : ''}
            ${data.rejectReason ? `<tr><th>반려 사유</th><td colspan="3">${data.rejectReason}</td></tr>` : ''}
            ${data.cancelReason ? `<tr><th>승인취소 사유</th><td colspan="3">${data.cancelReason}</td></tr>` : ''}
        </table>
        <table style="margin-top:10px;">
            <thead><tr><th>날짜</th><th>구분</th><th>일수</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;
}

function loadCheckedLeaveTemp() {
    const checked = document.querySelector('#leave-history-tbody .leave-row-check:checked');
    if (!checked) { alert("불러올 내역을 선택해주세요."); return; }
    const docId = checked.dataset.docId;
    db.collection("leave_temp_requests").doc(docId).get().then(doc => {
        if (doc.exists) {
            loadLeaveTempData(doc.data());
            currentTempDocId = docId;
            originDocIdForRewrite = null;
            document.getElementById('leave-history-modal').style.display = 'none';
        }
    });
}

function deleteCheckedLeaveTemp() {
    const checkedBoxes = document.querySelectorAll('#leave-history-tbody .leave-row-check:checked');
    if (checkedBoxes.length === 0) { alert("삭제할 내역을 선택해주세요."); return; }
    if (!confirm("삭제하시겠습니까?")) return;
    const promises = Array.from(checkedBoxes).map(cb => db.collection("leave_temp_requests").doc(cb.dataset.docId).delete());
    Promise.all(promises).then(() => openLeaveHistoryModal("temp"));
}

function withdrawCheckedLeaveRequest() {
    const checked = document.querySelector('#leave-history-tbody .leave-row-check:checked');
    if (!checked) { alert("회수할 내역을 선택해주세요."); return; }
    const docId = checked.dataset.docId;
    db.collection("leave_requests").doc(docId).get().then(doc => {
        if (!doc.exists) return;
        const status = doc.data().status;
        if (status === "승인") { alert("승인된 신청은 회수할 수 없습니다."); return; }
        if (status !== "대기" && status !== "재전송") { alert("대기 상태의 신청만 회수할 수 있습니다."); return; }
        if (!confirm("이 신청을 회수하시겠습니까?")) return;
        db.collection("leave_requests").doc(docId).update({ status: "작성" })
            .then(() => { alert("회수되었습니다."); openLeaveHistoryModal("submitted"); loadMyLeaveBalance(); });
    });
}

function rewriteCheckedLeaveRequest() {
    const checked = document.querySelector('#leave-history-tbody .leave-row-check:checked');
    if (!checked) { alert("재작성할 내역을 선택해주세요."); return; }
    const docId = checked.dataset.docId;
    db.collection("leave_requests").doc(docId).get().then(doc => {
        if (!doc.exists) return;
        const status = doc.data().status;
        if (status !== "반려" && status !== "작성") { alert("반려 또는 회수(작성)된 신청만 재작성할 수 있습니다."); return; }
        if (!confirm("이 내역을 신청서 화면으로 불러오시겠습니까?")) return;
        loadLeaveTempData(doc.data());
        originDocIdForRewrite = docId;
        currentTempDocId = null;
        document.getElementById('leave-history-modal').style.display = 'none';
    });
}

function closeLeaveHistoryModal() {
    document.getElementById('leave-history-modal').style.display = 'none';
}

// ESC 키 단계별 닫기 (연장근무일지 페이지와 동일)
// 1단계: 제출 완료 창 → 2단계: 내역 창 안의 상세내역(선택 해제) → 3단계: 내역 창 전체
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const doneModal = document.getElementById('leave-done-modal');
    const historyModal = document.getElementById('leave-history-modal');
    const detailBox = document.getElementById('leave-detail-view');

    if (doneModal && doneModal.style.display === 'block') {
        doneModal.style.display = 'none';
        return;
    }
    if (historyModal && historyModal.style.display === 'block') {
        if (detailBox && detailBox.style.display === 'block') {
            detailBox.style.display = 'none';
            document.querySelectorAll('#leave-history-tbody tr').forEach(row => {
                row.classList.remove('leave-row-selected');
                const cb = row.querySelector('.leave-row-check');
                if (cb) cb.checked = false;
            });
            return;
        }
        historyModal.style.display = 'none';
    }
});

// -----------------------------------------------------------------
// 9. 휴가신청서 인쇄 (종이 양식과 같은 배치)
// -----------------------------------------------------------------
// 인쇄 대상: 방금 클릭해서 상세를 연 신청서 → 없으면 체크한 신청서
function printCheckedLeaveRequest() {
    const detailBox = document.getElementById('leave-detail-view');
    const checked = document.querySelector('#leave-history-tbody .leave-row-check:checked');
    const docId = (detailBox && detailBox.style.display !== 'none' && detailBox.dataset.mode === 'submitted')
        ? detailBox.dataset.docId
        : (checked ? checked.dataset.docId : null);
    if (!docId) { alert("인쇄할 내역을 클릭하거나 선택해주세요."); return; }

    db.collection("leave_requests").doc(docId).get().then(doc => {
        if (!doc.exists) { alert("신청 내역을 찾을 수 없습니다."); return; }
        printLeaveSheet(doc.data());
    }).catch(err => {
        console.error("인쇄 데이터 로드 실패:", err);
        alert("인쇄 데이터를 불러오는 중 오류가 발생했습니다.");
    });
}

// 미리보기 없이 바로 인쇄창 열기 (로고·서명 이미지가 다 불러와진 뒤 인쇄)
function printLeaveSheet(data) {
    const body = document.getElementById('leave-print-body');
    if (!body) return;

    body.innerHTML = renderLeaveSheetHtml({
        ...data,
        department: data.department || myEmployeeData?.department || '',
        position: data.position || myEmployeeData?.position || ''
    }, myLeaveRequests);

    const images = Array.from(body.querySelectorAll('img'));
    Promise.all(images.map(img => img.complete ? Promise.resolve()
        : new Promise(resolve => { img.onload = img.onerror = resolve; })))
        .then(() => window.print());
}

function closeLeavePrint() {
    const modal = document.getElementById('print-modal');
    if (modal) modal.style.display = 'none';
}

// -----------------------------------------------------------------
// 10. ✍️ 결재 서명 요청 링크 복사 (사원이 카카오톡에 붙여넣어 결재자에게 전달)
// - 링크는 신청서당 1개, 받은 사람이 비어 있는 결재칸(과장/전무)을 골라 서명
// - SIGN_LINK_HOURS(3시간) 후 만료, 새로 복사하면 이전 링크는 즉시 무효
// -----------------------------------------------------------------
let lastSubmittedDocId = null;   // 방금 제출한 신청서 (완료 창의 [공유하기]용)
let lastSubmittedData = null;

// 짧은 링크 코드 (영문 대소문자+숫자 10자리, 짐작 불가)
function makeSignToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join('');
}

// 실제 사이트는 /s/코드 짧은 주소, 내 컴퓨터 미리보기는 짧은 주소가 없어 파일 경로 사용
function buildSignUrl(token) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) || location.protocol === 'file:';
    return isLocal
        ? new URL(`leave-sign.html?c=${token}`, location.href).href
        : `${location.origin}/s/${token}`;
}

// 알림 토스트: anchorEl(누른 버튼)이 있으면 그 버튼 바로 위에 표시
function showLeaveToast(message, anchorEl) {
    const toast = document.getElementById('leave-toast');
    if (!toast) return;
    toast.innerText = message;
    if (anchorEl) {
        const r = anchorEl.getBoundingClientRect();
        toast.style.left = `${r.left + r.width / 2}px`;
        toast.style.top = `${Math.max(r.top - 8, 50)}px`;
    } else {
        toast.style.left = '50%';
        toast.style.top = '60px';
    }
    toast.classList.add('show');
    clearTimeout(showLeaveToast.timer);
    showLeaveToast.timer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// 클립보드 복사 (지원하지 않는 환경은 예전 방식 → 그래도 안 되면 직접 복사 안내)
function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
    });
}

function formatDateTime(ms) {
    const dt = new Date(ms);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

// 새 서명 링크 생성·저장 (이전 링크는 무효) → { url, text, expiresAt }
function createSignLink(docId, d) {
    const token = makeSignToken();
    const expiresAt = Date.now() + SIGN_LINK_HOURS * 60 * 60 * 1000;
    const url = buildSignUrl(token);
    const text = `[연차 결재 요청] ${d.employeeName} · ${leaveTypeLabel(d)} ${formatDays(d.totalDays || 0)}일 (${periodSummary(d)})\n${formatDateTime(expiresAt)}까지 서명 부탁드립니다.\n${url}`;

    db.collection("leave_requests").doc(docId).update({ signLink: { token, expiresAt } })
        .catch(err => {
            console.error("서명 링크 저장 실패:", err);
            alert("링크 저장에 실패했습니다. 보낸 링크가 작동하지 않을 수 있으니 다시 복사해주세요.");
        });
    return { url, text, expiresAt };
}

function copyLinkText(link, anchorEl) {
    copyTextToClipboard(link.text)
        .then(() => showLeaveToast("링크가 복사되었습니다", anchorEl))
        .catch(() => prompt("자동 복사가 되지 않았습니다. 아래 링크를 복사해서 보내주세요.", link.url));
}

// 제출내역조회의 [결재 요청 링크 복사]: 누를 때마다 새 링크(3시간) 생성
function copyCheckedSignLink(anchorEl) {
    const checked = document.querySelector('#leave-history-tbody .leave-row-check:checked');
    if (!checked) { alert("결재를 요청할 신청서를 선택해주세요."); return; }
    const docId = checked.dataset.docId;
    const req = myLeaveRequests.find(r => r.id === docId);
    if (!req) { alert("신청 내역을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요."); return; }
    const d = req.data;
    if (!ACTIVE_STATUSES.includes(d.status)) { alert("대기 중인 신청서만 결재를 요청할 수 있습니다."); return; }
    if (Object.keys(SIGN_SLOTS).every(slot => d.signatures && d.signatures[slot])) { alert("결재 서명이 모두 완료된 신청서입니다."); return; }
    copyLinkText(createSignLink(docId, d), anchorEl);
}

// 제출 완료 창: 창을 띄울 때 링크를 만들어 두고, 유효시간을 그대로 표시
let preparedSignLink = null;

function showLeaveDone(form) {
    preparedSignLink = createSignLink(lastSubmittedDocId, lastSubmittedData);
    document.getElementById('leave-done-summary').innerText =
        `${leaveTypeLabel(form)} ${formatDays(form.totalDays)}일 (${periodSummary(form)})`;
    document.getElementById('leave-done-hours').innerText = `링크 유효시간: ~${formatDateTime(preparedSignLink.expiresAt)}`;
    document.getElementById('leave-done-modal').style.display = 'block';
}

function copyPreparedSignLink(anchorEl) {
    if (!preparedSignLink) return;
    copyLinkText(preparedSignLink, anchorEl);
}

function closeLeaveDone() {
    document.getElementById('leave-done-modal').style.display = 'none';
}
