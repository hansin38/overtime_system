// ==========================================
// 1. 초기화 및 환경 설정
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyCpMIytCpZ5F5JRoKABJE7kkgv_RZReFRc",
    authDomain: "hansin-df749.firebaseapp.com",
    projectId: "hansin-df749",
    storageBucket: "hansin-df749.firebasestorage.app",
    messagingSenderId: "908820835514",
    appId: "1:908820835514:web:0e02c604c7cf775d5f2683",
    measurementId: "G-LP10H2WN94"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// 고정OT(FIX_OT_LIMITS)·공휴일(holidays)·splitWorkLog는 js/ot-rules.js에서 공통 관리

// 중복 선언을 방지하기 위한 안전한 window 객체 바인딩 패턴 적용
if (typeof window.currentUser === 'undefined') {
    window.currentUser = { name: "", phone: "" };
}
if (typeof window.originDocIdForRewrite === 'undefined') {
    window.originDocIdForRewrite = null; // 재작성 추적을 위한 전역 변수
}
if (typeof window.currentTempDocId === 'undefined') {
    window.currentTempDocId = null; // 현재 불러와서 수정 중인 임시저장 문서 ID를 추적
}

// 다른 코드에서 참조하기 쉽도록 단축 변수(Alias) 지정 (단, 재할당 가능한 var 사용)
var currentUser = window.currentUser;
var originDocIdForRewrite = window.originDocIdForRewrite;
var currentTempDocId = window.currentTempDocId;

const SYSTEM_START_DATE = "2026-05-25"; // 이 날짜 이전은 입력 불가
const OT_DRAFT_DAYS = 5;                 // 매월 1~5일에 열면 지난달을 작성 월로 선택

function ymdOf(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function getDefaultOtMonth() {
    const today = new Date();
    const base = today.getDate() <= OT_DRAFT_DAYS
        ? new Date(today.getFullYear(), today.getMonth() - 1, 1)
        : today;
    return ymdOf(base).slice(0, 7);
}

function prevMonthOf(ym) {
    const [y, m] = ym.split('-').map(Number);
    return ymdOf(new Date(y, m - 2, 1)).slice(0, 7);
}

// 그 달에서 입력 가능한 날짜 범위 (시스템 시작일 이전·오늘 이후 불가)
function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const first = `${ym}-01`;
    const last = ymdOf(new Date(y, m, 0));
    const today = ymdOf(new Date());
    return {
        min: first > SYSTEM_START_DATE ? first : SYSTEM_START_DATE,
        max: last < today ? last : today
    };
}

// 줄마다 고를 수 있는 달: 작성 월 + 예외로 지난달
function getRowMonths() {
    const ym = getOtMonth();
    const prev = prevMonthOf(ym);
    return prev >= SYSTEM_START_DATE.slice(0, 7) ? [ym, prev] : [ym];
}

// 작성 월 선택칸: 이번 달 포함 최근 3개월 (시스템 시작 월 이전 제외)
function initDatePickerLimits() {
    const sel = document.getElementById('ot-month');
    if (!sel) return;
    const today = new Date();
    sel.innerHTML = "";
    for (let i = 0; i < 3; i++) {
        const ym = ymdOf(new Date(today.getFullYear(), today.getMonth() - i, 1)).slice(0, 7);
        if (ym < SYSTEM_START_DATE.slice(0, 7)) break;
        sel.innerHTML += `<option value="${ym}">${Number(ym.slice(5))}월분</option>`;
    }
    setOtMonth(getDefaultOtMonth());
}

// 작성 월을 바꾸면 각 줄의 달·제목을 같이 맞춤
function setOtMonth(ym) {
    const sel = document.getElementById('ot-month');
    if (!sel) return;
    if (![...sel.options].some(o => o.value === ym)) {
        // 예전 달 내역을 불러온 경우 선택칸에 그 달을 추가
        sel.innerHTML += `<option value="${ym}">${Number(ym.slice(5))}월분</option>`;
    }
    sel.value = ym;
    sel.dataset.prev = ym;

    // 날짜가 없는 줄은 작성 월로 되돌림 (지난달 날짜가 들어간 줄은 유지)
    document.querySelectorAll('#ot-tbody .date-cell').forEach(cell => {
        const dateInput = cell.querySelector('.work-date');
        if (!dateInput.value) cell.dataset.month = ym;
        syncDayPicker(dateInput);
    });

    // 제목이 비었거나 자동 제목 형식일 때만 바꿈 (직접 쓴 제목은 유지)
    const titleInput = document.getElementById('ot-title');
    if (titleInput && (!titleInput.value.trim() || /^\d{1,2}월 연장근로일지 제출$/.test(titleInput.value.trim()))) {
        titleInput.value = `${Number(ym.slice(5))}월 연장근로일지 제출`;
    }
}

// ------------------------------------------
// 날짜 칸: [연.월 ▾] [일 선택] [📅]
// 연.월은 작성 월이 기본이고, 눌러서 그 줄만 지난달로 바꿀 수 있음 (주황색 표시)
// ------------------------------------------
const OT_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function getOtMonth() {
    const sel = document.getElementById('ot-month');
    return (sel && sel.value) || getDefaultOtMonth();
}

function dayOptionsHtml(ym, selectedYmd) {
    const [y, m] = ym.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const range = monthRange(ym);
    let html = `<option value="">일 선택</option>`;
    for (let d = 1; d <= lastDay; d++) {
        const ymd = `${ym}-${String(d).padStart(2, '0')}`;
        const dow = new Date(y, m - 1, d).getDay();
        const isOff = dow === 0 || dow === 6 || holidays.includes(ymd);
        const disabled = ymd < range.min || ymd > range.max;
        html += `<option value="${ymd}" ${ymd === selectedYmd ? 'selected' : ''} ${disabled ? 'disabled' : ''}`
              + ` style="color:${disabled ? '#bbb' : isOff ? '#dc3545' : '#333'};">${d}일(${OT_WEEKDAYS[dow]})</option>`;
    }
    return html;
}

function dateCellHtml(value) {
    const ym = value ? value.slice(0, 7) : getOtMonth();
    const range = monthRange(ym);
    return `
        <div class="date-cell" data-month="${ym}">
            <button type="button" class="date-prefix" onclick="toggleRowMonthMenu(event, this)"></button>
            <select class="work-day" onchange="handleDaySelect(this)">${dayOptionsHtml(ym, value)}</select>
            <button type="button" class="date-cal-btn" onclick="openDatePicker(this)" title="달력에서 선택">📅</button>
            <input type="date" class="work-date" min="${range.min}" max="${range.max}" value="${value}" onchange="handleDateChange(this)" tabindex="-1">
            <div class="row-month-menu"></div>
        </div>`;
}

// 숨긴 달력 입력칸 값 → 연.월 글자·일 목록·달력 범위에 반영
function syncDayPicker(dateInput) {
    const cell = dateInput.closest('.date-cell');
    if (!cell) return;
    if (dateInput.value) cell.dataset.month = dateInput.value.slice(0, 7);
    const ym = cell.dataset.month || getOtMonth();
    const range = monthRange(ym);
    dateInput.min = range.min;
    dateInput.max = range.max;

    const prefix = cell.querySelector('.date-prefix');
    const canSwitch = getRowMonths().length > 1;
    prefix.textContent = `${ym.replace('-', '.')}.${canSwitch ? ' ▾' : ''}`;
    prefix.classList.toggle('other-month', ym !== getOtMonth());
    prefix.disabled = !canSwitch;
    cell.querySelector('.work-day').innerHTML = dayOptionsHtml(ym, dateInput.value);
}

function toggleRowMonthMenu(e, btn) {
    e.stopPropagation();
    const menu = btn.closest('.date-cell').querySelector('.row-month-menu');
    const isOpen = menu.style.display === 'block';
    closeRowMonthMenus();
    if (isOpen) return;
    const [ym, prev] = getRowMonths();
    menu.innerHTML = `
        <div onclick="setRowMonth(this, '${ym}')">${Number(ym.slice(5))}월 (작성 월)</div>
        <div onclick="setRowMonth(this, '${prev}')">${Number(prev.slice(5))}월 (지난달)</div>`;
    menu.style.display = 'block';
}

