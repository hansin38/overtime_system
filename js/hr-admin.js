// ==========================================
// 🎓 인사 · 자격 - 직원정보 관리 · 직원경력 관리 (관리자 조회 전용, hr-admin.js)
// - 데이터: 직원명단.xlsx 를 올리면 그 내용으로 통째로 바뀜 (화면에서 하나씩 등록·수정하지 않음)
//     「1기본정보」 → 직원정보 (성명 · 직급 · 부서 · 생년월일 · 전화 · 입사일 · 주소 · 이메일)
//     「2경력,학력」 → 직원경력 (구분 · 분야 · 자격등급 · 회사등록 · 자격증 · 발급번호 · 합격일 · 학력)
// - 🔒 주민번호는 저장하지 않고 생년월일만 뽑음 (개인정보보호법 제24조의2 - 주민번호는 암호화 보관 의무)
// - 저장: hr_staff 컬렉션 (문서 하나 = 한 사람, firestore.rules 의 hr_ 규칙 → 관리자만)
// - 날짜·글자 도우미(asYmd · asText · birthFromRrn · asToday)는 js/assoc-admin.js 것을 같이 씀
// ==========================================

const HR = { people: [], loaded: false, q: { info: '', career: '' }, importRows: [] };

function openHrTab(kind) {
    const tbody = document.getElementById(`hr-${kind}-tbody`);
    if (HR.loaded) { renderHr(kind); return; }
    tbody.innerHTML = `<tr><td colspan="12" style="color: #888;">불러오는 중...</td></tr>`;
    db.collection('hr_staff').get().then(snap => {
        HR.people = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        HR.loaded = true;
        renderHr(kind);
    }).catch(err => {
        console.error('직원정보 불러오기 실패:', err);
        tbody.innerHTML = `<tr><td colspan="12" style="color: var(--danger-color);">직원정보를 불러오지 못했어요.${err && err.code === 'permission-denied' ? '<br><small>Firebase 콘솔 > Firestore > 규칙에 hr_ 규칙(관리자만)을 게시했는지 확인해 주세요.</small>' : ''}</td></tr>`;
    });
}

function setHrSearch(kind, value) { HR.q[kind] = value; renderHr(kind); }

// 입사일 → 근속 'N년 M개월'
function hrTenure(ymd) {
    if (!ymd) return '';
    const a = parseYmd(ymd), b = parseYmd(asToday());
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
    if (months < 0) return '';
    return `${Math.floor(months / 12)}년 ${months % 12}개월`;
}

