// ==========================================
// leave-sign.js (결재자 서명 화면 - 사원이 보낸 링크로 접속, 로그인 없음)
// 주소: /s/짧은코드 (Vercel rewrite) 또는 leave-sign.html?c=짧은코드 (내 컴퓨터 미리보기)
//       코드(signLink.token)로 신청서를 찾음 - 링크는 신청서당 1개
// - 토큰이 일치하고 만료 전(SIGN_LINK_HOURS)일 때만 서명 가능
// - 받은 사람이 비어 있는 결재칸(과장/전무)을 골라 서명 → 즉시 승인, 이후 수정·삭제 불가
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
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

const params = new URLSearchParams(location.search);
const shortPath = location.pathname.match(/\/s\/([A-Za-z0-9]+)/);
const signToken = shortPath ? shortPath[1] : (params.get('c') || params.get('t')); // t: 예전 긴 링크
let signDocId = null;
let signRequestData = null;
let selectedSignSlot = null;
let signPadDrawn = false;

window.addEventListener('DOMContentLoaded', loadSignRequest);

function setBanner(html, type) {
    const banner = document.getElementById('sign-banner');
    banner.className = `sign-banner sign-banner-${type}`;
    banner.innerHTML = html;
}

function slotLabel(slot) {
    return SIGN_SLOTS[slot].replace(' ', '');
}
function unsignedSlots(data) {
    return Object.keys(SIGN_SLOTS).filter(slot => !(data.signatures && data.signatures[slot]));
}

// 링크 상태 확인: 서명 가능하면 null, 아니면 안내 문구
function getLinkProblem(data) {
    if (!ACTIVE_STATUSES.includes(data.status)) return "회수되었거나 반려된 신청서입니다. 서명할 수 없습니다.";
    const link = data.signLink;
    if (!link || link.token !== signToken) return "유효하지 않은 링크입니다. 신청자에게 링크를 다시 요청해 주세요.";
    if (Date.now() > link.expiresAt) return `링크가 만료되었습니다 (유효시간 ${SIGN_LINK_HOURS}시간). 신청자에게 링크를 다시 요청해 주세요.`;
    return null;
}

function loadSignRequest() {
    if (!signToken) {
        setBanner("잘못된 링크입니다. 신청자에게 링크를 다시 요청해 주세요.", "error");
        return;
    }

    db.collection("leave_requests").where("signLink.token", "==", signToken).limit(1).get()
        .then(snap => {
            if (snap.empty) throw new Error("NOT_FOUND");
            signDocId = snap.docs[0].id;
            signRequestData = snap.docs[0].data();
            // 월별 누적표를 위해 같은 신청자의 다른 신청서도 조회
            return db.collection("leave_requests")
                .where("employeeName", "==", signRequestData.employeeName)
                .where("employeePhone", "==", signRequestData.employeePhone)
                .get();
        })
        .then(snap => {
            const requests = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            renderSignPage(requests);
        })
        .catch(err => {
            console.error("신청서 조회 실패:", err);
            setBanner(err.message === "NOT_FOUND"
                ? "유효하지 않은 링크입니다. 새 링크가 발송되었거나 신청서가 삭제되었을 수 있습니다. 신청자에게 링크를 다시 요청해 주세요."
                : "신청서를 불러오는 중 오류가 발생했습니다.", "error");
        });
}

function renderSignPage(requests) {
    const data = signRequestData;
    const remaining = unsignedSlots(data);
    const problem = getLinkProblem(data);
    const canSign = remaining.length > 0 && !problem;

    document.getElementById('sign-sheet').innerHTML = renderLeaveSheetHtml(data, requests, { signable: canSign });
    document.getElementById('sign-bottom-bar').style.display = canSign ? 'block' : 'none';

    if (remaining.length === 0) {
        setBanner(`✅ 결재(과장·전무) 서명이 모두 완료된 신청서입니다. (수정할 수 없습니다)`, "done");
    } else if (problem) {
        const done = Object.keys(SIGN_SLOTS).length > remaining.length ? `<br><small>✅ 이미 승인된 신청서입니다.</small>` : '';
        setBanner(`⚠️ ${problem}${done}`, "error");
    } else {
        const until = new Date(data.signLink.expiresAt);
        const doneNote = Object.keys(SIGN_SLOTS).length > remaining.length
            ? `<br><small>✅ ${Object.keys(SIGN_SLOTS).filter(s => !remaining.includes(s)).map(slotLabel).join('·')} 서명 완료 (승인됨) - 추가 서명도 가능합니다.</small>` : '';
        setBanner(`<b>${data.employeeName}</b> 님의 휴가신청서입니다.<br>
            오른쪽 위 <b>결재란의 빨간 칸</b>(본인 직위)을 누르거나 아래 <b>[✍ 서명하기]</b> 버튼을 눌러 서명해 주세요.${doneNote}<br>
            <small>링크 유효시간: ${until.getMonth() + 1}/${until.getDate()} ${pad2(until.getHours())}:${pad2(until.getMinutes())}까지</small>`, "action");
    }
}

