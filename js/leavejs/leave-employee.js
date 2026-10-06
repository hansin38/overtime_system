// ==========================================
// leave-employee.js (연차 신청 화면 전용 로직)
// ⚠️ 로그인/라우팅은 index.html + index.js가 담당합니다.
//    이 파일은 employee.js와 같은 역할 - "로그인 이후" 화면 로직입니다.
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
let myEmployeeData = null;        // employees 컬렉션에서 읽어온 내 정보(hireDate 포함)

const FISCAL_YEAR = new Date().getFullYear(); // 회계연도 = 달력 연도(1/1~12/31) 기준

// -----------------------------------------------------------------
// 2. 로그인 가드 / 로그아웃 (employee.js와 동일한 패턴)
// -----------------------------------------------------------------
function logoutLeaveUser() {
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

    resetFormRows();
    loadMyLeaveBalance();
});

// -----------------------------------------------------------------
// 3. 연차 자동계산 로직 (핵심)
// -----------------------------------------------------------------

/**
 * 입사일자와 회계연도를 기준으로 해당 연도의 "발생 연차 일수"를 계산합니다.
 * - 입사 연도: 입사월부터 12월까지 근무 개월수만큼 부여 (최대 11일)
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

/**
 * 내 정보(입사일자)와 신청 내역을 불러와 상단 연차 현황(발생/사용/잔여)을 갱신합니다.
 * '작성'(회수됨) 상태는 사용량에서 제외하고, '대기'+'승인'만 사용량으로 집계합니다.
 */
function loadMyLeaveBalance() {
    const box = document.getElementById('leave-balance-box');
    if (box) box.innerHTML = `연차 정보를 불러오는 중...`;

    db.collection("employees")
        .where("name", "==", currentUser.name)
        .where("phoneLast4", "==", currentUser.phone)
        .get()
        .then((snapshot) => {
            if (snapshot.empty) {
                if (box) box.innerHTML = `<span style="color:#dc3545;">사원 정보를 찾을 수 없습니다. 관리자에게 문의해주세요.</span>`;
                return;
            }
            myEmployeeData = snapshot.docs[0].data();

            if (!myEmployeeData.hireDate) {
                if (box) box.innerHTML = `<span style="color:#dc3545;">입사일자가 등록되지 않았습니다. 관리자에게 등록을 요청해주세요.</span>`;
                return;
            }

            const entitlement = calcAnnualLeaveEntitlement(myEmployeeData.hireDate, FISCAL_YEAR);

            // 올해(회계연도) 신청 내역 중 대기/승인 건만 집계
            db.collection("leave_requests")
                .where("employeeName", "==", currentUser.name)
                .where("employeePhone", "==", currentUser.phone)
                .where("fiscalYear", "==", FISCAL_YEAR)
                .get()
                .then((reqSnap) => {
                    let used = 0;
                    reqSnap.forEach(doc => {
                        const d = doc.data();
                        if (d.status === "대기" || d.status === "승인" || d.status === "재전송") {
                            used += (d.totalDays || 0);
                        }
                    });
                    const remaining = Math.max(0, entitlement - used);
                    renderBalanceBox(entitlement, used, remaining);
                });
        })
        .catch(err => {
            console.error("연차 정보 조회 실패:", err);
            if (box) box.innerHTML = `<span style="color:#dc3545;">연차 정보 조회 중 오류가 발생했습니다.</span>`;
        });
}

function renderBalanceBox(entitlement, used, remaining) {
    const box = document.getElementById('leave-balance-box');
    if (!box) return;
    box.innerHTML = `
        <span>${FISCAL_YEAR}년도 발생 연차: <b>${entitlement}일</b></span>
        <span style="margin-left:14px;">사용(대기+승인): <b>${used}일</b></span>
        <span style="margin-left:14px; color:#007bff;">잔여 연차: <b>${remaining}일</b></span>
    `;
}

// -----------------------------------------------------------------
// 4. 신청 폼 (사유 / 비상연락처)
// -----------------------------------------------------------------
// ⚠️ TODO: 날짜 입력 UI는 추후 별도 논의 후 추가 예정입니다.
//    그 전까지는 totalDays를 0으로 저장하므로, 상단 "잔여 연차" 자동차감은
//    날짜 입력이 추가되기 전까지는 실제 사용일수를 반영하지 못합니다.
function resetFormRows() {
    const reasonInput = document.getElementById('leave-reason');
    if (reasonInput) reasonInput.value = "";
    const contactInput = document.getElementById('leave-emergency-contact');
    if (contactInput) contactInput.value = "";
    currentTempDocId = null;
    originDocIdForRewrite = null;
}

