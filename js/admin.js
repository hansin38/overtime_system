const firebaseConfig = {
    apiKey: "AIzaSyCpMIytCpZ5F5JRoKABJE7kkgv_RZReFRc",
    authDomain: "hansin-df749.firebaseapp.com",
    projectId: "hansin-df749",
    storageBucket: "hansin-df749.firebasestorage.app",
    messagingSenderId: "908820835514",
    appId: "1:908820835514:web:0e02c604c7cf775d5f2683"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

let currentTabStatus = "대기";
let empMapCache = {};    // 이름 → { employee, profile } (결재 내역 로드 시 갱신, 초과수당 시급 계산용)
let limitMapCache = {};  // 사원별 고정OT 시간

// 1. 페이지 로드 시 처리
// 🔐 관리자 로그인은 Firebase 이메일 로그인 (계정은 Firebase 콘솔 > Authentication에서 관리)
// 급여 정보는 이 로그인을 한 경우에만 읽고 쓸 수 있음 (firestore.rules 참고)
let adminStarted = false;
auth.onAuthStateChanged(user => {
    if (user) {
        if (!adminStarted) { adminStarted = true; startAdminSystem(); }
    } else {
        document.getElementById('admin-system').style.display = 'none';
        document.getElementById('admin-login').style.display = 'block';
    }
});

function startAdminSystem() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-system').style.display = 'block';

    // 날짜 기본 필터 설정 (기본은 전체 조회로 날짜 비워둠)
    setDateRange('all');

    const userInfo = document.getElementById('admin-user-email');
    if (userInfo && auth.currentUser) userInfo.innerText = auth.currentUser.email;

    migrateLegacyWages().finally(() => loadAdminData());
    loadSearchEmployeeList();
    bindSearchAndActionEvents();

    // 새로고침 전에 보던 탭으로 (기본은 연장근로 결재)
    const lastTab = recallAdminView('adminTab');
    if (['leave', 'pay', 'staff', 'assoc', 'hrinfo', 'hrcareer'].includes(lastTab)) switchAdminTab(lastTab);
}

// 🔐 관리자 로그인 (브라우저 탭을 닫으면 로그아웃되도록 SESSION 유지)
function handleAdminLogin() {
    const email = document.getElementById('admin-email').value.trim();
    const pw = document.getElementById('admin-pw').value;
    if (!email || !pw) { alert("이메일과 비밀번호를 입력해 주세요."); return; }

    auth.setPersistence(firebase.auth.Auth.Persistence.SESSION)
        .then(() => auth.signInWithEmailAndPassword(email, pw))
        .catch(err => {
            console.error("관리자 로그인 실패:", err);
            alert("관리자 정보가 일치하지 않습니다.");
        });
}

// 🔁 예전 사원정보(employees)에 들어 있던 통상시급을 관리자 전용 급여정보로 옮기고 원래 칸은 삭제
// (사원 로그인 화면이 employees를 누구나 읽을 수 있어서, 금액 정보는 그곳에 두지 않음)
function migrateLegacyWages() {
    return db.collection("employees").get().then(snapshot => {
        const jobs = snapshot.docs
            .filter(doc => doc.data().hourlyWage !== undefined)
            .map(doc => db.collection("payroll_profiles").doc(doc.id)
                .set({ legacyHourlyWage: Number(doc.data().hourlyWage) || null }, { merge: true })
                .then(() => doc.ref.update({ hourlyWage: firebase.firestore.FieldValue.delete() })));
        return Promise.all(jobs);
    }).catch(err => console.error("통상시급 이전 실패:", err));
}

// 드롭다운 변경 시 필터 즉시 적용 바인딩
function bindSearchAndActionEvents() {
    const selectEl = document.getElementById('search-employee-name');
    if (selectEl) {
        selectEl.addEventListener('change', () => {
            applyFilters();
        });
    }
    const statusEl = document.getElementById('search-status');
    if (statusEl) {
        statusEl.addEventListener('change', () => {
            applyFilters();
        });
    }
}

// 2. 🔍 검색용 드롭다운 메뉴에 DB의 사원 리스트 뿌리기
function loadSearchEmployeeList() {
    const selectEl = document.getElementById('search-employee-name');
    if (!selectEl) return;

    db.collection("employees").orderBy("name", "asc").get()
        .then((snapshot) => {
            selectEl.innerHTML = '<option value="">선택</option>';
            
            snapshot.forEach((doc) => {
                const data = doc.data();
                const option = document.createElement('option');
                option.value = data.name;
                option.innerText = data.name;
                selectEl.appendChild(option);
            });
        })
        .catch((error) => {
            console.error("검색용 사원 목록 로드 중 오류:", error);
        });
}

// 4. 📅 기간 퀵 버튼 설정 헬퍼 함수
function setDateRange(rangeType) {
    const startDateInput = document.getElementById('search-start-date');
    const endDateInput = document.getElementById('search-end-date');
    if (!startDateInput || !endDateInput) return;

    const today = new Date();
    today.setHours(23, 59, 59, 999); // 오늘의 끝 시간 설정
    
    let start = new Date();
    start.setHours(0, 0, 0, 0); // 오늘의 시작 시간 설정

    if (rangeType === 'all') {
        startDateInput.value = '';
        endDateInput.value = '';
        return;
    }

    switch (rangeType) {
        case 'today':
            // start는 그대로 오늘 시작일시 사용
            break;
        case '3days':
            start.setDate(today.getDate() - 2);
            break;
        case 'week':
            start.setDate(today.getDate() - 6);
            break;
        case 'month':
            start.setMonth(today.getMonth() - 1);
            break;
        case '6months':
            start.setMonth(today.getMonth() - 6);
            break;
        case 'year':
            start.setFullYear(today.getFullYear() - 1);
            break;
    }

    // YYYY-MM-DD 포맷 변환 후 투입
    startDateInput.value = start.toISOString().split('T')[0];
    endDateInput.value = today.toISOString().split('T')[0];
}