function closeRowMonthMenus() {
    document.querySelectorAll('.row-month-menu').forEach(menu => { menu.style.display = 'none'; });
}
document.addEventListener('click', closeRowMonthMenus);

// 그 줄의 달을 바꿈 (이미 고른 날짜는 지움)
function setRowMonth(item, ym) {
    const cell = item.closest('.date-cell');
    const dateInput = cell.querySelector('.work-date');
    closeRowMonthMenus();
    if (cell.dataset.month === ym) return;
    cell.dataset.month = ym;
    if (dateInput.value) {
        dateInput.value = "";
        handleDateChange(dateInput);
    } else {
        syncDayPicker(dateInput);
    }
}

function handleDaySelect(sel) {
    const dateInput = sel.closest('.date-cell').querySelector('.work-date');
    dateInput.value = sel.value;
    handleDateChange(dateInput);
}

function openDatePicker(btn) {
    const dateInput = btn.closest('.date-cell').querySelector('.work-date');
    try {
        dateInput.showPicker();
    } catch (e) {
        // 달력 열기를 지원하지 않는 브라우저: 잠깐 보이게 해서 직접 누르도록
        dateInput.style.cssText = 'position:static; width:auto; height:auto; opacity:1; pointer-events:auto;';
        dateInput.focus();
    }
}

function handleOtMonthChange(sel) {
    const ym = sel.value;
    const allowed = [ym, prevMonthOf(ym)];
    const outside = [...document.querySelectorAll('#ot-tbody .work-date')]
        .filter(input => input.value && !allowed.includes(input.value.slice(0, 7)));
    if (outside.length > 0) {
        if (!confirm(`${Number(ym.slice(5))}월분에 넣을 수 없는 날짜가 ${outside.length}개 있습니다.\n해당 행의 날짜를 지우고 작성 월을 바꿀까요?`)) {
            sel.value = sel.dataset.prev;
            return;
        }
        outside.forEach(input => { input.value = ""; handleDateChange(input); });
    }
    setOtMonth(ym);
    saveDraft();
}

// ==========================================
// 2. 인증 및 로그인/로그아웃 섹션
// ==========================================

// 사원용 로그아웃 함수
function logoutUser() {
    const nameEl = document.getElementById('login-name');
    const phoneEl = document.getElementById('login-phone');
    if(nameEl) nameEl.value = "";
    if(phoneEl) phoneEl.value = "";

    currentUser = { name: "", phone: "" };
    sessionStorage.removeItem('currentUser'); 
    
    location.href = 'index.html';
}

// ==========================================
// 3. 페이지 로드 및 새로고침 검증 문지기
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    const savedUser = sessionStorage.getItem('currentUser');
    if (savedUser) {
        currentUser = JSON.parse(savedUser);
    }
        
    // 1. 사원 페이지(employee.html) 권한 유효성 체크
    // (Vercel 주소에서 .html이 생략되므로 주소 대신 입력표 존재 여부로 판단)
    if (document.getElementById('ot-tbody')) {
        if (currentUser && currentUser.name && currentUser.phone) {
            // 권한 통과 시 로그인 가림막 치우고 메인 시스템 활성화
            const mainSystem = document.getElementById('main-system');
            const loginContainer = document.getElementById('login-container');
            if (mainSystem) mainSystem.style.display = 'block';
            if (loginContainer) loginContainer.style.display = 'none';

            // 👤 작성자 정보 즉시 갱신
            const userDisplay = document.getElementById('user-display');
            if (userDisplay) {
                userDisplay.innerText = `${currentUser.name}(${currentUser.phone})`;
            }
            
            // 📅 제출일자 즉시 갱신
            const dateSpan = document.getElementById('top-today-date');
            if (dateSpan) {
                const today = new Date();
                const yyyy = today.getFullYear();
                const mm = String(today.getMonth() + 1).padStart(2, '0');
                const dd = String(today.getDate()).padStart(2, '0');
                dateSpan.textContent = `${yyyy}. ${mm}. ${dd}.`;
            }
            
            initDatePickerLimits();
            if (typeof resetFormRows === 'function') {
                resetFormRows();
            }
            restoreDraft();
        } else {
            alert("로그인 권한이 없습니다. 로그인 페이지로 이동합니다.");
            location.href = 'index.html';
        }
    }
});

// ==========================================
// 4. 임시저장 데이터 제어 로직
// ==========================================
function viewTempRequests() {
    const modal = document.getElementById('history-modal');
    const tbody = document.getElementById('history-tbody');
    const paginationContainer = document.getElementById('pagination-container');
    const detailArea = document.getElementById('detail-view-area');     
    // 👇 [여기가 핵심 추가!] 진짜 확인증이 들어있는 컨테이너를 찾습니다
    const detailContainer = document.getElementById('detail-view-container');     
    const actionBtnContainer = document.getElementById('modal-action-buttons');
    
    if (!modal) return;
    
    // 👇 [확인증 침범 방지] 상세보기 영역을 완전히 비우고 숨김
    if (detailArea) {
        detailArea.innerHTML = ""; 
        detailArea.style.cssText = "display: none !important;";
    }
    if (detailContainer) {
        detailContainer.style.display = "none"; // 👈 진짜 확인증 숨김 처리!
    }
    if (actionBtnContainer) actionBtnContainer.innerHTML = "";
    
    // 모달 노출 및 나머지 로직 진행
    modal.style.display = 'block';

    const modalTitle = modal.querySelector('h3');
    if (modalTitle) modalTitle.innerText = "나의 임시저장 내역";

    // 테이블 헤더를 임시저장용으로 강제 고정
    const thead = modal.querySelector('#history-table thead') || modal.querySelector('thead');
    if (thead) {
        thead.innerHTML = `
            <tr style="background:#f1f3f5;">
                <th style="width: 8%; padding: 10px; text-align: center;">
                    <input type="checkbox" id="modal-master-check" style="cursor:pointer;">
                </th>
                <th style="width: 54%; padding: 10px; text-align: center;">제목</th>
                <th style="width: 20%; padding: 10px; text-align: center;">신청일/작성일</th>
                <th style="width: 18%; padding: 10px; text-align: center;">총 시간</th>
            </tr>
        `;
    }

    if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#888;">불러오는 중...</td></tr>`;
    
    const modalMaster = document.getElementById('modal-master-check');
    if (modalMaster) modalMaster.checked = false;

    if (!currentUser || !currentUser.name) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#888;">사용자 정보를 찾을 수 없습니다.</td></tr>`;
        return;
    }

    // [최적화] 전체 데이터가 아닌 본인 이름 기준 데이터만 쿼리
    db.collection("temp_requests")
        .where("employeeName", "==", currentUser.name)
        .get()
        .then((snapshot) => {
            const myTempDocs = [];
            snapshot.forEach(doc => {
                myTempDocs.push({ id: doc.id, data: doc.data() });
            });

            myTempDocs.sort((a, b) => {
                const timeA = a.data.savedAt && typeof a.data.savedAt.toDate === 'function' ? a.data.savedAt.toDate().getTime() : 0;
                const timeB = b.data.savedAt && typeof b.data.savedAt.toDate === 'function' ? b.data.savedAt.toDate().getTime() : 0;
                return timeB - timeA;
            });

            if (tbody) tbody.innerHTML = "";

            if (myTempDocs.length === 0) {
                if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#888;">임시저장된 내역이 없습니다.</td></tr>`;
                
                // 데이터가 없을 때도 버튼 렌더링 영역 정리
                if (paginationContainer) paginationContainer.innerHTML = "";
                return;
            }

            myTempDocs.forEach((item) => {
                const data = item.data;
                const savedDate = data.savedAt && typeof data.savedAt.toDate === 'function' ? data.savedAt.toDate().toLocaleDateString() : "-";
                const tr = document.createElement('tr');              
                
                tr.innerHTML = `
                    <td style="padding: 10px; text-align: center; vertical-align: middle;">
                        <input type="checkbox" class="temp-row-check" data-doc-id="${item.id}" style="margin: 0; width: auto; cursor: pointer;">
                    </td>
                    <td style="padding: 10px; font-weight: bold; color: #222; text-align: center; vertical-align: middle;">${data.title || '임시 저장된 연장근로일지'}</td>
                    <td style="padding: 10px; text-align: center; vertical-align: middle;">${savedDate}</td>
                    <td style="padding: 10px; text-align: center; vertical-align: middle;">${data.totalHours || 0} 시간</td>
                `;              

                tr.style.cursor = 'pointer'; 
                tr.onclick = (e) => { 
                    if(e.target.type !== 'checkbox') { 
                        const ck = tr.querySelector('.temp-row-check'); 
                        if(ck) ck.click(); 
                    } 
                };
                if (tbody) tbody.appendChild(tr);
            });

            if (modalMaster) {
                modalMaster.onchange = function() {
                    const checkboxes = tbody.querySelectorAll('.temp-row-check');
                    checkboxes.forEach(cb => {
                        cb.checked = modalMaster.checked;
                    });
                };
            }
            
            // 👇 [버튼 정렬 수정] 페이징 영역은 비우고 숨김
            if (paginationContainer) {
                paginationContainer.innerHTML = "";
                paginationContainer.style.display = "none";
            }

            // 👇 [버튼 정렬 수정] 전용 액션 버튼 영역을 사용하여 완벽한 중앙 정렬
            if (actionBtnContainer) {
                actionBtnContainer.style.cssText = "display: flex !important; flex-direction: row !important; justify-content: center !important; align-items: center !important; gap: 10px !important; width: 100% !important; margin: 20px 0 10px 0 !important;";

                const tempBtnStyle = "width: auto !important; min-width: 70px; height: 36px; padding: 0 16px; border: none; border-radius: 4px; font-size: 13px; font-weight: bold; cursor: pointer; display: inline-flex !important; align-items: center; justify-content: center; white-space: nowrap !important;";

                actionBtnContainer.innerHTML = `
                    <button type="button" onclick="loadCheckedTempRequest()" style="${tempBtnStyle} background-color: var(--primary-color, #007bff); color: #fff;">불러오기</button>
                    <button type="button" onclick="deleteCheckedTempRequests()" style="${tempBtnStyle} background-color: var(--danger-color, #dc3545); color: #fff;">선택 삭제</button>
                `;
            }
        })
        .catch(err => {
            console.error("임시저장 내역 조회 실패:", err);
            if (tbody) tbody.innerHTML = `<tr><td colspan="4" style="padding:15px; text-align:center; color:#d9534f;">조회 중 오류가 발생했습니다.</td></tr>`;
        });

        // ESC 키를 누르면 임시저장 모달이 닫히도록 이벤트 추가
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                const modal = document.getElementById('history-modal');
                if (modal) modal.style.display = 'none';
            }
        });
}

