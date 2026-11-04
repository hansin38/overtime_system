// ==========================================
// index.js (로그인 전용)
// ==========================================

// Firebase 초기화 (로그인 화면에서도 DB 조회가 필요하므로 필수!)
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

// -----------------------------------------------------------------
// 화면 흐름: 로그인 → 메뉴(연장근무일지 / 연차신청) 선택
// 이미 로그인한 상태(같은 탭)면 바로 메뉴 화면을 보여줌
// -----------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    let savedUser = null;
    try { savedUser = JSON.parse(sessionStorage.getItem('currentUser')); } catch (e) {}
    if (savedUser && savedUser.name && savedUser.phone) {
        showPortalMenu(savedUser.name);
    } else {
        document.getElementById('login-container').style.display = 'block';
    }
});

function showPortalMenu(name) {
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('portal-user-name').innerText = name;
    document.getElementById('portal-main-screen').style.display = 'block';
}

function selectSystem(mode) {
    location.href = (mode === 'leave') ? 'leave/leave-apply.html' : 'employee.html';
}

function logoutUser() {
    sessionStorage.removeItem('currentUser');
    document.getElementById('login-name').value = '';
    document.getElementById('login-phone').value = '';
    document.getElementById('portal-main-screen').style.display = 'none';
    document.getElementById('login-container').style.display = 'block';
}
// -----------------------------------------------------------------


// 관리자 로그인은 메인 화면에 노출하지 않고 admin.html에서 별도 진행


// 사원 로그인 (기존 오리지널 DB 조회 로직 토씨 하나 안 틀리고 그대로!)
function handleLogin() {
    const nameInput = document.getElementById('login-name').value.trim();
    let phoneInput = document.getElementById('login-phone').value.trim();    

    if(!nameInput || !phoneInput) { 
        alert("이름과 휴대폰 번호를 모두 입력해주세요."); 
        return; 
    }

    // 숫자만 추출한 뒤 무조건 마지막 4자리만 가져와서 비교
    phoneInput = phoneInput.replace(/[^0-9]/g, ''); 
    if (phoneInput.length >= 4) {
        phoneInput = phoneInput.slice(-4); 
    } else {
        alert("비밀번호는 휴대폰 뒷자리 4자리를 정확히 입력해주세요.");
        return;
    }

    // 'employees' 컬렉션 조회 진행
    db.collection("employees")
        .where("name", "==", nameInput)
        .where("phoneLast4", "==", phoneInput)
        .get()
        .then((snapshot) => {
            if (snapshot.empty) {
                alert("등록되지 않은 사원이거나 정보가 일치하지 않습니다. 관리자에게 사원 등록 여부를 문의해 주세요.");
                return;
            }
            
            // 💡 [원복 완료] 기존 employee.js가 읽어갈 수 있도록 오리지널 키와 JSON 포맷으로 저장합니다!
            const currentUser = { name: nameInput, phone: phoneInput };
            sessionStorage.setItem('currentUser', JSON.stringify(currentUser));
            // 로그인 후 메뉴 화면에서 연장근무일지 / 연차신청 선택
            showPortalMenu(nameInput);
        })
        .catch(err => {
            console.error("로그인 조회 실패 원인 상세:", err);
            alert("로그인 중 오류가 발생했습니다.");
        });
}