// 필터 통합 실행 호출
function applyFilters() {
    const searchName = document.getElementById('search-employee-name')?.value || "";
    const searchStatus = document.getElementById('search-status')?.value || "전체";
    const startDateVal = document.getElementById('search-start-date')?.value || "";
    const endDateVal = document.getElementById('search-end-date')?.value || "";

    currentTabStatus = searchStatus; 
    loadAdminData(searchName, searchStatus, startDateVal, endDateVal);
}

function logoutAdmin() {
    auth.signOut().then(() => location.reload()); // 새로고침하면 관리자 로그인 화면으로 돌아감
}

// 초과수당 시급은 급여 관리와 같은 계산을 씀 → js/payroll-core.js 의 expenseWageInfo() 하나만 고치면 두 화면이 같이 바뀜
// 신청서마다 그 신청의 귀속 월(requestMonth) 급여조건으로 계산 (연봉 인상 이력 반영)
function wageInfoFor(nameKey, req) {
    const who = empMapCache[nameKey];
    if (!who) return { wage: 10000, label: '사원 미등록', ordinary: false };
    return expenseWageInfo(who.profile, who.employee, requestMonth(req));
}

// 6. 결재 내역 로드 (사원별 경비 시급·고정OT 반영)
function loadAdminData(searchName = "", targetStatus = "전체", startDateVal = "", endDateVal = "") {
    // 1) 전체 사원의 급여조건·고정OT 매핑 맵 생성
    Promise.all([db.collection("employees").get(), db.collection("payroll_profiles").get()]).then(([empSnapshot, profSnapshot]) => {
        const profiles = {};
        profSnapshot.forEach(doc => { profiles[doc.id] = doc.data(); });
        // 경비 시급 기준 1회 설정 (js/payroll-core.js) - 결재 화면을 먼저 열어도 같은 기준으로 보이게
        applyExpenseBasisDefaults(profiles, empSnapshot.docs.map(d => ({ id: d.id, ...d.data() })));
        const empMap = {}, limitMap = {};
        empSnapshot.forEach(doc => {
            const emp = doc.data();
            if (emp.name) {
                const cleanName = emp.name.trim();
                empMap[cleanName] = { employee: { id: doc.id, ...emp }, profile: profiles[doc.id] || {} };
                limitMap[cleanName] = getFixOtLimits(emp);
            }
        });
        empMapCache = empMap;
        limitMapCache = limitMap;

        // 2) 신청 내역 가져오기
        let query = db.collection("overtime_requests");
        
        if (targetStatus && targetStatus !== "전체") {
            query = query.where("status", "==", targetStatus);
        }
        if (searchName) {
            query = query.where("employeeName", "==", searchName);
        }
        
        query.get().then(snapshot => {
            const tbody = document.getElementById('admin-tbody');
            if (!tbody) return;

            const titleEl = document.getElementById('table-title');
            if (titleEl) {
                if (targetStatus === '전체') titleEl.innerHTML = "📜 전체 결재 내역";
                else if (targetStatus === '대기') titleEl.innerHTML = "📜 결재 대기 내역";
                else if (targetStatus === '재전송') titleEl.innerHTML = "📜 결재 재전송 내역";
                else if (targetStatus === '승인') titleEl.innerHTML = "📜 결재 승인 내역";
                else if (targetStatus === '반송') titleEl.innerHTML = "📜 결재 반송 내역";
            }
            
            if (snapshot.empty) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: #888;">내역이 존재하지 않습니다.</td></tr>`;
                return;
            }

            let docs = snapshot.docs;

            if (startDateVal || endDateVal) {
                const startLimit = startDateVal ? new Date(startDateVal + "T00:00:00") : null;
                const endLimit = endDateVal ? new Date(endDateVal + "T23:59:59") : null;

                docs = docs.filter(doc => {
                    const data = doc.data();
                    if (!data.submittedAt) return false;
                    const subDate = data.submittedAt.toDate();
                    
                    if (startLimit && subDate < startLimit) return false;
                    if (endLimit && subDate > endLimit) return false;
                    return true;
                });
            }

            if (docs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px; color: #888;">지정된 기간 내의 결재 내역이 존재하지 않습니다.</td></tr>`;
                return;
            }

            const sortedDocs = docs.sort((a, b) => {
                const dateA = a.data().submittedAt ? a.data().submittedAt.toDate() : new Date(0);
                const dateB = b.data().submittedAt ? b.data().submittedAt.toDate() : new Date(0);
                return dateB - dateA; 
            });

            tbody.innerHTML = sortedDocs.map(doc => {
                const data = doc.data();
                const formattedDate = data.submittedAt ? data.submittedAt.toDate().toLocaleDateString() : "-";
                
                // 💰 신청서의 직원명과 사원 DB 이름 매칭
                const empNameKey = data.employeeName ? data.employeeName.trim() : "";
                const empWage = wageInfoFor(empNameKey, data).wage;
                const payInfo = calculateOvertimePay(data.detailLogs, empWage, limitMap[empNameKey]);

                let statusColor = "var(--success-color)";
                if (data.status === '반송') statusColor = "var(--danger-color)";
                else if (data.status === '재전송') statusColor = "#3498db";
                else if (data.status === '대기') statusColor = "#f39c12";

                return `<tr>
                    <td>${formattedDate}</td>
                    <td>${data.employeeName}</td>
                    <td>${data.employeePhone ? data.employeePhone.slice(-4) : "-"}</td>
                    <td><b>${data.totalHours} 시간</b></td>
                    <td>
                        ${payInfo.overtimePay > 0
                            ? `<b style="color: var(--danger-color);">${payInfo.overtimePay.toLocaleString()}원</b>`
                            : `<small style="color: #888;">고정OT 범위 내</small>`}
                    </td>
                    <td>
                        <span class="status-badge" style="color: ${statusColor};">${data.status}</span>
                    </td>
                    <td style="text-align: center;">
                        <div style="display: inline-flex; gap: 4px; justify-content: center; align-items: center; width: 100%;">
                            <button onclick="viewDetails('${doc.id}')" class="btn-batch-delete" style="padding: 5px 8px; font-size: 12px; height: 32px; white-space: nowrap;">상세보기</button>
                            ${(data.status === '대기' || data.status === '재전송') ? `
                                <button onclick="processRequest('${doc.id}', '승인')" class="btn-submit" style="background-color: var(--success-color); padding: 5px 10px; font-size: 12px; height: 32px; white-space: nowrap;">승인</button>
                                <button onclick="processRequest('${doc.id}', '반송')" class="btn-batch-delete" style="color: var(--danger-color); border-color: var(--danger-color); padding: 5px 10px; font-size: 12px; height: 32px; white-space: nowrap;">반송</button>
                            ` : ''}
                        </div>
                    </td>
                </tr>`;
            }).join('');
        }).catch(err => console.error("결재 내역 불러오기 실패:", err));
    }).catch(err => console.error("사원 시급 로드 실패:", err));
}