function loadCheckedTempRequest() {
    const checkedBox = document.querySelector('#history-tbody .temp-row-check:checked');
    if (!checkedBox) {
        alert("불러올 임시저장 내역을 선택해주세요.");
        return;
    }
    
    const docId = checkedBox.dataset.docId;
    const modal = document.getElementById('history-modal');
    
    db.collection("temp_requests").doc(docId).get()
        .then((doc) => {
            if (doc.exists) {
                currentTempDocId = doc.id; 
                loadTempRequest(doc.data());
                modal.style.display = 'none'; 
            } else {
                alert("해당 데이터를 찾을 수 없습니다.");
            }
        })
        .catch(err => {
            console.error("데이터 불러오기 실패:", err);
            alert("불러오기 중 오류가 발생했습니다.");
        });
}

function deleteCheckedTempRequests() {
    const checkedBoxes = document.querySelectorAll('#history-tbody .temp-row-check:checked');
    if (checkedBoxes.length === 0) {
        alert("삭제할 내역을 선택해주세요.");
        return;
    }
    if (!confirm("삭제하시겠습니까?")) return;    
    
    let deletePromises = [];
    checkedBoxes.forEach(cb => {
        const docId = cb.dataset.docId;
        const promise = db.collection("temp_requests").doc(docId).delete();
        deletePromises.push(promise);
        
        if (currentTempDocId === docId) {
            currentTempDocId = null;
        }
    });
    
    Promise.all(deletePromises)
        .then(() => {            
            viewTempRequests(); 
        })
        .catch(err => {
            console.error("오류 발생:", err);
            alert("삭제 중 오류가 발생했습니다.");
        });
}

function loadTempRequest(tempData) {
    if(document.getElementById('ot-title') && tempData.title) {
        document.getElementById('ot-title').value = tempData.title;
    }
    // 불러온 내역의 가장 늦은 날짜 기준으로 작성 월 맞춤 (앞선 날짜는 지난달 예외 줄로 표시됨)
    const lastDate = (tempData.detailLogs || []).map(log => log.date).filter(Boolean).sort().pop();
    if (lastDate) setOtMonth(lastDate.slice(0, 7));

    const tbody = document.getElementById('ot-tbody');
    tbody.innerHTML = "";
    
    tempData.detailLogs.forEach(log => {
        const tr = document.createElement('tr');
        tr.dataset.workType = log.type || 'weekday';
        
        tr.innerHTML = `
            <td><input type="checkbox" class="row-check" style="margin:0; width:auto;"></td>
            <td>${dateCellHtml(log.date)}</td>
            <td><span class="type-text ${log.type === 'weekend' ? 'type-weekend' : 'type-weekday'}">${log.type === 'weekday' ? '평일 야근' : '주말/공휴일'}</span></td>
            <td><div class="start-time-container" data-value="${log.start}"></div></td>
            <td><div class="end-time-container" data-value="${log.end}"></div></td>
            <td><input type="text" class="work-reason" placeholder="업무 입력" value="${log.reason}" style="width:95%;"></td>
            <td><span class="row-calculated-hours">${log.hours}</span><span class="unit-text">시간</span></td>
        `;        
        tbody.appendChild(tr);
        makeSmartSelect(tr, 'start', tr.dataset.workType, log.start);
        makeSmartSelect(tr, 'end', tr.dataset.workType, log.end);
    });
    const currentRows = tbody.querySelectorAll('tr').length;
    if(currentRows < 10) {
        for(let i=0; i < (10 - currentRows); i++) { addRow(); }
    }    
    calculateTotalHours();
}

function saveTemporary(event) {
    if (event) event.preventDefault();

    const rows = document.querySelectorAll('#ot-tbody tr');
    let logs = [];
    let hasAnyData = false;

    rows.forEach(row => {
        const dateInput = row.querySelector('.work-date');
        const reasonInput = row.querySelector('.work-reason');
        
        if (!dateInput || !reasonInput) return;

        const date = dateInput.value;
        const startVal = row.querySelector('.start-time-container').dataset.value || "";
        const endVal = row.querySelector('.end-time-container').dataset.value || "";
        const reason = reasonInput.value.trim();

        if (date || startVal || endVal || reason) {
            hasAnyData = true;
            logs.push({
                date: date || "",
                type: row.dataset.workType || "weekday",
                start: startVal,
                end: endVal,
                hours: parseFloat(row.querySelector('.row-calculated-hours').innerText) || 0,
                reason: reason
            });
        }
    });

    const titleInput = document.getElementById('ot-title');
    const titleVal = titleInput ? titleInput.value.trim() : "";

    // 자동으로 채워진 제목만 있는 경우도 빈 내용으로 봄
    if (!hasAnyData && (!titleVal || /^\d{1,2}월 연장근로일지 제출$/.test(titleVal))) {
        alert("내용이 없습니다. 내용을 입력해 주세요.");
        return;
    }

    const now = new Date();
    const timestampStr = now.getFullYear() + 
                         String(now.getMonth() + 1).padStart(2, '0') + 
                         String(now.getDate()).padStart(2, '0') + "_" + 
                         String(now.getHours()).padStart(2, '0') + 
                         String(now.getMinutes()).padStart(2, '0') + 
                         String(now.getSeconds()).padStart(2, '0');
    
    const docId = `${currentUser.name}_${currentUser.phone}_temp_${timestampStr}`;

    db.collection("temp_requests").doc(docId).set({
        title: titleVal || "임시 저장된 연장근로일지",
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        savedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalHours: calculateTotalHours(),
        detailLogs: logs
    })
    .then(() => {
        alert("임시저장 되었습니다.");
        resetFormRows();
    })
    .catch((error) => {
        console.error("임시저장 실패:", error);
        alert("임시저장 중 오류가 발생했습니다.");
    });
}

