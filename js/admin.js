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

let currentTabStatus = "대기";
let wageMapCache = {}; // 상세보기에서 쓰는 사원별 통상시급 (결재 내역 로드 시 갱신)
// 🔐 관리자 계정 (비밀번호는 이 한 곳에서만 관리 - 바꿀 때는 pw 값만 수정)
const ADMIN_ACCOUNT = { name: "김은지", pw: "1234" };

// 👤 사원 관리 모달 열기
function openEmpModal() {
    document.getElementById('emp-manage-modal').style.display = 'flex';
    loadEmployeeList(); 
}

// 👤 사원 관리 모달 닫기
function closeEmpModal() {
    document.getElementById('emp-manage-modal').style.display = 'none';
}

// 1. 페이지 로드 시 처리
// 로그인 전에는 관리자 로그인 화면을, 로그인 후에는 결재 화면을 보여줌
window.addEventListener('DOMContentLoaded', () => {
    if (sessionStorage.getItem('boss_authenticated') === 'true') {
        startAdminSystem();
    } else {
        document.getElementById('admin-login').style.display = 'block';
    }
});

function startAdminSystem() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-system').style.display = 'block';

    // 날짜 기본 필터 설정 (기본은 전체 조회로 날짜 비워둠)
    setDateRange('all');

    loadAdminData();
    loadSearchEmployeeList();
    bindSearchAndActionEvents();
}

