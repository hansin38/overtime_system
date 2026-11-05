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
let wageMapCache = {};   // 상세보기에서 쓰는 사원별 초과수당 시급 (결재 내역 로드 시 갱신)
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

// 초과수당 시급 = 연봉 ÷ 12 ÷ 209 (도의적 지급 기준) / 연봉 미등록 시 예전 통상시급 → 10,000원
function expenseHourlyWage(profile) {
    const annual = Number(profile && profile.annualSalary);
    if (annual > 0) return annual / 12 / 209;
    const legacy = Number(profile && profile.legacyHourlyWage);
    return legacy > 0 ? legacy : 10000;
}

// 6. 결재 내역 로드 (사원별 연봉 기준 시급·고정OT 반영)
function loadAdminData(searchName = "", targetStatus = "전체", startDateVal = "", endDateVal = "") {
    // 1) 전체 사원의 시급·고정OT 매핑 맵 생성
    Promise.all([db.collection("employees").get(), db.collection("payroll_profiles").get()]).then(([empSnapshot, profSnapshot]) => {
        const profiles = {};
        profSnapshot.forEach(doc => { profiles[doc.id] = doc.data(); });
        const wageMap = {}, limitMap = {};
        empSnapshot.forEach(doc => {
            const emp = doc.data();
            if (emp.name) {
                const cleanName = emp.name.trim();
                wageMap[cleanName] = expenseHourlyWage(profiles[doc.id]);
                limitMap[cleanName] = getFixOtLimits(emp);
            }
        });
        wageMapCache = wageMap;
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
                const empWage = wageMap[empNameKey] || 10000;
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
        alert("처리되었습니다.");
        applyFilters(); // 필터 유지를 반영한 새로고침
    });
}

// 7. 결재 건별 상세 내역 
function viewDetails(docId) {
    db.collection("overtime_requests").doc(docId).get().then(doc => {
        if (!doc.exists) return alert("신청 내역을 찾을 수 없습니다.");
        const data = doc.data();
        const modalTbody = document.getElementById('modal-tbody');
        if (!modalTbody) return;

        const logs = Array.isArray(data.detailLogs) ? data.detailLogs : [];
        const empNameKey = data.employeeName ? data.employeeName.trim() : "";
        const empWage = wageMapCache[empNameKey] || 10000;
        const limits = limitMapCache[empNameKey] || FIX_OT_LIMITS;
        renderPaySummary(data.employeeName || "-", empWage, calculateOvertimePay(logs, empWage, limits), limits);

        modalTbody.innerHTML = logs.map(log =>
            `<tr>
                <td>${log.date}</td>
                <td>${log.type === 'weekday' ? '평일 야근' : '주말/공휴일'}</td>
                <td>${log.start}</td>
                <td>${log.end}</td>
                <td>${log.hours} 시간</td>
            </tr>`
        ).join('');
        document.getElementById('detail-modal').style.display = "flex";
    });
}

function closeModal() {
    document.getElementById('detail-modal').style.display = "none";
}

// 💰 상세보기 상단 요약: 구분별 사용/한도(사원 화면과 동일 형식) + 가산율별 초과수당 + 총 지급액
function renderPaySummary(name, wage, payInfo, limits = FIX_OT_LIMITS) {
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
        <div style="font-weight: bold; margin-bottom: 6px;">${name} · 초과수당 시급 ${Math.round(wage).toLocaleString()}원 <small style="color: #888; font-weight: normal;">(연봉÷12÷209)</small></div>
        <div style="margin-bottom: 8px;">${usage}</div>
        <div style="margin-bottom: 10px;">${badge}</div>
        ${lines ? `<div style="border-top: 1px solid #dee2e6; padding-top: 8px;">${lines}</div>` : ''}
        <div style="display: flex; justify-content: space-between; border-top: 1px solid #dee2e6; margin-top: 8px; padding-top: 8px; font-weight: bold;">
            <span>총 지급액 <small style="color: #888; font-weight: normal;">(백원 단위 올림)</small></span>
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

    overtimePay = Math.ceil(Math.round(overtimePay) / 100) * 100; // 백원 단위 올림
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

function switchAdminTab(tab) {
    const isLeave = tab === 'leave';
    document.getElementById('ot-admin-section').style.display = tab === 'ot' ? 'block' : 'none';
    document.getElementById('leave-admin-section').style.display = isLeave ? 'block' : 'none';
    document.getElementById('pay-admin-section').style.display = tab === 'pay' ? 'block' : 'none';
    document.getElementById('tab-ot-admin').classList.toggle('active', tab === 'ot');
    document.getElementById('tab-leave-admin').classList.toggle('active', isLeave);
    document.getElementById('tab-pay-admin').classList.toggle('active', tab === 'pay');
    if (tab === 'pay') openPayrollTab(); // js/payroll.js
    if (isLeave && !leaveAdminLoaded) {
        initLeaveYearSelect();
        loadLeaveAdmin();
        leaveAdminLoaded = true;
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
    const year = Number(document.getElementById('leave-year-select').value);
    Promise.all([db.collection("employees").get(), db.collection("leave_requests").get()])
        .then(([empSnap, reqSnap]) => {
            leaveAdminRequests = reqSnap.docs.map(doc => ({ id: doc.id, data: doc.data() }));
            renderLeaveSummary(year, empSnap.docs.map(doc => doc.data()));
            renderLeaveRequestList(year);
        })
        .catch(err => console.error("연차 관리 데이터 로드 실패:", err));
}

// 사원별 발생/사용/대기/잔여 (잔여 많은 순 → 사용촉진 대상이 위로)
function renderLeaveSummary(year, employees) {
    const tbody = document.getElementById('leave-summary-tbody');
    if (!tbody) return;
    const rows = employees.map(emp => {
        let used = 0, pending = 0;
        leaveAdminRequests.forEach(({ data }) => {
            if (data.employeeName !== emp.name || data.employeePhone !== emp.phoneLast4) return;
            if (data.fiscalYear !== year || !isDeductible(data)) return;
            if (data.status === "승인") used += data.totalDays || 0;
            else if (data.status === "대기" || data.status === "재전송") pending += data.totalDays || 0;
        });
        const entitlement = calcAnnualLeaveEntitlement(emp.hireDate, year);
        const remaining = entitlement - used - pending;
        return { emp, entitlement, used, pending, remaining };
    }).sort((a, b) => b.remaining - a.remaining);

    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="color: #888;">등록된 사원이 없습니다.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const noHire = !r.emp.hireDate;
        const rate = r.entitlement > 0 ? Math.round((r.used / r.entitlement) * 100) : 0;
        // 잔여가 발생의 절반 이상이면 주황(사용촉진 대상), 마이너스면 빨강
        const remainColor = r.remaining < 0 ? 'var(--danger-color)' : (r.entitlement > 0 && r.remaining >= r.entitlement / 2 ? '#e67e22' : '#333');
        return `<tr>
            <td>${r.emp.name}</td>
            <td>${r.emp.department || '-'} / ${r.emp.position || '-'}</td>
            <td>${noHire ? '<span style="color: var(--danger-color);">미등록</span>' : r.emp.hireDate}</td>
            <td>${noHire ? '-' : r.entitlement + '일'}</td>
            <td>${formatDays(r.used)}일</td>
            <td>${r.pending > 0 ? formatDays(r.pending) + '일' : '-'}</td>
            <td><b style="color: ${remainColor};">${noHire ? '-' : formatDays(r.remaining) + '일'}</b></td>
            <td>${noHire ? '-' : rate + '%'}</td>
        </tr>`;
    }).join('');
}