// ==========================================
// 4-1. 작성 중 내역 자동 저장 (뒤로가기·새로고침·창 닫힘 대비, 이 브라우저에만 보관)
// ==========================================
let draftReady = false; // 복원 여부를 묻기 전에는 저장하지 않음 (초기 빈 화면이 기존 내역을 덮어쓰지 않도록)

function getDraftKey() {
    return `ot-draft:${currentUser.name}_${currentUser.phone}`;
}

function saveDraft() {
    if (!draftReady || !currentUser || !currentUser.name) return;
    const logs = [];
    document.querySelectorAll('#ot-tbody tr').forEach(row => {
        const dateInput = row.querySelector('.work-date');
        const reasonInput = row.querySelector('.work-reason');
        if (!dateInput || !reasonInput) return;
        const start = row.querySelector('.start-time-container').dataset.value || "";
        const end = row.querySelector('.end-time-container').dataset.value || "";
        if (!dateInput.value && !start && !end && !reasonInput.value.trim()) return;
        logs.push({
            date: dateInput.value,
            type: row.dataset.workType || "weekday",
            start: start,
            end: end,
            hours: parseFloat(row.querySelector('.row-calculated-hours').innerText) || 0,
            reason: reasonInput.value
        });
    });

    try {
        if (logs.length === 0) {
            localStorage.removeItem(getDraftKey());
            return;
        }
        const titleInput = document.getElementById('ot-title');
        localStorage.setItem(getDraftKey(), JSON.stringify({
            title: titleInput ? titleInput.value : "",
            detailLogs: logs,
            originDocIdForRewrite: originDocIdForRewrite,
            currentTempDocId: currentTempDocId,
            savedAt: Date.now()
        }));
    } catch (e) {
        console.warn("자동 저장 실패:", e);
    }
}

function restoreDraft() {
    let draft = null;
    try {
        draft = JSON.parse(localStorage.getItem(getDraftKey()));
    } catch (e) {
        draft = null;
    }

    if (draft && Array.isArray(draft.detailLogs) && draft.detailLogs.length > 0) {
        const savedTime = new Date(draft.savedAt).toLocaleString();
        if (confirm(`작성 중이던 내역이 있습니다. (${savedTime} 자동 저장)\n불러오시겠습니까?`)) {
            loadTempRequest(draft);
            originDocIdForRewrite = draft.originDocIdForRewrite || null;
            currentTempDocId = draft.currentTempDocId || null;
        } else {
            try { localStorage.removeItem(getDraftKey()); } catch (e) {}
        }
    }
    draftReady = true;

    // 업무 내용·제목 입력도 즉시 저장 (날짜·시간 변경은 calculateTotalHours에서 저장)
    const form = document.getElementById('main-system') || document;
    form.addEventListener('input', (e) => {
        if (e.target.closest('#ot-tbody') || e.target.id === 'ot-title') saveDraft();
    });
}

// ==========================================
// 5. 셀렉트 박스 및 동적 시간 계산 로직
// ==========================================

// 1. 중복 날짜 체크 함수 (함수 밖으로 빼내기)
function checkDuplicateDate(currentInput) {
    const currentDate = currentInput.value;
    if (!currentDate) return false;

    const allDateInputs = document.querySelectorAll('#ot-tbody .work-date');
    let duplicateCount = 0;

    allDateInputs.forEach(input => {
        if (input.value === currentDate) {
            duplicateCount++;
        }
    });

    if (duplicateCount > 1) {
        currentInput.value = ""; // 중복된 경우 값 초기화
        handleDateChange(currentInput); // 초기화에 따른 상태 동기화
        return true;
    }
    return false;
}

function buildCustomOptions(type, mode, weekdayStartVal) {
    let baseTime = (type === 'weekend') ? "09:00" : "18:00";
    if (type === 'weekday' && mode === 'start') return ["18:30", "19:00", "19:30"];
    if (type === 'weekday' && mode === 'end') {
        if (weekdayStartVal === "18:30") baseTime = "19:00";
        else if (weekdayStartVal === "19:00") baseTime = "19:30";
        else if (weekdayStartVal === "19:30") baseTime = "20:00";
        else baseTime = "19:00";
    }
    let [baseH, baseM] = baseTime.split(':').map(Number);
    let baseTotalMin = baseH * 60 + baseM;
    let arr = [baseTime];
    for (let i = 1; i < 48; i++) {
        let currentTotalMin = (baseTotalMin + i * 30) % (24 * 60);
        let h = Math.floor(currentTotalMin / 60);
        let m = currentTotalMin % 60;
        let t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        arr.push(t);
        if (type === 'weekday' && mode === 'end' && t === '08:30') break;
    }
    return arr;
}

function makeSmartSelect(row, mode, type, startVal) {
    const container = row.querySelector(`.${mode}-time-container`);
    if (type === 'weekday' && mode === 'end' && !startVal) startVal = row.querySelector('.start-time-container').dataset.value || "08:30";
    
    const timeList = buildCustomOptions(type, mode, startVal);
    
    let currentVal = container.dataset.value || "";
    let initialText = currentVal && timeList.includes(currentVal) ? currentVal : "선택";

    let html = `<div class="custom-select-wrapper"><div class="selected-value" onclick="toggleDropdown(this)">${initialText}</div><div class="select-options-box"><div onclick="selectCustomValue(this, '')">선택</div>`;
    timeList.forEach(t => { html += `<div onclick="selectCustomValue(this, '${t}')">${t}</div>`; });
    html += `</div></div>`;
    container.innerHTML = html;
}

function selectCustomValue(el, val) {
    const wrapper = el.closest('.custom-select-wrapper');
    const displayDiv = wrapper.querySelector('.selected-value');
    const container = wrapper.parentElement;
    displayDiv.innerText = val ? val : "선택";
    container.dataset.value = val;
    wrapper.querySelector('.select-options-box').style.display = 'none';
    const row = container.closest('tr');
    if (row && row.dataset.workType === 'weekday' && container.classList.contains('start-time-container')) {
        makeSmartSelect(row, 'end', 'weekday', val);
    }
    calculateRowHours(container);
}

function toggleDropdown(el) {
    document.querySelectorAll('.select-options-box').forEach(box => { if(box !== el.nextElementSibling) box.style.display = 'none'; });
    const target = el.nextElementSibling;
    target.style.display = (target.style.display === 'block') ? 'none' : 'block';
}

