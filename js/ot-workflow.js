/**
 * ot-workflow.js
 * 연장근로 신청 결재 워크플로우 관리 (임시저장, 회수, 삭제, 재작성, 재전송)
 */

// 전역 변수 선언 보완 (재작성 시 원본 문서 ID를 기억하기 위함)
let originDocIdForRewrite = "";

// ==========================================
// 1. 임시저장 관련 함수 그룹 (기존 기능 이전 및 최적화)
// ==========================================

// 임시저장 목록에서 [불러오기] 버튼 클릭 시
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
                // employee.js에 있는 매핑 함수 호출
                loadTempRequest(doc.data());
                originDocIdForRewrite = null; // 임시저장은 재작성 원본 ID 초기화
                modal.style.display = 'none'; // CSS 연동에 맞추어 모달 닫기
            } else {
                alert("해당 데이터를 찾을 수 없습니다.");
            }
        })
        .catch(err => {
            console.error("데이터 불러오기 실패:", err);
        });
}

// 임시저장 내역 [선택 삭제] (모달 공유 구조에 맞게 안전 보완)
function deleteCheckedTempRequests() {
    // 1. 현재 열려있는 모달이 임시저장 내역 모달인지 제목으로 명확히 체크!
    const modalTitle = document.querySelector('#history-modal h3');
    if (!modalTitle || modalTitle.innerText !== "나의 임시저장 내역") {
        return; // 임시저장 모달이 아니면 오작동 방지를 위해 실행 안 함
    }

    // 2. <tr> 안에 그려진 체크박스들 중 체크된 것만 수집
    const checkedBoxes = document.querySelectorAll('#history-tbody input[type="checkbox"]:checked');
    
    // 만약 마스터 체크박스(헤더)까지 같이 잡혔다면 순수 데이터 행 체크박스만 필터링
    const dataRowCheckedBoxes = Array.from(checkedBoxes).filter(cb => cb.id !== 'modal-master-check');

    if (dataRowCheckedBoxes.length === 0) {
        alert("삭제할 임시저장 내역을 선택해주세요.");
        return;
    }
    
    if (!confirm("선택한 임시저장 내역을 정말 삭제하시겠습니까?")) return;
    
    let deletePromises = [];
    dataRowCheckedBoxes.forEach(cb => {
        // tr을 그릴 때 넣어둔 고유 문서 ID 추출
        const docId = cb.dataset.docId;
        if (docId) {
            deletePromises.push(db.collection("temp_requests").doc(docId).delete());
        }
    });
    
    Promise.all(deletePromises)
        .then(() => {
            alert("임시저장 내역이 정상적으로 삭제되었습니다.");
            
            // 헤더 마스터 체크박스가 켜져 있었다면 다시 꺼주기
            const modalMaster = document.getElementById('modal-master-check');
            if (modalMaster) modalMaster.checked = false;

            viewTempRequests(); // 리스트 갱신해서 화면 새로고침 효과
        })
        .catch(err => {
            console.error("임시저장 삭제 오류:", err);
            alert("삭제 중 오류가 발생했습니다.");
        });
}


// ==========================================
// 2. 제출내역 워크플로우 함수 그룹 (신규 구현 기능)
// ==========================================

/**
 * [회수 기능] 
 * 상태가 '대기'일 때만 '작성' 상태로 변경
 */
function withdrawRequest(docId) {
    const docRef = db.collection("overtime_requests").doc(docId);

    docRef.get().then((doc) => {
        if (!doc.exists) {
            alert("존재하지 않는 문서입니다.");
            return;
        }

        const currentStatus = doc.data().status;
        if (currentStatus === "승인") {
            alert("이미 처리가 완료(승인)되어 회수할 수 없습니다.");
            return;
        }
        if (currentStatus !== "대기" && currentStatus !== "재전송") {
            alert("대기 상태인 문서만 회수할 수 있습니다.");
            return;
        }

        // 상태를 '작성'으로 업데이트
        return docRef.update({
            status: "작성",
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    })
    .then(() => {
        alert("성공적으로 회수되었습니다. '작성' 상태로 변경됩니다.");
        viewMyRequests(); // 내역 모달창 새로고침
    })
    .catch((err) => {
        console.error("회수 중 오류 발생:", err);
        alert("회수 처리 중 오류가 발생했습니다.");
    });
}

/**
 * [삭제 기능]
 * 상태가 '작성'일 때만 파이어베이스에서 완전 삭제
 */
function deleteRequest(docId) {
    if (!confirm("이 신청 내역을 완전히 삭제하시겠습니까? 복구할 수 없습니다.")) return;

    const docRef = db.collection("overtime_requests").doc(docId);

    docRef.get().then((doc) => {
        if (!doc.exists) {
            alert("존재하지 않는 문서입니다.");
            return;
        }

        const currentStatus = doc.data().status;
        if (currentStatus !== "작성") {
            alert("'작성' 상태의 문서만 삭제할 수 있습니다. 먼저 회수해 주세요.");
            return;
        }

        return docRef.delete();
    })
    .then(() => {
        alert("신청 내역이 완전히 삭제되었습니다.");
        viewMyRequests(); // 내역 모달창 새로고침
    })
    .catch((err) => {
        console.error("삭제 중 오류 발생:", err);
        alert("삭제 처리 중 오류가 발생했습니다.");
    });
}

/**
 * [재작성 기능]
 * 상태가 '반송'일 때 데이터를 메인 폼으로 복사 로드
 */
function rewriteReturnedRequest(docId) {
    db.collection("overtime_requests").doc(docId).get()
        .then((doc) => {
            if (!doc.exists) {
                alert("데이터를 찾을 수 없습니다.");
                return;
            }

            const data = doc.data();
            if (data.status !== "반송" && data.status !== "반려") {
                alert("'반송' 상태의 문서만 재작성할 수 있습니다.");
                return;
            }

            // 1. 데이터를 현재 메인 입력 폼에 바인딩
            loadTempRequest(data);

            // 2. 중요! 이 문서가 반송되어 다시 쓰는 원본 문서임을 기억하기 위해 ID 저장
            originDocIdForRewrite = docId;

            // 3. 내역 모달창 닫기 (CSS 연동 규격 준수)
            document.getElementById('history-modal').style.display = 'none';
            
            alert("반송된 내역을 불러왔습니다. 수정 후 다시 [제출하기]를 누르면 '재전송' 상태로 제출됩니다.");
        })
        .catch(err => {
            console.error("재작성 불러오기 오류:", err);
        });
}