// 결재 칸 표시 (표 머리글 순서: 과장 / 전무)
function leaveSignStatusHtml(data) {
    return ['manager', 'director'].map(slot => {
        const s = data.signatures && data.signatures[slot];
        return s ? `✅ ${signatureDateText(s)}` : '⬜';
    }).join(' / ');
}

function renderLeaveRequestList(year) {
    const tbody = document.getElementById('leave-admin-tbody');
    if (!tbody) return;
    const list = leaveAdminRequests
        .filter(({ data }) => data.fiscalYear === year && data.status !== "작성") // 회수(작성) 건 제외
        .sort((a, b) => (b.data.submittedAt?.toMillis?.() || 0) - (a.data.submittedAt?.toMillis?.() || 0));

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="color: #888;">${year}년 연차 신청 내역이 없습니다.</td></tr>`;
        return;
    }
    const statusColors = { "승인": "var(--success-color)", "반려": "var(--danger-color)", "승인취소": "var(--danger-color)", "대기": "#f39c12", "재전송": "#3498db" };
    const btnStyle = "padding: 5px 8px; font-size: 12px; height: 32px; width: auto;";
    const dangerStyle = `${btnStyle} color: var(--danger-color); border-color: var(--danger-color);`;
    tbody.innerHTML = list.map(({ id, data }) => {
        const submitted = data.submittedAt ? data.submittedAt.toDate().toLocaleDateString() : '-';
        const canReject = data.status === "대기" || data.status === "재전송";
        return `<tr>
            <td>${submitted}</td>
            <td>${data.employeeName}</td>
            <td>${leaveTypeLabel(data)}</td>
            <td style="font-size: 13px;">${periodSummary(data)}</td>
            <td>${formatDays(data.totalDays || 0)}일</td>
            <td>${leaveSignStatusHtml(data)}</td>
            <td><span class="status-badge" style="color: ${statusColors[data.status] || '#888'};">${data.status}</span></td>
            <td style="white-space: nowrap;">
                <button onclick="viewLeaveDetail('${id}')" class="btn-batch-delete" style="${btnStyle}">상세보기</button>
                ${canReject ? `<button onclick="rejectLeaveRequest('${id}')" class="btn-batch-delete" style="${dangerStyle}">반려</button>` : ''}
                ${data.status === "승인" ? `<button onclick="cancelLeaveApproval('${id}')" class="btn-batch-delete" style="${dangerStyle}">승인취소</button>` : ''}
            </td>
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
    if (d.rejectReason) extra.push(`<div><b>반려 사유:</b> ${d.rejectReason}</div>`);
    if (d.cancelReason) extra.push(`<div><b>승인취소 사유:</b> ${d.cancelReason} (${d.canceledAt ? d.canceledAt.toDate().toLocaleString() : ''})</div>`);
    document.getElementById('leave-detail-extra').innerHTML = extra.join('');
    document.getElementById('leave-detail-modal').style.display = 'block';
}

function closeLeaveDetail() {
    document.getElementById('leave-detail-modal').style.display = 'none';
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