function renderHr(kind) {
    const tbody = document.getElementById(`hr-${kind}-tbody`);
    if (!tbody) return;
    const q = (HR.q[kind] || '').trim();
    const list = HR.people
        .filter(p => kind === 'info' ? p.info : p.career)
        .filter(p => !q || [p.name, p.department, p.position].some(v => String(v || '').includes(q)))
        .sort((a, b) => (a.no || 999) - (b.no || 999) || (a.name || '').localeCompare(b.name || '', 'ko'));
    document.getElementById(`hr-${kind}-count`).innerText = `${list.length}명`;
    const v = (x) => esc(x || '') || '<span class="sub">-</span>';
    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="14" style="color: #888;">${HR.people.length ? '찾는 사람이 없어요' : '아직 데이터가 없어요. [📤 직원명단 엑셀 올리기]로 넣어 주세요.'}</td></tr>`;
        return;
    }
    if (kind === 'info') {
        tbody.innerHTML = list.map(p => { const i = p.info; return `<tr>
            <td><b>${esc(p.name)}</b></td><td>${v(i.position)}</td><td>${v(i.department)}</td>
            <td>${v(i.birth)}</td><td>${v(i.phone)}</td>
            <td>${v(i.hireDate)}${i.hireDate ? `<small>${hrTenure(i.hireDate)}</small>` : ''}</td>
            <td class="l">${v(i.email)}</td><td class="l hr-addr">${v(i.address)}</td></tr>`; }).join('');
    } else {
        tbody.innerHTML = list.map(p => { const c = p.career; return `<tr>
            <td><b>${esc(p.name)}</b></td><td>${v(c.department)}<small>${esc(c.position || '')}</small></td>
            <td>${v(c.group)}</td><td>${v(c.field)}</td><td>${v(c.grade)}</td>
            <td>${c.companyReg === true ? '<span class="staff-chip ok">Y</span>' : c.companyReg === false ? '<span class="staff-chip gray">N</span>' : '<span class="sub">-</span>'}</td>
            <td class="l">${v(c.license)}${c.licenseNo ? `<small>${esc(c.licenseNo)}</small>` : ''}</td><td>${v(c.licenseDate)}</td>
            <td>${v(c.school)}<small>${esc([c.degree, c.major].filter(Boolean).join(' · '))}</small></td><td>${v(c.gradYear)}</td></tr>`; }).join('');
    }
}

// ------------------------------------------
// 📤 직원명단.xlsx 올리기 (1기본정보 + 2경력,학력 → 통째로 바꿈)
// ------------------------------------------
function parseHrWorkbook(wb) {
    const sheet = (n) => wb.Sheets[n] ? XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) : null;
    const base = sheet('1기본정보'), career = sheet('2경력,학력');
    if (!base && !career) throw new Error("'1기본정보'·'2경력,학력' 시트를 찾지 못했어요. 직원명단 파일이 맞는지 확인해 주세요.");
    const byName = {};
    const person = (name) => (byName[name] = byName[name] || { name });
    const rowsOf = (rows) => (rows || []).slice(3).filter(r => asText(r[1]) && !/^성명$/.test(asText(r[1])));
    const dash = (x) => (asText(x) === '-' ? '' : asText(x));
    // 1기본정보: 번호(0) 성명(1) 직급(2) 부서(3) 주민번호(4 → 생년월일만) 전화(5) 입사일자(6) 주소(7) 이메일(8)
    rowsOf(base).forEach(r => {
        const p = person(asText(r[1]));
        p.no = Number(r[0]) || null;
        p.info = { position: dash(r[2]), department: dash(r[3]), birth: birthFromRrn(r[4]), phone: asText(r[5]), hireDate: asYmd(r[6]), address: asText(r[7]), email: asText(r[8]) };
    });
    // 2경력,학력: 성명(1) 직급(2) 부서(3) 구분(5) 분야(6) 자격등급(7) 회사등록(8) 자격증(10) 발급번호(11) 합격일(12) 최종학력(14) 학위명(15) 학과(16) 졸업년도(17)
    rowsOf(career).forEach(r => {
        const p = person(asText(r[1]));
        const reg = asText(r[8]);
        p.career = {
            position: dash(r[2]), department: dash(r[3]), group: asText(r[5]), field: asText(r[6]), grade: asText(r[7]),
            companyReg: /^y/i.test(reg) ? true : /^n/i.test(reg) ? false : null,
            license: asText(r[10]), licenseNo: asText(r[11]), licenseDate: asYmd(r[12]) || asText(r[12]),
            school: asText(r[14]), degree: asText(r[15]), major: asText(r[16]), gradYear: asText(r[17]),
        };
    });
    return Object.values(byName).map(p => ({ ...p, info: p.info || null, career: p.career || null }));
}

function openHrImport() {
    HR.importRows = [];
    document.getElementById('hr-imp-file').value = '';
    document.getElementById('hr-imp-result').innerHTML = '';
    document.getElementById('hr-imp-save').disabled = true;
    document.getElementById('hr-imp-modal').style.display = 'flex';
}
function closeHrImport() { document.getElementById('hr-imp-modal').style.display = 'none'; }

function onHrImportFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        try {
            HR.importRows = parseHrWorkbook(XLSX.read(new Uint8Array(reader.result), { type: 'array' }));
            const nInfo = HR.importRows.filter(p => p.info).length, nCareer = HR.importRows.filter(p => p.career).length;
            document.getElementById('hr-imp-result').innerHTML = `
                <div class="lvimp-sum"><span>읽은 사람 <b>${HR.importRows.length}</b>명</span><span class="ok">직원정보 <b>${nInfo}</b>명</span><span class="ok">직원경력 <b>${nCareer}</b>명</span></div>
                <div class="pay-note" style="margin-top: 10px;">⚠️ 저장하면 지금 사이트의 직원정보·직원경력이 <b>이 엑셀 내용으로 통째로 바뀌어요</b>.<br>
                🔒 주민번호는 저장하지 않고 생년월일만 뽑았어요.</div>`;
            const btn = document.getElementById('hr-imp-save');
            btn.disabled = !HR.importRows.length;
            btn.innerText = `${HR.importRows.length}명 저장`;
        } catch (e) {
            console.error(e);
            alert(e.message || '엑셀을 읽지 못했어요.');
        }
    };
    reader.readAsArrayBuffer(file);
}

function saveHrImport() {
    if (!HR.importRows.length || !confirm(`직원정보·직원경력을 이 엑셀 내용(${HR.importRows.length}명)으로 바꿀까요?`)) return;
    const used = {};
    const docs = HR.importRows.map(p => {
        let id = p.name.replace(/[\/.#$\[\]]/g, '_');
        used[id] = (used[id] || 0) + 1;
        if (used[id] > 1) id += `_${used[id]}`;   // 같은 이름이 두 명이면 _2
        return { id, data: { ...p, updatedAt: firebase.firestore.FieldValue.serverTimestamp() } };
    });
    const keep = new Set(docs.map(d => d.id));
    const batch = db.batch();
    HR.people.filter(p => !keep.has(p.id)).forEach(p => batch.delete(db.collection('hr_staff').doc(p.id)));   // 엑셀에서 빠진 사람은 지움
    docs.forEach(d => batch.set(db.collection('hr_staff').doc(d.id), d.data));
    batch.commit().then(() => {
        alert('저장했어요.');
        closeHrImport();
        HR.loaded = false;
        const kind = document.getElementById('hrcareer-admin-section').style.display === 'block' ? 'career' : 'info';
        openHrTab(kind);
    }).catch(err => {
        console.error('직원정보 저장 실패:', err);
        alert(err && err.code === 'permission-denied' ? '권한이 없어 저장하지 못했어요.\nFirebase 콘솔 > Firestore > 규칙에 hr_ 규칙을 게시해 주세요.' : '저장 중 오류가 발생했어요.');
    });
}