function handleDateChange(dateInput) {
    syncDayPicker(dateInput);

    // 🛑 [핵심 수정] 함수가 시작하자마자 중복 날짜부터 체크합니다!
    if (checkDuplicateDate(dateInput)) {
        return;
    }

    const row = dateInput.closest('tr');
    const typeTextSpan = row.querySelector('.type-text');
    
    const startContainer = row.querySelector('.start-time-container');
    const endContainer = row.querySelector('.end-time-container');

    // 1. 날짜를 지웠을 때: 완전 초기화 (빈칸)
    if(!dateInput.value) { 
        typeTextSpan.innerText = "-"; 
        typeTextSpan.className = "type-text";
        row.dataset.workType = "";
        if (startContainer) startContainer.dataset.value = "";
        if (endContainer) endContainer.dataset.value = "";
        makeSmartSelect(row, 'start', 'weekday');
        makeSmartSelect(row, 'end', 'weekday');
        calculateRowHours(dateInput);
        return; 
    }
    
    const selectedDateStr = dateInput.value; 
    const dayOfWeek = new Date(selectedDateStr).getDay(); 
    
    // 2. 날짜를 선택했을 때 평일/주말 판별 및 시작 시간 자동 지정!
    if (dayOfWeek === 0 || dayOfWeek === 6 || holidays.includes(selectedDateStr)) {
        typeTextSpan.innerText = "주말/공휴일"; 
        typeTextSpan.className = "type-text type-weekend"; 
        row.dataset.workType = 'weekend';
        if (startContainer) startContainer.dataset.value = "09:00"; // 주말은 09:00
    } else {
        typeTextSpan.innerText = "평일 야근"; 
        typeTextSpan.className = "type-text type-weekday"; 
        row.dataset.workType = 'weekday';
        if (startContainer) startContainer.dataset.value = "18:30"; // 평일은 18:30
    }
    
    if (endContainer) endContainer.dataset.value = "";

    makeSmartSelect(row, 'start', row.dataset.workType);
    makeSmartSelect(row, 'end', row.dataset.workType);
    calculateRowHours(dateInput);
}

// ==========================================
// 6. 테이블 행 제어 및 계산 로직
// ==========================================
function resetFormRows() {
    document.getElementById('ot-tbody').innerHTML = "";
    for(let i=0; i<10; i++) { addRow(); }
    const masterCheck = document.getElementById('master-check');
    if (masterCheck) masterCheck.checked = false;    
    currentTempDocId = null;
    setOtMonth(getDefaultOtMonth());
    calculateTotalHours();
}

function clearFormWithConfirm() {
    if (confirm("작성 중인 내역이 초기화됩니다. 계속하시겠습니까?")) {
        const titleInput = document.getElementById('ot-title');
        if (titleInput) {
            titleInput.value = "";
        }
        resetFormRows();
    }
}

function addRow() {
    const tr = document.createElement('tr');
    tr.dataset.workType = 'weekday';     
    tr.innerHTML = `
        <td><input type="checkbox" class="row-check" style="margin:0; width:auto;"></td>
        <td>${dateCellHtml('')}</td>
        <td><span class="type-text">-</span></td>
        <td><div class="start-time-container" data-value=""></div></td>
        <td><div class="end-time-container" data-value=""></div></td>
        <td><input type="text" class="work-reason" placeholder="업무 입력" style="width:95%;"></td>
        <td><span class="row-calculated-hours">0</span><span class="unit-text">시간</span></td>
    `;    
    makeSmartSelect(tr, 'start', 'weekday');
    makeSmartSelect(tr, 'end', 'weekday');
    document.getElementById('ot-tbody').appendChild(tr);
}

function toggleAllCheckboxes(master) {
    const checkboxes = document.querySelectorAll('#ot-tbody .row-check');
    checkboxes.forEach(cb => { cb.checked = master.checked; });
}

function deleteCheckedRows() {
    const checkedBoxes = document.querySelectorAll('#ot-tbody .row-check:checked');
    if (checkedBoxes.length === 0) {
        alert("삭제할 행을 선택해주세요.");
        return;
    }    
    const isConfirmed = (checkedBoxes.length >= 2) 
        ? confirm(`선택한 ${checkedBoxes.length}개의 행을 삭제하시겠습니까?`) 
        : true;        
    if (isConfirmed) {
        checkedBoxes.forEach(cb => { cb.closest('tr').remove(); });
        const masterCheck = document.getElementById('master-check');
        if (masterCheck) masterCheck.checked = false;
        calculateTotalHours();
    }
}

function calculateRowHours(el) {
    const row = el.closest('tr');
    const type = row.dataset.workType; 
    const startVal = row.querySelector('.start-time-container').dataset.value || "";
    const endVal = row.querySelector('.end-time-container').dataset.value || "";
    const resSpan = row.querySelector('.row-calculated-hours');
    if (!startVal || !endVal) { resSpan.innerText = "0"; calculateTotalHours(); return; }
    let [sh, sm] = startVal.split(':').map(Number);
    let [eh, em] = endVal.split(':').map(Number);
    let sMin = sh * 60 + sm;
    let eMin = eh * 60 + em;
    if (eMin < sMin) eMin += 24 * 60; 
    let diff = eMin - sMin;
    if (type === 'weekend') {
        if (sMin <= 720 && eMin >= 780) diff -= 60;
        if (sMin < 1080 && eMin > 1080) diff -= 30;
    }
    resSpan.innerText = Math.max(0, diff / 60).toFixed(1);
    calculateTotalHours();
}

function calculateTotalHours() {
    let total = 0;
    document.querySelectorAll('.row-calculated-hours').forEach(s => total += parseFloat(s.innerText) || 0);

    // 고정OT 구분별 사용 시간 집계 (관리자 수당 계산과 같은 splitWorkLog 사용)
    const used = { overtime: 0, holiday: 0, night: 0 };
    document.querySelectorAll('#ot-tbody tr').forEach(row => {
        const dateEl = row.querySelector('.work-date');
        const startEl = row.querySelector('.start-time-container');
        const endEl = row.querySelector('.end-time-container');
        if (!dateEl || !startEl || !endEl) return;
        splitWorkLog({
            date: dateEl.value,
            type: row.dataset.workType,
            start: startEl.dataset.value,
            end: endEl.dataset.value
        }).forEach(({ bucket, hours }) => { if (hours > 0) used[bucket] += hours; });
    });
    const labels = { overtime: '연장', holiday: '휴일', night: '야간' };
    const overKeys = Object.keys(FIX_OT_LIMITS).filter(k => used[k] > FIX_OT_LIMITS[k]);

    const totalDisplay = document.getElementById('total-hours');
    const badge = document.getElementById('ot-status');
    const breakdown = document.getElementById('ot-breakdown');

    if(totalDisplay) totalDisplay.innerText = total.toFixed(1) + " 시간";

    // 구분별 사용/한도 표시 (초과한 항목은 빨간색)
    if(breakdown) {
        breakdown.innerHTML = Object.keys(FIX_OT_LIMITS).map(k => {
            const color = overKeys.includes(k) ? 'var(--danger-color)' : '#888';
            return `<span style="color: ${color};">${labels[k]} ${used[k].toFixed(1)}/${Math.floor(FIX_OT_LIMITS[k] * 2) / 2}</span>`; // 근무는 0.5시간 단위라 한도도 0.5 단위로 내림 표시
        }).join(' · ');
    }

    if(badge) {
        if (overKeys.length > 0) {
            badge.innerText = `★초과수당 지급대상 (${overKeys.map(k => labels[k]).join('·')} 초과)`;
            badge.className = "status-badge over-ot"; 
        } else { 
            badge.innerText = "고정OT 범위 내"; 
            badge.className = "status-badge under-ot";
        }
    }
    saveDraft();
    return total;
}

