// ==========================================
// 명세서 메일 발송 (Vercel 서버 함수) - POST /api/send-payslip
// 1) 관리자 Firebase 로그인 토큰 확인 (ADMIN_EMAILS에 있는 계정만)
// 2) 화면에서 캡처한 명세서 이미지를 생년월일 6자리로 잠긴 PDF(AES-256)로 변환
// 3) 네이버 메일(NAVER_USER가 있으면) 또는 Gmail로 직원에게 발송
//
// Vercel 환경변수 (Project Settings > Environment Variables):
//   NAVER_USER          (우선) 보내는 네이버 주소, 예: themore77@naver.com
//   NAVER_PASSWORD      네이버 비밀번호 (2단계 인증을 쓰면 '애플리케이션 비밀번호')
//                       네이버 메일 > 환경설정 > POP3/IMAP 설정 > 'POP3/SMTP 사용' 켜기 필요
//   GMAIL_USER          (NAVER_USER가 없을 때) 보내는 Gmail 주소
//   GMAIL_APP_PASSWORD  Gmail 앱 비밀번호 16자리 (Google 계정 > 보안 > 2단계 인증 > 앱 비밀번호)
//   ADMIN_EMAILS        관리자 로그인 이메일 (여러 개면 쉼표로 구분)
//   MAIL_FROM_NAME      (선택) 보내는 사람 이름, 예: 한신콘설탄트 관리부
//   MAIL_REPLY_TO       (선택) 직원이 [답장]을 누르면 받을 주소. 없으면 보내는 주소로 감
// ==========================================
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

// Firebase 웹 API 키 (브라우저 코드에도 공개된 값 - 토큰 확인용)
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyCpMIytCpZ5F5JRoKABJE7kkgv_RZReFRc';

async function verifyAdmin(req) {
    const header = req.headers.authorization || '';
    const idToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!idToken) return null;
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const email = data.users && data.users[0] && data.users[0].email;
    const admins = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return email && admins.includes(email.toLowerCase()) ? email : null;
}

function buildLockedPdf(imageBuffer, password) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4',
            margin: 0,
            pdfVersion: '1.7ext3',            // AES-256 암호화
            userPassword: password,
            ownerPassword: crypto.randomBytes(16).toString('hex'),
            permissions: { printing: 'highResolution' }
        });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        const margin = 20;
        doc.image(imageBuffer, margin, margin, {
            fit: [doc.page.width - margin * 2, doc.page.height - margin * 2],
            align: 'center',
            valign: 'center'   // 위아래 여백 같게
        });
        doc.end();
    });
}

// 보내는 메일 계정: 네이버 설정이 있으면 네이버, 없으면 Gmail
function mailAccount() {
    const nUser = (process.env.NAVER_USER || '').trim(), nPass = process.env.NAVER_PASSWORD;
    if (nUser && nPass) {
        return { user: nUser, transport: { host: 'smtp.naver.com', port: 465, secure: true, auth: { user: nUser, pass: nPass } } };
    }
    const gUser = (process.env.GMAIL_USER || '').trim(), gPass = process.env.GMAIL_APP_PASSWORD;
    if (gUser && gPass) return { user: gUser, transport: { service: 'gmail', auth: { user: gUser, pass: gPass } } };
    return null;
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: '허용되지 않는 요청입니다.' });
    try {
        const mail = mailAccount();
        if (!mail) {
            return res.status(500).json({ ok: false, error: '메일 발송 설정(NAVER_USER·NAVER_PASSWORD 또는 GMAIL_USER·GMAIL_APP_PASSWORD)이 없습니다.' });
        }
        const admin = await verifyAdmin(req);
        if (!admin) return res.status(401).json({ ok: false, error: '관리자 인증에 실패했습니다. 다시 로그인해 주세요.' });

        const { to, subject, text, filename, password, image } = req.body || {};
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to || '')) return res.status(400).json({ ok: false, error: '받는 사람 이메일이 올바르지 않습니다.' });
        if (!/^\d{6}$/.test(password || '')) return res.status(400).json({ ok: false, error: 'PDF 비밀번호(생년월일 6자리)가 올바르지 않습니다.' });
        const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(image || '');
        if (!match) return res.status(400).json({ ok: false, error: '명세서 이미지가 없습니다.' });

        const pdf = await buildLockedPdf(Buffer.from(match[2], 'base64'), password);

        const transporter = nodemailer.createTransport(mail.transport);
        const fromName = process.env.MAIL_FROM_NAME || '급여 담당자';
        await transporter.sendMail({
            from: `"${fromName}" <${mail.user}>`,   // 네이버·Gmail 모두 로그인한 주소로만 보낼 수 있음
            ...(process.env.MAIL_REPLY_TO ? { replyTo: process.env.MAIL_REPLY_TO.trim() } : {}),
            to,
            subject: String(subject || '임금명세서').slice(0, 200),
            text: String(text || ''),
            attachments: [{ filename: String(filename || 'payslip.pdf').replace(/[\\/:*?"<>|]/g, '_'), content: pdf, contentType: 'application/pdf' }]
        });
        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error('send-payslip error:', err);
        return res.status(500).json({ ok: false, error: '메일 발송 중 오류가 발생했습니다: ' + (err.message || err) });
    }
};