// 🔐 관리자 로그인
function handleAdminLogin() {
    const name = document.getElementById('admin-name').value.trim();
    const pw = document.getElementById('admin-pw').value.trim();

    if (name === ADMIN_ACCOUNT.name && pw === ADMIN_ACCOUNT.pw) {
        sessionStorage.setItem('boss_authenticated', 'true');
        startAdminSystem();
    } else {
        alert("관리자 정보가 일치하지 않습니다.");
    }
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

// 3. 사원 등록 (통상임금 수집 및 초기화 로직 수정)
function registerEmployee() {
    const name = document.getElementById('new-emp-name').value.trim();
    const phone = document.getElementById('new-emp-phone').value.trim();
    const wageInput = document.getElementById('new-emp-wage');
    const wageVal = wageInput ? wageInput.value.trim() : "";

    if (!name || phone.length !== 4) { 
        alert("이름과 휴대폰 뒷자리 4자리를 정확히 입력해주세요."); 
        return; 
    }

    // 통상임금 미입력 시 기본값 10,000원 적용
    const hourlyWage = wageVal ? parseInt(wageVal, 10) : 10000;

    db.collection("employees").where("name", "==", name).where("phoneLast4", "==", phone).get()
        .then((snapshot) => {
            if (!snapshot.empty) { 
                alert("이미 등록된 사원입니다."); 
            } else {
                db.collection("employees").add({ 
                    name, 
                    phoneLast4: phone, 
                    hourlyWage: hourlyWage, // 💰 DB 저장
                    createdAt: firebase.firestore.FieldValue.serverTimestamp() 
                })
                .then(() => { 
                    alert("등록 완료!"); 
                    // 등록 성공 후 입력창 모두 비우기
                    document.getElementById('new-emp-name').value = '';
                    document.getElementById('new-emp-phone').value = '';
                    if (wageInput) wageInput.value = '';

                    loadEmployeeList(); 
                    loadSearchEmployeeList(); 
                });
            }
        });
}

// 사원 삭제
function deleteEmployee(docId) {
    if(confirm("정말 삭제하시겠습니까?")) {
        db.collection("employees").doc(docId).delete().then(() => {
            loadEmployeeList(); 
            loadSearchEmployeeList(); 
        });
    }
}

// 사원 통상시급 수정 함수
function updateEmployeeWage(docId, currentWage) {
    const newWage = prompt("변경할 통상시급(원)을 입력하세요:", currentWage);
    if (newWage === null) return;
    
    const parsedWage = parseInt(newWage.replace(/[^0-9]/g, ''), 10);
    if (isNaN(parsedWage) || parsedWage <= 0) {
        alert("올바른 금액을 입력해 주세요.");
        return;
    }

    db.collection("employees").doc(docId).update({ hourlyWage: parsedWage }).then(() => {
        alert("통상시급이 수정되었습니다.");
        loadEmployeeList();
        applyFilters();
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

// 5. 등록된 사원 목록 로드 (통상시급 열 <td> 위치 정상화 수정)
function loadEmployeeList() {
    db.collection("employees").get().then(snapshot => {
        const tbody = document.getElementById('employee-list-tbody');
        if (!tbody) return;
        tbody.innerHTML = snapshot.docs.map(doc => {
            const data = doc.data();
            const wage = data.hourlyWage ? Number(data.hourlyWage).toLocaleString() : "10,000";

            return `<tr>
                <td style="vertical-align: middle;">${data.name}</td>
                <td style="vertical-align: middle;">${data.phoneLast4}</td>
                <!-- 💰 통상시급 칸 -->
                <td style="vertical-align: middle; text-align: center;">
                    ${wage}원
                    <button onclick="updateEmployeeWage('${doc.id}', ${data.hourlyWage || 10000})" style="padding: 2px 6px; font-size: 11px; margin-left: 4px; cursor: pointer;">수정</button>
                </td>
                <!-- 🗑 관리(삭제) 칸 -->
                <td style="vertical-align: middle; text-align: center;">
                    <button onclick="deleteEmployee('${doc.id}')" class="btn-batch-delete" style="margin: 0 auto; padding: 0 14px; font-size: 13px; height: 32px; line-height: 30px; font-weight: bold; display: inline-block; white-space: nowrap; min-width: 60px;">
                        삭제
                    </button>
                </td>
            </tr>`;
        }).join('');
    });
}

function logoutAdmin() {
    sessionStorage.removeItem('boss_authenticated');
    location.reload(); // 새로고침하면 관리자 로그인 화면으로 돌아감
}

// 6. 결재 내역 로드 (사원별 등록된 통상시급 정확한 매핑 반영)
function loadAdminData(searchName = "", targetStatus = "전체", startDateVal = "", endDateVal = "") {
    // 1) 전체 사원의 통상시급 매핑 맵 생성 (비동기 동기화)
    db.collection("employees").get().then(empSnapshot => {
        const wageMap = {};
        empSnapshot.forEach(doc => {
            const emp = doc.data();
            if (emp.name) {
                // 이름 공백 제거 및 숫자로 확실하게 변환
                const cleanName = emp.name.trim();
                const wageNum = parseInt(emp.hourlyWage, 10);
                wageMap[cleanName] = !isNaN(wageNum) && wageNum > 0 ? wageNum : 10000;
            }
        });
        wageMapCache = wageMap;

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
                // 신청 내역 자체에 hourlyWage가 포함되어 있다면 그걸 우선 사용하고, 없으면 DB 시급 적용
                const empWage = data.hourlyWage || wageMap[empNameKey] || 10000; 
                
                const payInfo = calculateOvertimePay(data.detailLogs, empWage);

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
        const empWage = data.hourlyWage || wageMapCache[empNameKey] || 10000;
        renderPaySummary(data.employeeName || "-", empWage, calculateOvertimePay(logs, empWage));

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
function renderPaySummary(name, wage, payInfo) {
    const box = document.getElementById('modal-summary');
    if (!box) return;
    const labels = { overtime: '연장', holiday: '휴일', night: '야간' };
    const overKeys = Object.keys(FIX_OT_LIMITS).filter(k => payInfo.used[k] > FIX_OT_LIMITS[k]);

    const usage = Object.keys(FIX_OT_LIMITS).map(k => {
        const color = overKeys.includes(k) ? 'var(--danger-color)' : '#888';
        return `<span style="color: ${color};">${labels[k]} ${payInfo.used[k].toFixed(1)}/${Math.floor(FIX_OT_LIMITS[k] * 2) / 2}</span>`;
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
        <div style="font-weight: bold; margin-bottom: 6px;">${name} · 통상시급 ${Number(wage).toLocaleString()}원</div>
        <div style="margin-bottom: 8px;">${usage}</div>
        <div style="margin-bottom: 10px;">${badge}</div>
        ${lines ? `<div style="border-top: 1px solid #dee2e6; padding-top: 8px;">${lines}</div>` : ''}
        <div style="display: flex; justify-content: space-between; border-top: 1px solid #dee2e6; margin-top: 8px; padding-top: 8px; font-weight: bold;">
            <span>총 지급액 <small style="color: #888; font-weight: normal;">(백원 단위 올림)</small></span>
            <span style="color: ${payInfo.overtimePay > 0 ? 'var(--danger-color)' : '#888'};">${payInfo.overtimePay.toLocaleString()}원</span>
        </div>`;
}



// 💰 초과근무 수당 계산 함수 (날짜순으로 고정시간을 채우고, 넘긴 시간은 해당 가산율로 지급)
function calculateOvertimePay(detailLogs, hourlyWage = 10000) {
    const used = { overtime: 0, holiday: 0, night: 0 };
    const over = { overtime: 0, holiday: 0, night: 0 };
    const lineMap = {}; // 구분·가산율별 초과시간/금액 (상세보기 요약용)
    let overtimePay = 0;

    const logs = Array.isArray(detailLogs) ? [...detailLogs] : [];
    logs.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    logs.forEach(log => {
        splitWorkLog(log).forEach(({ bucket, rate, hours }) => {
            if (hours <= 0) return;
            const remain = Math.max(0, FIX_OT_LIMITS[bucket] - used[bucket]);
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
        return { overtimeHours: 0, overtimePay: 0, used, lines: [], text: "초과 없음 (고정OT 범위 내)" };
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
        lines,
        text: `${detail} 초과 (${overtimePay.toLocaleString()}원)`
    };
}