// ==========================================
// 7. 데이터 최종 제출 로직 (Submit)
// ==========================================
function submitForm(event) {
    event.preventDefault();

    const rows = document.querySelectorAll('#ot-tbody tr');
    let logs = [];
    let isValid = true; 
    let hasData = false;

    for (let row of rows) {
        const dateInput = row.querySelector('.work-date');
        const reasonInput = row.querySelector('.work-reason');
        
        if (!dateInput || !reasonInput) continue;

        const date = dateInput.value;
        const startVal = row.querySelector('.start-time-container').dataset.value;
        const endVal = row.querySelector('.end-time-container').dataset.value;
        const reason = reasonInput.value.trim();

        if (date || startVal || endVal) {
            hasData = true;
            // 빈 항목이 하나라도 있으면 검증 실패 처리 후 즉시 중단하고 빠져나옴 (알림은 딱 1번만!)
            if (!date || !startVal || !endVal || !reason) {
                isValid = false;
                break; 
            }
            logs.push({ 
                date, 
                type: row.dataset.workType, 
                start: startVal, 
                end: endVal, 
                hours: parseFloat(row.querySelector('.row-calculated-hours').innerText), 
                reason: reason 
            });
        }
    }

    if (!isValid) {
        alert("입력하신 행의 날짜, 시간, 업무 상세내역을 모두 기입해주세요.");
        return;
    }
    if (!hasData) { alert("제출할 데이터가 없습니다."); return; }

    const titleInput = document.getElementById('ot-title');
    if (!titleInput.value.trim()) {
        alert("신청 제목을 입력해주세요.");
        titleInput.focus();
        return;
    }

    if (!confirm("제출하시겠습니까?")) return;
    const finalStatus = originDocIdForRewrite ? "재전송" : "대기";
    const otData = {
        title: titleInput.value.trim(),
        employeeName: currentUser.name,
        employeePhone: currentUser.phone,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp(),
        totalHours: calculateTotalHours(),
        status: finalStatus,
        detailLogs: logs
    };
    // 1. 신규 또는 재전송 문서 추가
    db.collection("overtime_requests").add(otData)
        .then(() => {
            let promises = [];
            
            // 2. 반송 문서를 다시 쓴 거라면 기존 결재 문서 삭제
            if (originDocIdForRewrite) {
                promises.push(db.collection("overtime_requests").doc(originDocIdForRewrite).delete());
            }
            
            // 3. 임시저장함에서 불러와서 최종 제출한 거라면 기존 임시저장 삭제!
            if (currentTempDocId) {
                promises.push(db.collection("temp_requests").doc(currentTempDocId).delete());
            }
            
            return Promise.all(promises);
        })
        .then(() => {
            alert("성공적으로 제출되었습니다.");
            titleInput.value = "";
            originDocIdForRewrite = null;
            currentTempDocId = null;            
            resetFormRows();
        })
        .catch((err) => {
            console.error("제출 중 오류 발생:", err);
            alert("제출에 실패했습니다.");
        });
}