// 단건 승인/반송 처리
function processRequest(docId, status) {
    let updateData = { status };
    if (status === '반송') {
        const reason = prompt("반송 사유를 입력하세요 (빈 칸으로 확인 누르면 기본 문구 입력):");
        if (reason === null) return; 
        updateData.rejectReason = reason.trim() === "" ? "관리자 일괄 반송(사유 생략)" : reason;
    }
    
    db.collection("overtime_requests").doc(docId).update(updateData).then(() => {
        // 승인되면 그 사원·그 달 경비(초과근무수당) 명세서를 자동으로 만들거나 다시 계산 (js/payroll-core.js)
        if (status === '승인') return onOvertimeApproved(docId);
    }).then(() => {
        alert("처리되었습니다.");
        applyFilters(); // 필터 유지를 반영한 새로고침
    });
}

// 7. 결재 건별 상세 내역 
function viewDetails(docId) {
    db.collection("overtime_requests").doc(docId).get().then(doc => {
        if (!doc.exists) return alert("신청 내역을 찾을 수 없습니다.");
        const data = doc.data();
        const sheet = document.getElementById('modal-sheet');
        if (!sheet) return;
        detailPrintData = data;

        const logs = Array.isArray(data.detailLogs) ? data.detailLogs : [];
        const empNameKey = data.employeeName ? data.employeeName.trim() : "";
        const wageInfo = wageInfoFor(empNameKey, data);
        const limits = limitMapCache[empNameKey] || FIX_OT_LIMITS;
        const payInfo = calculateOvertimePay(logs, wageInfo.wage, limits);
        renderPaySummary(data.employeeName || "-", wageInfo, payInfo, limits);
        detailPrintPay = { wageInfo, payInfo, limits };

        // 아래 내역: 직원 화면 제출내역조회·인쇄와 같은 확인서 양식 (사유까지 보임)
        sheet.innerHTML = renderOvertimeSheetHtml(data, { pay: detailPrintPay });   // 관리자만: 초과수당 정산 줄 포함
        document.getElementById('detail-modal').style.display = "flex";
        const box = document.querySelector('#detail-modal .modal-content');
        if (box) box.scrollTop = 0;
    });
}

function closeModal() {
    document.getElementById('detail-modal').style.display = "none";
}

