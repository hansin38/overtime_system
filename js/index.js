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

// 탭 전환 로직 (CSS .tab-btn.active 클래스와 완벽 연동)
function switchLoginTab(type) {
    const userBox = document.getElementById('login-section-user');
    const adminBox = document.getElementById('login-section-admin');
    const btnUser = document.getElementById('tab-user');
    const btnAdmin = document.getElementById('tab-admin');
    
    if (type === 'user') {
        userBox.style.display = ''; 
        adminBox.style.display = 'none';
        btnUser.classList.add('active'); 
        btnAdmin.classList.remove('active');
    } else {
        userBox.style.display = 'none'; 
        adminBox.style.display = '';
        btnUser.classList.remove('active'); 
        btnAdmin.classList.add('active');
    }
}

// 관리자 로그인
function handleAdminLogin() {
    const name = document.getElementById('admin-name').value.trim();
    const pw = document.getElementById('admin-pw').value.trim();
    
    // admin.js의 계정 정보와 완벽하게 일치
    if (name === "김은지" && pw === "1234") { 
        sessionStorage.setItem('boss_authenticated', 'true');
        location.href = 'admin.html'; 
    } else {
        alert("관리자 정보가 일치하지 않습니다.");
    }
}

// 사원 로그인 (예외 처리 및 유연성 보강 완료!)
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
            
            location.href = 'employee.html';
        })
        .catch(err => {
            console.error("로그인 조회 실패 원인 상세:", err);
            alert("로그인 중 오류가 발생했습니다.");
        });
}