// ==========================================
// 8. 결재 제출내역 조회 및 페이지네이션 (모달 연동)
// ==========================================
function viewMyRequests() {
    const modal = document.getElementById('history-modal');
    const tbody = document.getElementById('history-tbody');
    const paginationContainer = document.getElementById('pagination-container');
    const detailArea = document.getElementById('detail-view-area');
    const modalTitle = document.querySelector('#history-modal h3');
    const thead = document.getElementById('modal-thead') || (modal ? modal.querySelector('thead') : null);
    const actionBtnContainer = document.getElementById('modal-action-buttons'); // 하단 버튼 구역
    
    // 필수 엘리먼트 부재 시 안전 리턴
    if (!modal || !tbody) {
        console.warn("모달 또는 테이블 바디 엘리먼트를 찾을 수 없습니다.");
        return;
    }

    // 1. 모달 최상단 우측에 검색 버튼과 동일한 스타일의 인쇄 버튼 배치
    if (modalTitle) {
        if (!document.getElementById('history-search-input')) {
            modalTitle.innerHTML = `
                <div style="display: flex; flex-direction: column; width: 100%; gap: 8px; position: relative;">
                    <!-- 최상단 우측에 위치할 인쇄 버튼 (width 100% 현상 방지) -->
                    <div style="display: flex; justify-content: flex-end; width: 100%;">
                        <button type="button" onclick="printSelectedHistory()" style="display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 12px; border: 1px solid #e2e8f0; background: #fff; color: #555; cursor: pointer; border-radius: 3px; font-size: 13px; font-family: sans-serif; font-weight: bold; box-sizing: border-box; margin: 0; line-height: 1; white-space: nowrap; width: auto !important; flex: none !important;">🖨️ 인쇄</button>
                    </div>

                    <!-- "나의 제출 내역" 타이틀과 검색창 영역 -->
                    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <span style="font-size: 20px; font-weight: bold;">나의 제출 내역</span>
                        
                        <div style="display: flex; align-items: center; gap: 5px; white-space: nowrap;">
                            <span style="font-size: 14px; font-weight: normal; color: #222; margin-right: 2px;">제목 :</span>
                            <input type="text" id="history-search-input" placeholder="검색어 입력..." style="padding: 0 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; width: 150px; box-sizing: border-box; height: 30px; margin: 0;">
                            <button type="button" id="history-search-btn" style="display: inline-flex; align-items: center; justify-content: center; height: 30px; padding: 0 12px; border: 1px solid #e2e8f0; background: #fff; color: #555; cursor: pointer; border-radius: 3px; font-size: 13px; font-family: sans-serif; font-weight: bold; box-sizing: border-box; margin: 0; line-height: 1;">검색</button>
                        </div>
                    </div>
                </div>
            `;
        } else {
            document.getElementById('history-search-input').value = "";
        }
    }
    
    // 2. 헤더 세팅
    if (thead) {
        thead.innerHTML = `
            <tr style="background:#f1f3f5;">
                <th style="width: 8%; padding: 10px; text-align: center;">
                    <input type="checkbox" id="modal-master-check" style="cursor:pointer;">
                </th>
                <th style="width: 44%; padding: 10px; text-align: center;">제목</th>
                <th style="width: 18%; padding: 10px; text-align: center;">신청일/작성일</th>
                <th style="width: 14%; padding: 10px; text-align: center;">총 시간</th>
                <th style="width: 16%; padding: 10px; text-align: center;">상태</th>
            </tr>
        `;
    }
    // [회수 / 삭제 / 재작성] 하단 버튼 영역
    if (actionBtnContainer) {
        actionBtnContainer.style.cssText = "display: flex !important; flex-direction: row !important; justify-content: flex-end !important; align-items: center !important; gap: 8px !important; width: 100% !important; margin: 15px 0 10px 0 !important;";

        const btnStyle = "width: auto !important; min-width: 50px; height: 36px; padding: 0 14px; border: none; border-radius: 4px; font-size: 13px; font-weight: bold; cursor: pointer; display: inline-flex !important; align-items: center; justify-content: center; white-space: nowrap !important;";

        actionBtnContainer.innerHTML = `
            <button type="button" onclick="handleBulkAction('withdraw')" style="${btnStyle} background-color: #ffc107; color: #212529;">회수</button>
            <button type="button" onclick="handleBulkAction('delete')" style="${btnStyle} background-color: #dc3545; color: #fff;">삭제</button>
            <button type="button" onclick="handleBulkAction('rewrite')" style="${btnStyle} background-color: #28a745; color: #fff;">재작성</button>
        `;
    }
    // 마스터 체크박스 기능
    const modalMaster = document.getElementById('modal-master-check');
    if (modalMaster) {
        modalMaster.checked = false;
        modalMaster.onchange = function() {
            const checkboxes = document.querySelectorAll('#history-tbody .submit-row-check');
            checkboxes.forEach(cb => cb.checked = modalMaster.checked);
        };
    }    
    
    if (detailArea) detailArea.style.display = 'none';
    modal.style.display = 'block';
    // ★ [추가] 제출내역조회 모달이 열릴 때 스크롤 위치를 맨 위로 초기화
    modal.scrollTop = 0;
    const historyScrollBox = modal.querySelector('.modal-content') || modal.querySelector('.modal-body') || modal;
    if (historyScrollBox) historyScrollBox.scrollTop = 0;


   // ★ [완전 수정] 3단계 계층별 ESC 처리 통합 로직
    if (window._historyModalKeyHandler) {
        window.removeEventListener('keydown', window._historyModalKeyHandler, true);
    }

    window._historyModalKeyHandler = function(e) {
        if (e.key === 'Escape' || e.keyCode === 27) {
            const printModal = document.getElementById('print-modal');
            const historyModal = document.getElementById('history-modal');
            const detailContainer = document.getElementById('detail-view-container');

            // 1단계: 인쇄 모달이 떠 있는 경우 -> 인쇄 모달만 닫음 (아래 상세내역은 그대로 유지)
            if (printModal && (printModal.style.display === 'flex' || printModal.style.display === 'block')) {
                printModal.style.display = 'none';
                e.preventDefault();
                e.stopPropagation();
                return;
            }

            // 제출내역 조회 모달이 열려 있을 때
            if (historyModal && (historyModal.style.display === 'block' || historyModal.style.display === 'flex')) {
                
                // 2단계: 아래 상세내역(확인증)이 열려 있는 경우 -> 상세내역만 닫음
                if (detailContainer && (detailContainer.style.display === 'block' || detailContainer.style.display === 'flex')) {
                    detailContainer.style.display = 'none';
                    
                    // 선택된 행 강조 표시 초기화
                    tbody.querySelectorAll('tr').forEach(item => {
                        item.style.backgroundColor = '';
                        item.classList.remove('selected');
                    });
                    
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }

                // 3단계: 상세내역이 이미 닫혀 있는 경우 -> 제출내역 조회 모달 전체를 닫음
                historyModal.style.display = 'none';
                window.removeEventListener('keydown', window._historyModalKeyHandler, true);
                e.preventDefault();
                e.stopPropagation();
            }
        }
    };

    // 가장 높은 우선순위로 capture 레벨(true) 이벤트 등록
    window.addEventListener('keydown', window._historyModalKeyHandler, true);


    let currentPage = 1;
    const itemsPerPage = 5;
    let allData = [];      
    let filteredData = []; 

    // 안전장치: currentUser가 정의되어 있지 않거나 값이 비어 있을 때 에러 방지
    if (typeof currentUser === 'undefined' || !currentUser || !currentUser.name) {
        console.error("사용자 정보(currentUser)가 로드되지 않았습니다.");
        tbody.innerHTML = `<tr><td colspan="5" style="padding:15px; text-align:center; color:#dc3545;">사용자 정보를 불러올 수 없습니다. 다시 로그인해 주세요.</td></tr>`;
        return;
    }

    // 파이어베이스 데이터 가져오기
    db.collection("overtime_requests")
        .where("employeeName", "==", currentUser.name)
        .where("employeePhone", "==", currentUser.phone)
        .orderBy("submittedAt", "desc")
        .get()
        .then((snapshot) => {
            allData = [];
            snapshot.forEach((doc) => {
                allData.push({ id: doc.id, ...doc.data() });
            });            
            filteredData = [...allData];
            renderPage(currentPage);

            const searchBtn = document.getElementById('history-search-btn');
            const searchInput = document.getElementById('history-search-input');
            
            if (searchBtn && searchInput) {
                searchBtn.onclick = function() {
                    const keyword = searchInput.value.trim().toLowerCase();
                    if (keyword === "") {
                        filteredData = [...allData];
                    } else {
                        filteredData = allData.filter(item => 
                            (item.title || '').toLowerCase().includes(keyword)
                        );
                    }
                    renderPage(1);
                };
                searchInput.onkeyup = function(e) {
                    if (e.key === 'Enter') searchBtn.click();
                };
            }
        })
        .catch(err => {
            console.error("데이터 로드 실패:", err);
            tbody.innerHTML = `<tr><td colspan="5" style="padding:15px; text-align:center; color:#dc3545;">데이터를 불러오는 중 오류가 발생했습니다.</td></tr>`;
        });                     
                     
    function renderPage(page) {
        tbody.innerHTML = "";
        currentPage = page;
        if (filteredData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:15px; text-align:center; color:#888;">제출 내역이 없습니다.</td></tr>`;
            if (paginationContainer) paginationContainer.innerHTML = "";
            return;
        }
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pageData = filteredData.slice(startIndex, endIndex);

        pageData.forEach((data) => {
            let statusColor = '#6c757d';
            if (data.status === '승인') statusColor = '#007bff';
            else if (data.status === '반송') statusColor = '#dc3545';
            else if (data.status === '작성') statusColor = '#e67e22';
            else if (data.status === '대기' || data.status === '재전송') statusColor = '#2c3e50';

            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.innerHTML = `
                <td style="padding:10px; text-align:center; vertical-align:middle;">
                    <input type="checkbox" class="submit-row-check" data-doc-id="${data.id}" style="margin:0; width:auto; cursor:pointer;" onclick="event.stopPropagation();">
                </td>
                <td style="padding:10px; text-align:center; vertical-align:middle; font-weight:bold; color:#222;">${data.title || '제목 없음'}</td>
                <td style="padding:10px; text-align:center; vertical-align:middle;">${data.submittedAt ? data.submittedAt.toDate().toLocaleDateString() : "-"}</td>
                <td style="padding:10px; text-align:center; vertical-align:middle;">${data.totalHours} 시간</td>
                <td style="padding:10px; text-align:center; vertical-align:middle;">
                    <span style="color: ${statusColor}; font-weight: bold;">${data.status}</span>
                </td>
            `;            
            tr.onclick = () => {
                // 1. 모든 행의 선택 상태 및 체크박스 초기화
                tbody.querySelectorAll('tr').forEach(item => {
                    item.style.backgroundColor = '';
                    item.classList.remove('selected');
                    const cb = item.querySelector('.submit-row-check');
                    if (cb) cb.checked = false;
                });
                // 2. 현재 클릭한 행 선택 및 배경색 지정
                tr.style.backgroundColor = '#e7f3ff';
                tr.classList.add('selected');
                // 3. 현재 행의 체크박스 자동 체크
                const currentCheckbox = tr.querySelector('.submit-row-check');
                if (currentCheckbox) {
                    currentCheckbox.checked = true;
                }
                // 4. 상세 내역 표시 함수 호출
                showDetailInModal(data);
            };
            tbody.appendChild(tr);
        });

        // 2. ★ [핵심] 부족한 빈 행을 빈 공간(투명 행)으로 채워 높이 고정
        const emptyRowsCount = itemsPerPage - pageData.length;
        for (let i = 0; i < emptyRowsCount; i++) {
            const emptyTr = document.createElement('tr');
            emptyTr.style.height = '45px'; // 실제 데이터 행과 동일한 높이 지정
            emptyTr.innerHTML = `
                <td style="padding:10px;">&nbsp;</td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
            `;
            tbody.appendChild(emptyTr);
        }

        if (modalMaster) modalMaster.checked = false;
        renderPaginationButtons();
    }

    function renderPaginationButtons() {
        if (!paginationContainer) return;
        paginationContainer.innerHTML = "";
        const totalPages = Math.ceil(filteredData.length / itemsPerPage);
        
        if (totalPages <= 1) return;

        const baseStyle = "display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; margin: 0 3px; border: 1px solid #e2e8f0; background: #fff; color: #555; cursor: pointer; border-radius: 3px; font-size: 13px; font-family: sans-serif;";
        const activeStyle = baseStyle + " border-color: #007bff; color: #007bff; font-weight: bold;";
        const disabledStyle = baseStyle + " opacity: 0.3; cursor: not-allowed;";

        function createBtn(text, targetPage, isEnabled, customStyle = baseStyle) {
            const btn = document.createElement('button');
            btn.innerText = text;
            if (isEnabled) {
                btn.style.cssText = customStyle;
                btn.onclick = () => renderPage(targetPage);
            } else {
                btn.style.cssText = disabledStyle;
            }
            return btn;
        }
        paginationContainer.appendChild(createBtn("«", 1, currentPage > 1));
        paginationContainer.appendChild(createBtn("‹", currentPage - 1, currentPage > 1));
        for (let i = 1; i <= totalPages; i++) {
            paginationContainer.appendChild(createBtn(i.toString(), i, true, (i === currentPage) ? activeStyle : baseStyle));
        }
        paginationContainer.appendChild(createBtn("›", currentPage + 1, currentPage < totalPages));
        paginationContainer.appendChild(createBtn("»", totalPages, currentPage < totalPages));
    }
}