// -----------------------------------------------------------------
// 5. 임시저장
// -----------------------------------------------------------------
function saveLeaveTemporary(event) {
    if (event) event.preventDefault();
    const reason = document.getElementById('leave-reason').value.trim();
    const contact = document.getElementById('leave-emergency-contact').value.trim();

    if (!reason && !contact) {
        alert("내용이 없습니다. 내용을 입력해 주세요.");
        return;
    }

    const now = new Date();
    const timestampStr = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + "_" + String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
    const docId = `${currentUser.name}_${currentUser.phone}_leavetemp_${timestampStr}`;

    db.collection("leave_temp_requests").doc(docId).set({
        reason: reason,
        emergencyContact: contact,
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        savedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalDays: 0, // TODO: 날짜 UI 추가 후 연결
        detailLogs: []
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

function loadLeaveTempData(data) {
    if (document.getElementById('leave-reason')) document.getElementById('leave-reason').value = data.reason || "";
    if (document.getElementById('leave-emergency-contact')) document.getElementById('leave-emergency-contact').value = data.emergencyContact || "";
}

// -----------------------------------------------------------------
// 6. 최종 제출
// -----------------------------------------------------------------
function submitLeaveForm(event) {
    event.preventDefault();

    const reason = document.getElementById('leave-reason').value.trim();
    const contact = document.getElementById('leave-emergency-contact').value.trim();

    if (!reason) { alert("사유를 입력해주세요."); document.getElementById('leave-reason').focus(); return; }
    if (!contact) { alert("비상연락처를 입력해주세요."); document.getElementById('leave-emergency-contact').focus(); return; }

    if (!confirm(`연차를 신청하시겠습니까?`)) return;

    const finalStatus = originDocIdForRewrite ? "재전송" : "대기";
    const leaveData = {
        reason: reason,
        emergencyContact: contact,
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalDays: 0, // TODO: 날짜 UI 추가 후 연결 - 잔여연차 자동차감에 사용됨
        fiscalYear: FISCAL_YEAR,
        status: finalStatus,
        detailLogs: []
    };

    db.collection("leave_requests").add(leaveData)
        .then(() => {
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
            alert("연차 신청이 성공적으로 제출되었습니다.");
            originDocIdForRewrite = null;
            currentTempDocId = null;
            resetFormRows();
            loadMyLeaveBalance();
        })
        .catch(err => {
            console.error("제출 중 오류 발생:", err);
            alert("제출에 실패했습니다.");
        });
}

// -----------------------------------------------------------------
// 7. 내역 조회 모달 (제출내역 / 임시저장내역 공용)
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
                const dateStr = (mode === 'temp')
                    ? (d.savedAt?.toDate?.().toLocaleDateString() || '-')
                    : (d.submittedAt?.toDate?.().toLocaleDateString() || '-');
                const statusCell = (mode === 'temp') ? '' : `<td style="padding:10px; text-align:center;">${renderStatusBadge(d.status)}</td>`;
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.innerHTML = `
                    <td style="padding:10px; text-align:center;"><input type="checkbox" class="leave-row-check" data-doc-id="${item.id}" onclick="event.stopPropagation();"></td>
                    <td style="padding:10px; text-align:center; font-weight:bold;">${d.reason || '(사유 없음)'}</td>
                    <td style="padding:10px; text-align:center;">${dateStr} / ${d.totalDays || 0}일</td>
                    ${statusCell}
                `;
                tr.onclick = () => showLeaveDetail(d, item.id, mode);
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
                <button type="button" class="btn-batch-delete" onclick="withdrawCheckedLeaveRequest()">회수</button>
                <button type="button" class="btn-batch-delete" onclick="rewriteCheckedLeaveRequest()">재작성</button>
            `;
        }
    }
}

function renderStatusBadge(status) {
    const colors = { "승인": "#007bff", "반려": "#dc3545", "작성": "#e67e22", "대기": "#2c3e50", "재전송": "#2c3e50" };
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
        const typeLabel = { full: '전일', am: '오전 반차', pm: '오후 반차' }[log.type] || log.type;
        return `<tr><td style="text-align:center;">${log.date}</td><td style="text-align:center;">${typeLabel}</td><td style="text-align:center;">${log.days}일</td></tr>`;
    }).join('');

    detailBox.innerHTML = `
        <table style="margin:0;">
            <tr><th style="width:20%;">사유</th><td colspan="3">${data.reason || '-'}</td></tr>
            <tr><th>비상연락처</th><td colspan="3">${data.emergencyContact || '-'}</td></tr>
            ${data.status ? `<tr><th>상태</th><td colspan="3">${renderStatusBadge(data.status)}</td></tr>` : ''}
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
            currentTempDocId = docId;
            loadLeaveTempData(doc.data());
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