// 🖨️ 상세보기 인쇄: 따로 만든 인쇄 창(iframe)에 양식만 넣어 인쇄 (관리자 화면·다른 창은 안 찍힘)
// 연장근로 → 직원 화면과 같은 '연장근로 신청 확인서' (js/ot-sheet.js) · 연차 → 상세보기에 보이는 휴가신청서 그대로
let detailPrintData = null, detailPrintPay = null;
function printHtmlInFrame(html, title) {
    const old = document.getElementById('detail-print-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'detail-print-frame';
    frame.style.cssText = 'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0;';
    document.body.appendChild(frame);
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map(l => `<link rel="stylesheet" href="${l.href}">`).join('');
    const doc = frame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><base href="${location.href}"><title>${title}</title>${links}
        <style>
            @page { size: A4; margin: 10mm; }
            html, body { margin: 0; padding: 0; background: #fff; }
            /* style.css 인쇄 규칙(#print-modal만 보이게)을 이 창에서는 풀어 줌 */
            body, body * { visibility: visible !important; }
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        </style></head><body>${html}</body></html>`);
    doc.close();
    const waits = Array.from(doc.querySelectorAll('link')).map(link => new Promise(resolve => { if (link.sheet) resolve(); else link.onload = link.onerror = resolve; }))
        .concat(Array.from(doc.images).map(img => img.complete ? Promise.resolve()
            : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    Promise.all(waits).then(() => {
        printFrameAndReturnFocus(frame);
    });
}

function printOvertimeDetail() {
    if (!detailPrintData) return;
    printOvertimeSheetA4(detailPrintData, { pay: detailPrintPay });   // 직원 화면 인쇄와 같은 함수 (js/ot-sheet.js)
}

function printLeaveDetail() {
    const sheet = document.getElementById('leave-detail-sheet').innerHTML;
    const extra = document.getElementById('leave-detail-extra').innerHTML;
    printHtmlInFrame(sheet + (extra ? `<div style="margin: 12px 15mm 0; font-size: 12px;">${extra}</div>` : ''), '휴가신청서');
}

// 💰 상세보기 상단 요약: 구분별 사용/한도(사원 화면과 동일 형식) + 가산율별 초과수당 + 총 지급액
function renderPaySummary(name, wageInfo, payInfo, limits = FIX_OT_LIMITS) {
    const wageText = wageInfo.wage.toLocaleString(undefined, { maximumFractionDigits: wageInfo.ordinary ? 2 : 0 });
    const box = document.getElementById('modal-summary');
    if (!box) return;
    const labels = { overtime: '연장', holiday: '휴일', night: '야간' };
    const overKeys = Object.keys(limits).filter(k => payInfo.used[k] > limits[k]);

    const usage = Object.keys(limits).map(k => {
        const color = overKeys.includes(k) ? 'var(--danger-color)' : '#888';
        return `<span style="color: ${color};">${labels[k]} ${payInfo.used[k].toFixed(1)}/${Math.floor(limits[k] * 2) / 2}</span>`;
    }).join(' · ');

    const badge = overKeys.length > 0
        ? `<span class="status-badge over-ot">★초과수당 지급대상 (${overKeys.map(k => labels[k]).join('·')} 초과)</span>`
        : `<span class="status-badge under-ot">고정OT 범위 내</span>`;

    const lines = payInfo.lines.map(l =>
        `<div style="display: flex; justify-content: space-between;">
            <span>${labels[l.bucket]} 초과 ${Math.round(l.hours * 100) / 100}h × ${Math.round(l.rate * 100)}%</span>
            <span>${Math.round(l.pay).toLocaleString()}원</span>
        </div>`
    ).join('');

    box.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 6px;">${name} · 초과수당 시급 ${wageText}원 <small style="color: #888; font-weight: normal;">(${wageInfo.label})</small></div>
        <div style="margin-bottom: 8px;">${usage}</div>
        <div style="margin-bottom: 10px;">${badge}</div>
        ${lines ? `<div style="border-top: 1px solid #dee2e6; padding-top: 8px;">${lines}</div>` : ''}
        <div style="display: flex; justify-content: space-between; border-top: 1px solid #dee2e6; margin-top: 8px; padding-top: 8px; font-weight: bold;">
            <span>총 지급액 <small style="color: #888; font-weight: normal;">(10원 단위 반올림)</small></span>
            <span style="color: ${payInfo.overtimePay > 0 ? 'var(--danger-color)' : '#888'};">${payInfo.overtimePay.toLocaleString()}원</span>
        </div>`;
}



// 💰 초과근무 수당 계산 함수 (날짜순으로 고정시간을 채우고, 넘긴 시간은 해당 가산율로 지급)
function calculateOvertimePay(detailLogs, hourlyWage = 10000, limits = FIX_OT_LIMITS) {
    const used = { overtime: 0, holiday: 0, night: 0 };
    const over = { overtime: 0, holiday: 0, night: 0 };
    const lineMap = {}; // 구분·가산율별 초과시간/금액 (상세보기 요약용)
    let overtimePay = 0;

    const logs = Array.isArray(detailLogs) ? [...detailLogs] : [];
    logs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    logs.forEach(log => {
        splitWorkLog(log).forEach(({ bucket, rate, hours }) => {
            if (hours <= 0) return;
            const remain = Math.max(0, limits[bucket] - used[bucket]);
            const overHours = Math.max(0, hours - remain);
            used[bucket] += hours;
            over[bucket] += overHours;
            overtimePay += overHours * hourlyWage * rate;
            if (overHours > 0) {
                const key = `${bucket}_${rate}`;
                if (!lineMap[key]) lineMap[key] = { bucket, rate, hours: 0, pay: 0 };
                lineMap[key].hours += overHours;
                lineMap[key].pay += overHours * hourlyWage * rate;
            }
        });
    });
    const order = { overtime: 0, holiday: 1, night: 2 };
    const lines = Object.values(lineMap).sort((a, b) => order[a.bucket] - order[b.bucket] || a.rate - b.rate);

    overtimePay = Math.round(overtimePay / 10) * 10; // 10원 단위 반올림 (계좌 송금 단위)
    // 야간 초과는 연장/휴일 초과와 같은 시간이므로 초과시간 합계에는 넣지 않음
    const overtimeHours = Math.round((over.overtime + over.holiday) * 100) / 100;

    if (overtimePay <= 0) {
        return { overtimeHours: 0, overtimePay: 0, used, over, lines: [], text: "초과 없음 (고정OT 범위 내)" };
    }
    const labels = { overtime: '연장', holiday: '휴일', night: '야간' };
    const detail = Object.keys(over)
        .filter(k => over[k] > 0)
        .map(k => `${labels[k]} ${Math.round(over[k] * 100) / 100}h`)
        .join(', ');
    return {
        overtimeHours: overtimeHours,
        overtimePay: overtimePay,
        used,
        over,
        lines,
        text: `${detail} 초과 (${overtimePay.toLocaleString()}원)`
    };
}


// ==========================================
// 🏖️ 연차 관리 (관리자는 연차 갯수 관리·사용촉진용 / 서명은 결재자가 링크로 진행)
// 휴가 종류·연차 계산·휴가신청서 양식은 js/leavejs/leave-common.js 공용
// ==========================================
let leaveAdminRequests = []; // 전체 연차 신청 [{ id, data }]
let leaveAdminLoaded = false;
let leaveAdminEmployees = []; // 사원정보 (연차 현황표·직원명 목록용)

// 마지막에 본 탭 기억 → 새로고침해도 그 탭으로 (브라우저 탭을 닫으면 처음부터 · 관리자 로그인과 같은 범위)
function rememberAdminView(key, value) { try { sessionStorage.setItem(key, value); } catch (e) {} }
function recallAdminView(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }

function switchAdminTab(tab) {
    const isLeave = tab === 'leave';
    rememberAdminView('adminTab', tab);
    document.getElementById('ot-admin-section').style.display = tab === 'ot' ? 'block' : 'none';
    document.getElementById('leave-admin-section').style.display = isLeave ? 'block' : 'none';
    document.getElementById('pay-admin-section').style.display = tab === 'pay' ? 'block' : 'none';
    document.getElementById('staff-admin-section').style.display = tab === 'staff' ? 'block' : 'none';
    document.getElementById('assoc-admin-section').style.display = tab === 'assoc' ? 'block' : 'none';
    document.getElementById('hrinfo-admin-section').style.display = tab === 'hrinfo' ? 'block' : 'none';
    document.getElementById('hrcareer-admin-section').style.display = tab === 'hrcareer' ? 'block' : 'none';
    document.getElementById('tab-ot-admin').classList.toggle('active', tab === 'ot');
    document.getElementById('tab-leave-admin').classList.toggle('active', isLeave);
    document.getElementById('tab-pay-admin').classList.toggle('active', tab === 'pay');
    document.getElementById('tab-staff-admin').classList.toggle('active', tab === 'staff');
    document.getElementById('tab-assoc-admin').classList.toggle('active', tab === 'assoc');
    document.getElementById('tab-hrinfo-admin').classList.toggle('active', tab === 'hrinfo');
    document.getElementById('tab-hrcareer-admin').classList.toggle('active', tab === 'hrcareer');
    if (tab === 'pay') openPayrollTab(); // js/payroll-month.js
    if (tab === 'staff') openStaffTab(); // js/staff-admin.js
    if (tab === 'assoc') openAssocTab(); // js/assoc-admin.js
    if (tab === 'hrinfo') openHrTab('info'); // js/hr-admin.js
    if (tab === 'hrcareer') openHrTab('career');
    if (isLeave && !leaveAdminLoaded) {
        initLeaveYearSelect();
        loadLeaveAdmin();
        leaveAdminLoaded = true;
        if (recallAdminView('leaveSubTab') === 'summary') switchLeaveSubTab('summary');   // 연차 관리 안의 작은 탭도 기억
    }
}

function initLeaveYearSelect() {
    const sel = document.getElementById('leave-year-select');
    if (!sel || sel.options.length) return;
    const thisYear = new Date().getFullYear();
    for (let y = thisYear + 1; y >= thisYear - 3; y--) {
        sel.innerHTML += `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y}년</option>`;
    }
}

function loadLeaveAdmin() {
    Promise.all([db.collection("employees").get(), db.collection("leave_requests").get()])
        .then(([empSnap, reqSnap]) => {
            leaveAdminRequests = reqSnap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
            leaveAdminEmployees = empSnap.docs.map(doc => doc.data());
            fillLeaveNameOptions();
            applyLeaveFilters();
        })
        .catch(err => console.error("연차 관리 데이터 로드 실패:", err));
}

// 🔍 직원명 목록: 사원정보 + 신청 내역에만 있는 이름 (가나다순), 고른 값은 다시 불러와도 유지
function fillLeaveNameOptions() {
    const sel = document.getElementById('leave-search-name');
    if (!sel) return;
    const keep = sel.value;
    const names = [...new Set(leaveAdminEmployees.map(e => e.name).concat(leaveAdminRequests.map(r => r.data.employeeName)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'ko'));
    sel.innerHTML = `<option value="">전체</option>` + names.map(n => `<option value="${n}">${n}</option>`).join('');
    sel.value = names.includes(keep) ? keep : '';
}

// 연도·직원명·상태 적용 (다시 불러오지 않고 받아 둔 자료로 다시 그림)
function applyLeaveFilters() {
    const year = Number(document.getElementById('leave-year-select').value);
    renderLeaveSummary(year, leaveAdminEmployees);
    renderLeaveRequestList(year);
}

// 신청 내역 정렬: key 'submitted'(제출일) / 'start'(휴가 시작일), dir -1 최신순(기본) / 1 오래된 순
// 머리글을 누르면 그 기준으로, 같은 머리글을 다시 누르면 방향만 바뀜
let leaveSort = { key: 'submitted', dir: -1 };
function toggleLeaveSort(key) {
    leaveSort = leaveSort.key === key ? { key, dir: -leaveSort.dir } : { key, dir: -1 };
    renderLeaveRequestList(Number(document.getElementById('leave-year-select').value));
}

// [조회]: 연도·직원명·상태 적용 - 지금 보고 있는 작은 탭 그대로 (2026-11-23 사용자 요청)
function searchLeaveRequests() {
    applyLeaveFilters();
}

// 연차 관리 안의 작은 탭: 'list' 신청 내역(기본) / 'summary' 전 직원 연차 현황
function switchLeaveSubTab(tab) {
    rememberAdminView('leaveSubTab', tab);
    document.getElementById('lv-panel-list').style.display = tab === 'list' ? 'block' : 'none';
    document.getElementById('lv-panel-summary').style.display = tab === 'summary' ? 'block' : 'none';
    document.getElementById('lv-subtab-list').classList.toggle('on', tab === 'list');
    document.getElementById('lv-subtab-summary').classList.toggle('on', tab === 'summary');
}

function resetLeaveFilters() {
    document.getElementById('leave-search-name').value = '';
    document.getElementById('leave-search-status').value = '';
    applyLeaveFilters();
}

// 전 직원 연차 현황 정렬: 'remain' 잔여 많은 순(기본) / 'name' 이름 / 'hire' 입사일 (dir 1 오름차순, -1 내림차순)
let leaveSumSort = { key: 'remain', dir: -1 };
function toggleLeaveSumSort(key) {
    if (document.getElementById('leave-search-name').value) return;   // 직원명 '전체'일 때만 정렬
    leaveSumSort = leaveSumSort.key === key ? { key, dir: -leaveSumSort.dir } : { key, dir: 1 };
    renderLeaveSummary(Number(document.getElementById('leave-year-select').value), leaveAdminEmployees);
}

// 사원별 발생/사용/대기/잔여 (잔여 많은 순 → 사용촉진 대상이 위로)
function renderLeaveSummary(year, employees) {
    const tbody = document.getElementById('leave-summary-tbody');
    if (!tbody) return;
    const pickName = document.getElementById('leave-search-name')?.value || '';
    // 상태를 고르면 그 상태의 신청이 그해에 있는 직원만 (대기는 재전송·결재중 포함)
    const pickStatus = document.getElementById('leave-search-status')?.value || '';
    const hasStatus = emp => leaveAdminRequests.some(({ data }) => data.employeeName === emp.name && data.employeePhone === emp.phoneLast4 && data.fiscalYear === year
        && (() => { const st = leaveDisplayStatus(data); return st === pickStatus || (pickStatus === '대기' && (st === '재전송' || st === '결재중')); })());
    const rows = employees.filter(emp => (!pickName || emp.name === pickName) && (!pickStatus || hasStatus(emp))).map(emp => {
        let used = 0, pending = 0;
        const mine = leaveAdminRequests.filter(({ data }) => data.employeeName === emp.name && data.employeePhone === emp.phoneLast4);
        mine.forEach(({ data }) => {
            if (data.fiscalYear !== year || !isDeductible(data)) return;
            const st = leaveDisplayStatus(data);   // 최종 승인만 '사용', 과장 서명만 된 결재중은 '결재 대기'
            if (st === "승인") used += data.totalDays || 0;
            else if (st === "대기" || st === "재전송" || st === "결재중") pending += data.totalDays || 0;
        });
        const detail = calcLeaveDetail(emp.hireDate, year, mine);   // 오늘까지 발생 + 연말까지 예정
        const entitlement = detail.granted;
        const remaining = entitlement - used - pending;
        return { emp, entitlement, detail, used, pending, remaining };
    }).sort((a, b) => {
        // 기본: 잔여 많은 순 (사용촉진 대상이 위로) / 이름·입사일 머리글을 누르면 그 기준 (빈 입사일은 맨 아래)
        const byName = (a.emp.name || '').localeCompare(b.emp.name || '', 'ko');
        if (leaveSumSort.key === 'name') return leaveSumSort.dir * byName;
        if (leaveSumSort.key === 'hire') {
            const x = a.emp.hireDate || '', y = b.emp.hireDate || '';
            if (!x || !y) return x === y ? byName : (x ? -1 : 1);
            return leaveSumSort.dir * x.localeCompare(y) || byName;
        }
        return b.remaining - a.remaining || byName;
    });
    // 머리글 정렬 표시: 직원명 '전체'로 볼 때만 (한 사람만 보면 정렬할 게 없으니 일반 머리글)
    const canSort = !pickName;
    const arrow = k => leaveSumSort.key === k ? (leaveSumSort.dir > 0 ? '▲' : '▼') : '↕';
    [['lvsum-sort-name', 'name', '이름'], ['lvsum-sort-hire', 'hire', '입사일']].forEach(([id, k, label]) => {
        const th = document.getElementById(id);
        if (!th) return;
        th.innerText = canSort ? `${label} ${arrow(k)}` : label;
        th.classList.toggle('lv-sort-th', canSort);
    });

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="color: #888;">${pickStatus ? `${year}년 '${pickStatus}' 신청이 있는 직원이 없습니다.` : pickName ? `${pickName} 님은 사원정보에 없습니다.` : '등록된 사원이 없습니다.'}</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const noHire = !r.emp.hireDate;
        const rate = r.entitlement > 0 ? Math.round((r.used / r.entitlement) * 100) : 0;
        // 잔여가 발생의 절반 이상이면 주황(사용촉진 대상), 마이너스면 빨강
        const remainColor = r.remaining < 0 ? 'var(--danger-color)' : (r.entitlement > 0 && r.remaining >= r.entitlement / 2 ? '#e67e22' : '#333');
        return `<tr>
            <td>${r.emp.name}</td>
            <td>${noHire ? '<span style="color: var(--danger-color);">미등록</span>' : r.emp.hireDate}</td>
            <td title="${noHire ? '' : r.detail.parts.map(p => `${p.date} ${p.label} ${p.days}일`).join('\n')}">${noHire ? '-' : formatDays(r.entitlement) + '일'}${!noHire && r.detail.yearTotal > r.entitlement ? `<br><small style="color: #888; white-space: nowrap;">연말까지 ${formatDays(r.detail.yearTotal)}일<br>다음 ${r.detail.next.slice(5).replace('-', '/')}</small>` : ''}</td>
            <td>${formatDays(r.used)}일</td>
            <td>${r.pending > 0 ? formatDays(r.pending) + '일' : '-'}</td>
            <td><b style="color: ${remainColor};">${noHire ? '-' : formatDays(r.remaining) + '일'}</b></td>
            <td>${noHire ? '-' : rate + '%'}</td>
        </tr>`;
    }).join('');
}

// 결재 칸 표시 (표 머리글 순서: 과장 / 전무)
function leaveSignStatusHtml(data) {
    if (data.imported) return '<span style="color: #888;">📁 이전 자료</span>';   // 엑셀로 올린 이전 내역 (종이 결재)
    if (data.adminApproval) {   // 관리자 대결: 서명된 칸은 그대로, 부재 결재자 한 칸(전무 우선)만 '관리자'
        const adminSlot = adminApprovalSlot(data.signatures);
        return ['manager', 'director'].map(slot => {
            const s = data.signatures && data.signatures[slot];
            if (s) return `✅ ${signatureDateText(s)}`;
            return slot === adminSlot ? `<span style="color: #2b8a3e;" title="${(data.adminApproval.reason || '').replace(/"/g, '&quot;')}">🛡️ 관리자</span>` : '⬜';
        }).join(' / ');
    }
    return ['manager', 'director'].map(slot => {
        const s = data.signatures && data.signatures[slot];
        return s ? `✅ ${signatureDateText(s)}` : '⬜';
    }).join(' / ');
}

function renderLeaveRequestList(year) {
    const tbody = document.getElementById('leave-admin-tbody');
    if (!tbody) return;
    const pickName = document.getElementById('leave-search-name')?.value || '';
    const pickStatus = document.getElementById('leave-search-status')?.value || '';
    const statusOk = s => !pickStatus || s === pickStatus || (pickStatus === "대기" && (s === "재전송" || s === "결재중"));
    const list = leaveAdminRequests
        .filter(({ data }) => data.fiscalYear === year && data.status !== "작성") // 회수(작성) 건 제외
        .filter(({ data }) => (!pickName || data.employeeName === pickName) && statusOk(leaveDisplayStatus(data)))
        // 제출일 또는 휴가 시작일 순 (▼ 최신순 / ▲ 오래된 순), 같으면 다른 기준도 같은 방향
        // (엑셀로 올린 이전 자료는 같은 신청일이 여러 건)
        .sort((a, b) => {
            const bySub = (a.data.submittedAt?.toMillis?.() || 0) - (b.data.submittedAt?.toMillis?.() || 0);
            const byStart = String(a.data.startDate || '').localeCompare(String(b.data.startDate || ''));
            return leaveSort.dir * (leaveSort.key === 'start' ? (byStart || bySub) : (bySub || byStart));
        });
    const arrow = leaveSort.dir < 0 ? '▼' : '▲';
    const thSub = document.getElementById('leave-sort-submitted'), thStart = document.getElementById('leave-sort-start');
    if (thSub) thSub.innerText = `제출일 ${leaveSort.key === 'submitted' ? arrow : '↕'}`;
    if (thStart) thStart.innerText = `휴가 기간 ${leaveSort.key === 'start' ? arrow : '↕'}`;

    // 제목 옆 건수: 조건이 있으면 '조건 · N건'
    const countEl = document.getElementById('leave-list-count');
    if (countEl) {
        const label = [pickName, pickStatus && (pickStatus === "대기" ? "대기·결재중" : pickStatus)].filter(Boolean).join(' · ');
        countEl.innerText = `${label ? label + ' · ' : ''}${list.length}건`;
    }
    if (list.length === 0) {
        const cond = [pickName, pickStatus && `'${pickStatus}'`].filter(Boolean).join(' · ');
        tbody.innerHTML = `<tr><td colspan="8" style="color: #888;">${year}년${cond ? ` ${cond}` : ''} 연차 신청 내역이 없습니다.</td></tr>`;
        return;
    }
    const statusColors = { "승인": "var(--success-color)", "반려": "var(--danger-color)", "승인취소": "var(--danger-color)", "대기": "#f39c12", "재전송": "#3498db", "결재중": "#007aff" };
    const btnStyle = "padding: 5px 8px; font-size: 12px; height: 32px; width: auto;";
    const dangerStyle = `${btnStyle} color: var(--danger-color); border-color: var(--danger-color);`;
    tbody.innerHTML = list.map(({ id, data }) => {
        const submitted = data.submittedAt ? data.submittedAt.toDate().toLocaleDateString() : '-';
        const st = leaveDisplayStatus(data);   // 과장 서명만 → '결재중' (전무 서명·관리자 승인이 있어야 '승인')
        const canReject = data.status === "대기" || data.status === "재전송" || st === "결재중";
        const canAdminApprove = ACTIVE_STATUSES.includes(data.status) && !leaveIsFinal(data);
        return `<tr>
            <td>${submitted}</td>
            <td>${data.employeeName}</td>
            <td>${leaveTypeLabel(data)}</td>
            <td style="font-size: 13px;">${periodSummary(data)}</td>
            <td>${formatDays(data.totalDays || 0)}일</td>
            <td>${leaveSignStatusHtml(data)}</td>
            <td><span class="status-badge" style="color: ${statusColors[st] || '#888'};">${st}</span></td>
            <td><div style="display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;">
                <button onclick="viewLeaveDetail('${id}')" class="btn-batch-delete" style="${btnStyle}">상세보기</button>
                ${canAdminApprove ? `<button onclick="adminApproveLeave('${id}')" class="btn-batch-delete" style="${btnStyle} color: var(--success-color); border-color: var(--success-color);" title="결재자 부재 시 관리자가 대신 승인">관리자 승인</button>` : ''}
                ${canReject ? `<button onclick="rejectLeaveRequest('${id}')" class="btn-batch-delete" style="${dangerStyle}">반려</button>` : ''}
                ${st === "승인" ? `<button onclick="cancelLeaveApproval('${id}')" class="btn-batch-delete" style="${dangerStyle}">승인취소</button>` : ''}
            </div></td>
        </tr>`;
    }).join('');
}

function viewLeaveDetail(docId) {
    const req = leaveAdminRequests.find(r => r.id === docId);
    if (!req) return;
    const d = req.data;
    const sameEmployee = leaveAdminRequests.filter(r => r.data.employeeName === d.employeeName && r.data.employeePhone === d.employeePhone);
    document.getElementById('leave-detail-sheet').innerHTML = renderLeaveSheetHtml(d, sameEmployee);
    const extra = [];
    if (d.adminApproval) extra.push(`<div><b>관리자 승인(대결):</b> ${d.adminApproval.reason || ''} (${d.adminApproval.at?.toDate ? d.adminApproval.at.toDate().toLocaleString() : ''})</div>`);   // 관리자 계정은 기록만 하고 화면엔 안 보임
    if (d.rejectReason) extra.push(`<div><b>반려 사유:</b> ${d.rejectReason}</div>`);
    if (d.cancelReason) extra.push(`<div><b>승인취소 사유:</b> ${d.cancelReason} (${d.canceledAt ? d.canceledAt.toDate().toLocaleString() : ''})</div>`);
    document.getElementById('leave-detail-extra').innerHTML = extra.join('');
    document.getElementById('leave-detail-modal').style.display = 'block';
}

function closeLeaveDetail() {
    document.getElementById('leave-detail-modal').style.display = 'none';
}

// 관리자 승인(대결): 결재자(전무 등) 부재 시 관리자가 사유를 적고 대신 승인 - 본인이 본인 신청서에 서명하지 않도록
// 결재칸의 빈 칸에는 '관리자 승인'으로 표시, 사유·시각·관리자 계정 기록, 보낸 서명 링크는 무효화
function adminApproveLeave(docId) {
    const req = leaveAdminRequests.find(r => r.id === docId);
    if (!req) return;
    const d = req.data;
    const reason = prompt(`${d.employeeName} 님 ${leaveTypeLabel(d)} ${formatDays(d.totalDays || 0)}일 (${periodSummary(d)})\n관리자가 대신 승인합니다. 사유를 입력하세요:`, "결재자 부재로 관리자 승인");
    if (reason === null) return;
    db.collection("leave_requests").doc(docId).update({
        status: "승인",
        adminApproval: {
            reason: reason.trim() || "관리자 대결",
            by: (auth.currentUser && auth.currentUser.email) || "",
            at: firebase.firestore.FieldValue.serverTimestamp()
        },
        approvedAt: d.approvedAt || firebase.firestore.FieldValue.serverTimestamp(),
        signLink: firebase.firestore.FieldValue.delete()
    }).then(() => { alert("관리자 승인되었습니다."); loadLeaveAdmin(); })
      .catch(err => { console.error("관리자 승인 실패:", err); alert("승인 중 오류가 발생했습니다."); });
}

// 반려: 서명 전(대기·재전송) 신청만 가능 → 사원이 재작성 가능
function rejectLeaveRequest(docId) {
    const reason = prompt("반려 사유를 입력하세요:");
    if (reason === null) return;
    db.collection("leave_requests").doc(docId).update({
        status: "반려",
        rejectReason: reason.trim() || "사유 미입력",
        signLink: firebase.firestore.FieldValue.delete() // 보낸 서명 링크도 무효화
    }).then(() => { alert("반려되었습니다."); loadLeaveAdmin(); })
      .catch(err => { console.error("반려 실패:", err); alert("반려 중 오류가 발생했습니다."); });
}

// 승인취소: 잘못 승인된 경우에만 관리자가 사용 (서명 기록은 그대로 남고, 사유·시각 기록)
function cancelLeaveApproval(docId) {
    const reason = prompt("승인취소 사유를 입력하세요 (필수):\n※ 서명 기록은 그대로 남고, 이 신청은 연차 사용에서 제외됩니다.");
    if (reason === null) return;
    if (!reason.trim()) { alert("승인취소 사유를 입력해야 합니다."); return; }
    db.collection("leave_requests").doc(docId).update({
        status: "승인취소",
        cancelReason: reason.trim(),
        canceledAt: firebase.firestore.FieldValue.serverTimestamp(),
        signLink: firebase.firestore.FieldValue.delete()
    }).then(() => { alert("승인취소 되었습니다."); loadLeaveAdmin(); })
      .catch(err => { console.error("승인취소 실패:", err); alert("승인취소 중 오류가 발생했습니다."); });
}

// ⌨️ ESC로 창 닫기 (직원 화면과 같은 동작) - 관리자 화면의 모든 탭 창 공통
// 열린 창이 여러 개면 맨 위(나중에 열린, HTML에서 아래쪽) 창 하나만 닫음 → 한 번 더 누르면 그 아래 창
// 새 창을 추가하면 여기에 [창 id, 닫는 함수 이름]만 한 줄 넣으면 됨
const ADMIN_MODAL_CLOSERS = [
    ['assoc-modal', 'closeAssocModal'],
    ['assoc-imp-modal', 'closeAssocImport'],
    ['hr-imp-modal', 'closeHrImport'],
    ['leave-detail-modal', 'closeLeaveDetail'],
    ['pay-emp-modal', 'closePayEmpModal'],
    ['pay-empxl-dl-modal', 'closeEmpXlDownload'],
    ['staff-resign-modal', 'closeResignDialog'],
    ['staff-deleted-modal', 'closeDeletedStaff'],
    ['lvimp-modal', 'closeLeaveImport'],
    ['pay-empxl-up-modal', 'closeEmpXlUpload'],
    ['pay-import-modal', 'closePayImport'],
    ['pay-company-modal', 'closePayCompanyModal'],
    ['pay-doc-modal', 'closePayDoc'],
    ['pay-bulk-modal', 'closeBulkSend'],      // 보내는 중에는 closeBulkSend()가 스스로 안 닫음
    ['pay-log-modal', 'closePaySendLog'],
    ['detail-modal', 'closeModal']
];
document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.isComposing) return;
    const open = ADMIN_MODAL_CLOSERS
        .map(([id, fn]) => ({ el: document.getElementById(id), fn }))
        .filter(m => m.el && getComputedStyle(m.el).display !== 'none');
    if (!open.length) return;
    // 급여대장 검수 화면(.audit)은 바깥 클릭처럼 ESC로도 안 닫음 (처리 중인 선택이 사라지지 않게)
    const top = open.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? 1 : -1)[0];
    if (top.el.id === 'pay-import-modal' && top.el.querySelector('.audit')) return;
    if (typeof window[top.fn] === 'function') {
        e.preventDefault();
        window[top.fn]();
    }
});