function openTab(tabId, element) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');
    if (element) element.classList.add('active');
}

function showDetailInModal(data) {
    // 화면 상세보기도 인쇄 양식(연장근로 신청 확인서)과 같은 디자인으로 표시
    const detailContainer = document.getElementById('detail-view-container');
    const detailBody = document.getElementById('detail-view-body');
    if (!detailContainer || !detailBody) return;

    detailBody.innerHTML = renderOvertimeSheetHtml({ ...data, employeeName: data.employeeName || currentUser.name });
    detailContainer.style.display = 'block';
}

function handleBulkAction(actionType) {
    console.log("=== handleBulkAction 실행 시작 ===");
    let tr = document.querySelector('#history-tbody tr.selected');
    if (!tr) {
        const checkedBox = document.querySelector('#history-tbody .submit-row-check:checked');
        if (checkedBox) tr = checkedBox.closest('tr');
    }    
    if (!tr) {
        alert("작업을 수행할 항목(행)을 클릭하거나 체크박스를 선택해주세요.");
        return;
    }
    const targetCheck = tr.querySelector('.submit-row-check');
    if (!targetCheck) {
        alert("문서 정보를 찾을 수 없습니다.");
        return;
    }
    const docId = targetCheck.dataset.docId;
    const statusTd = tr.querySelector('td:nth-child(5)');
    const currentStatus = statusTd ? statusTd.innerText.trim() : "";

    if (actionType === 'withdraw') {
        if (currentStatus.includes("승인")) {
            alert("승인된 문서는 변경 및 삭제가 불가능합니다.");
            return;
        }
        if (!currentStatus.includes("대기") && !currentStatus.includes("재전송")) {
            alert("대기 또는 재전송 상태인 문서만 회수할 수 있습니다. (현재 상태: " + currentStatus + ")");
            return;
        }
        if (!confirm("이 신청 건을 회수하시겠습니까? (회수 후 수정 및 삭제가 가능합니다)")) return;

        db.collection("overtime_requests").doc(docId).update({
            status: "작성",
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        })
        .then(() => {
            alert("성공적으로 회수되었습니다. '작성' 상태로 변경됩니다.");
            viewMyRequests(); 
        })
        .catch((err) => {
            console.error("회수 처리 중 에러 발생:", err);
            alert("회수 처리 중 DB 오류가 발생했습니다.");
        });        
    } else if (actionType === 'delete') {
        if (currentStatus.includes("승인")) {
            alert("승인된 문서는 변경 및 삭제가 불가능합니다.");
            return;
        }
        if (!currentStatus.includes("작성")) {
            alert("'작성' 상태의 문서만 삭제할 수 있습니다. 먼저 회수나 재작성 빌드업을 해주세요.");
            return;
        }
        if (!confirm("이 신청 내역을 완전히 삭제하시겠습니까? 복구할 수 없습니다.")) return;

        db.collection("overtime_requests").doc(docId).delete()
        .then(() => {
            alert("신청 내역이 완전히 삭제되었습니다.");
            viewMyRequests();
        })
        .catch((err) => {
            console.error("삭제 중 오류 발생:", err);
            alert("삭제 처리 중 오류가 발생했습니다.");
        });        
    } else if (actionType === 'rewrite') {
        if (currentStatus.includes("승인")) {
            alert("승인된 문서는 변경 및 삭제가 불가능합니다.");
            return;
        }      
        if (currentStatus.includes("반송") || currentStatus.includes("반려") || currentStatus.includes("작성")) {
            if (!confirm("선택한 내역을 신청서 작성 화면으로 불러오시겠습니까?")) return;

            db.collection("overtime_requests").doc(docId).get()
                .then((doc) => {
                    if (!doc.exists) {
                        alert("데이터를 찾을 수 없습니다.");
                        return;
                    }
                    const data = doc.data();
                    if (typeof loadTempRequest === 'function') {
                        loadTempRequest(data); // 폼에 바인딩
                    } else {
                        alert("데이터 바인딩 함수(loadTempRequest)가 정의되어 있지 않습니다.");
                        return;
                    }

                    // ★ [수정 핵심] 앞의 'let' 키워드를 완전히 제거하여 전역 변수값만 변경시킵니다!
                    originDocIdForRewrite = docId;
                    currentTempDocId = null;
                    saveDraft();

                    const historyModal = document.getElementById('history-modal');
                    if (historyModal) historyModal.style.display = 'none';
                    alert("내역을 메인 화면으로 불러왔습니다. 수정 후 [제출]을 누르면 '재전송' 상태로 업데이트됩니다.");
                })
                .catch(err => {
                    console.error("재작성 데이터 로드 실패:", err);
                    alert("데이터를 불러오는 도중 오류가 발생했습니다.");
                });
        } else {
            alert("대기 중인 문서는 회수 후 재작성이 가능합니다.");
        }
    }
}

// ==========================================
// 9. DOM 로드 완료 시 초기 화면 바인딩 (수정본)
// ==========================================
window.addEventListener('DOMContentLoaded', () => {
    const mainSystem = document.getElementById('main-system');
    if (mainSystem) {
        mainSystem.style.display = 'block'; 
    }
    
    // 안전장치: initDatePickerLimits 함수가 존재할 때만 실행해 흐름이 막히는 것을 방지
    if (typeof initDatePickerLimits === 'function') {
        try {
            initDatePickerLimits();
        } catch (e) {
            console.error("initDatePickerLimits 실행 오류:", e);
        }
    } else {
        console.warn("initDatePickerLimits 함수가 정의되어 있지 않습니다.");
    }
});

// ==========================================
// 10. 제출내역조회 목록에서 선택한 항목 바로 인쇄하기
// ==========================================
function printSelectedHistory() {
    let tr = document.querySelector('#history-tbody tr.selected');
    if (!tr) {
        const checkedBox = document.querySelector('#history-tbody .submit-row-check:checked');
        if (checkedBox) tr = checkedBox.closest('tr');
    }
    
    if (!tr) {
        alert("인쇄할 항목(행)을 먼저 클릭하거나 체크박스를 선택해주세요.");
        return;
    }

    const targetCheck = tr.querySelector('.submit-row-check');
    if (!targetCheck) {
        alert("문서 정보를 찾을 수 없습니다.");
        return;
    }
    
    const docId = targetCheck.dataset.docId;

    db.collection("overtime_requests").doc(docId).get()
        .then((doc) => {
            if (!doc.exists) {
                alert("해당 문서 데이터를 찾을 수 없습니다.");
                return;
            }
            printOvertimeSheet(doc.data());
        })
        .catch(err => {
            console.error("인쇄 데이터 로드 실패:", err);
            alert("인쇄 데이터를 불러오는 중 오류가 발생했습니다.");
        });
}

// 미리보기 없이 바로 인쇄창 열기 (연차 휴가신청서와 같은 방식, 로고 이미지가 다 불러와진 뒤 인쇄)
const OT_COMPANY_NAME = "(주)한신콘설탄트";
const OT_COMPANY_LOGO = "/images/hanshin-logo.png";

function printOvertimeSheet(data) {
    const body = document.getElementById('ot-print-body');
    if (!body) return;
    body.innerHTML = renderOvertimeSheetHtml(data);

    const images = Array.from(body.querySelectorAll('img'));
    Promise.all(images.map(img => img.complete ? Promise.resolve()
        : new Promise(resolve => { img.onload = img.onerror = resolve; })))
        .then(() => window.print());
}

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
                <div class="ot-meta">문서번호　-<br>작성일자　${submittedText}</div>
            </div>
            <div class="ot-title">연장근로 신청 확인서</div>

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