// -----------------------------------------------------------------
// ✍️ 서명 패드 (마우스·터치 공용)
// -----------------------------------------------------------------
function openSignPad(slot) {
    if (!signRequestData || getLinkProblem(signRequestData)) {
        alert("링크가 만료되었거나 서명할 수 없는 상태입니다. 신청자에게 링크를 다시 요청해 주세요.");
        return;
    }
    const remaining = unsignedSlots(signRequestData);
    if (remaining.length === 0) { alert("이미 서명이 모두 완료되었습니다."); return; }

    // 서명할 칸 선택 버튼 (결재칸을 눌렀으면 그 칸, 하단 버튼이면 직접 선택)
    const box = document.getElementById('sign-slot-choice');
    box.innerHTML = remaining.map(s => `<button type="button" class="sign-slot-btn" data-slot="${s}" onclick="selectSignSlot('${s}')">${slotLabel(s)}</button>`).join('');
    selectSignSlot(slot && remaining.includes(slot) ? slot : (remaining.length === 1 ? remaining[0] : null));

    document.getElementById('sign-pad-modal').style.display = 'block';
    setupSignCanvas();
}

function selectSignSlot(slot) {
    selectedSignSlot = slot;
    document.querySelectorAll('.sign-slot-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.slot === slot));
    document.getElementById('sign-pad-title').innerText = slot ? `${slotLabel(slot)} 서명` : '서명할 결재칸을 선택하세요';
}

function closeSignPad() {
    document.getElementById('sign-pad-modal').style.display = 'none';
}

function setupSignCanvas() {
    const canvas = document.getElementById('sign-canvas');
    // 화면 크기에 맞춰 실제 픽셀 크기 설정 (흐림 방지)
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    signPadDrawn = false;

    if (canvas.dataset.bound) return;
    canvas.dataset.bound = 'true';
    let drawing = false;
    const point = (e) => {
        const r = canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
        drawing = true;
        canvas.setPointerCapture(e.pointerId);
        const p = point(e);
        const c = canvas.getContext('2d');
        c.beginPath();
        c.moveTo(p.x, p.y);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = point(e);
        const c = canvas.getContext('2d');
        c.lineTo(p.x, p.y);
        c.stroke();
        signPadDrawn = true;
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
}

function clearSignPad() {
    const canvas = document.getElementById('sign-canvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    signPadDrawn = false;
}

// 서명 저장: 저장 직전에 링크·결재칸을 다시 확인하고 승인 처리
function confirmSignature() {
    const slot = selectedSignSlot;
    if (!slot) { alert("서명할 결재칸(과장/전무)을 선택해 주세요."); return; }
    if (!signPadDrawn) { alert("서명을 입력해 주세요."); return; }
    if (!confirm(`[${slotLabel(slot)}] 칸에 서명합니다.\n서명 후에는 수정하거나 취소할 수 없습니다.\n서명하시겠습니까?`)) return;

    const img = document.getElementById('sign-canvas').toDataURL('image/png');
    const ref = db.collection("leave_requests").doc(signDocId);

    db.runTransaction(tx => tx.get(ref).then(doc => {
        if (!doc.exists) throw new Error("신청서를 찾을 수 없습니다.");
        const data = doc.data();
        if (data.signatures && data.signatures[slot]) throw new Error(`이미 ${slotLabel(slot)} 서명이 완료된 칸입니다.`);
        const problem = getLinkProblem(data);
        if (problem) throw new Error(problem);
        tx.update(ref, {
            [`signatures.${slot}`]: { img, signedAt: firebase.firestore.FieldValue.serverTimestamp() },
            status: "승인",
            approvedAt: data.approvedAt || firebase.firestore.FieldValue.serverTimestamp()
        });
    }))
    .then(() => {
        closeSignPad();
        alert("서명이 완료되었습니다. 감사합니다.");
        loadSignRequest();
    })
    .catch(err => {
        console.error("서명 저장 실패:", err);
        alert(err.message || "서명 저장 중 오류가 발생했습니다.");
        closeSignPad();
        loadSignRequest();
    });
}
