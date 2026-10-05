# Translation glossary and style

CxMissionZero's page is translated for partner teams in several languages. These translations are read by security and engineering professionals at work. They must be accurate, consistent and businesslike. Never use slang, jokes, wordplay or casual tone, even where the English is light-hearted.

The source wording is in `i18n/catalog.json`; each language is `public/i18n/<code>.json`.

## Rules for every language

- **Placeholders**
  - Keep every `{0}`, `{1}`… exactly once each. They stand for numbers.
  - You may move them to where the language needs them.
- **Markup**
  - Keep every HTML tag exactly as written, with the same attributes, for example `<b>`, `<code>`, `<a href="#/settings/ai">` or `<span class="hint">`.
  - Translate the words between the tags. You may reorder the tagged pieces.
  - Never translate what is inside `<code>`.
- **Fragments**
  - Some entries are part of a sentence: they start or end mid-sentence, or start with `—` or `·`.
  - Translate them as fragments and keep their leading and trailing punctuation and symbols (`—`, `·`, `→`, `…`, `:`).
- **Never translated**
  - CxMissionZero, Mission Zero, Checkmarx One, Checkmarx.
  - GitHub, GitLab, Azure DevOps, Bitbucket, Jira.
  - SAST, SCA, IaC, KICS, API Security, Container Security.
  - SMTP, HTTPS, HTTP, TLS, SLA, API, URL, PAT, IDE.
  - VS Code, JetBrains, Cursor, Kiro, Podman, Docker, `.env`, `.pfx`, file names and paths.
  - Keyboard keys (Ctrl K) and e-mail addresses.
  - Programming-language names.
  - The word **Beta** as a badge.
  - **AI** stays "AI" in every language.
- **Length:** menu items, tab names, buttons and column headings must stay as short as the English. Sentences may be longer where the language needs it.
- **Plurals:** "project(s)", "1 project / 2 projects" are written the way the language handles counts. Never leave "(s)".
- **Ellipsis:** a trailing `…` means "in progress" and stays.
- **Capitalisation:** follow the language's own rules. Spanish, Vietnamese, Malay and Indonesian use sentence case for labels, not English title case.

## Register for each language

| Code | Language | Register |
|---|---|---|
| `ja` | Japanese | です・ます for sentences; nouns (体言止め) for labels, buttons and headings. Full-width 。、：（）. No space between Japanese and numbers or Latin words, except inside product names ("AI トリアージ"). Katakana for established IT loanwords. |
| `zh-TW` | Traditional Chinese (Taiwan) | Taiwan usage, not Hong Kong or mainland. Taiwan IT terms (專案, 設定, 預設, 帳號, 資料, 檔案, 伺服器, 登入). Full-width ，。：（）. One half-width space between Chinese and Latin words or numbers. |
| `zh-CN` | Simplified Chinese | Mainland usage (项目, 设置, 默认, 账号, 数据, 文件, 服务器, 登录). Full-width ，。：（）. One half-width space between Chinese and Latin words or numbers. |
| `ko` | Korean | Statements end in -습니다/-ㅂ니다; instructions in -하세요; buttons and labels are short nouns or verbs (저장, 취소). One space between Korean and Latin words or numbers where natural. |
| `es` | Spanish | Neutral international Spanish for Latin America and Spain. Address the reader as *usted*, never *tú*; no *vosotros* or voseo. "Informe" (not "reporte"), "configuración", "correo electrónico". |
| `pt-BR` | Portuguese (Brazil) | Brazilian Portuguese, used by every Portuguese reader. Address the reader as *você* (or impersonally), never *tu*. Keep "AI" in the feature names (Triagem de AI, Correção de AI). "Credit" is *crédito*; "finding" is *achado*; "report" is *relatório*; "Settings" is *Configurações*; "tenant" stays *tenant*. Five stages as five distinct words: Detectar, Triagem, Remediar, Corrigir, Verificar. |
| `vi` | Vietnamese | Formal and polite; address the reader as "bạn". Full diacritics. |
| `th` | Thai | Formal written Thai. No ครับ/ค่ะ particles. Spaces only between phrases and sentences, not between words. |
| `ms` | Malay (Malaysia) | Standard Bahasa Melayu (Dewan Bahasa dan Pustaka); address the reader as "anda". Malaysian terms, not Indonesian ones: tetapan, kemas kini, projek, imbasan, muat turun, log masuk. |
| `id` | Indonesian | Standard Bahasa Indonesia (KBBI/PUEBI); address the reader as "Anda" (capitalised). Indonesian terms, not Malaysian ones: pengaturan, perbarui, proyek, pemindaian, unduh, masuk. |
| `de` | German | Formal register (address the reader as *Sie*, never *du*). Keep "AI" in the feature names (AI-Triage, AI-Behebung). "Credit"/"Credits" (not Kredit/Guthaben). Five stages as five distinct verbs: Erkennen, Triage, Beheben, Korrigieren, Verifizieren. |
| `fr` | French | Formal register (vouvoiement — *vous*, never *tu*). Keep "AI" in the feature names (Triage AI, Correction AI). Five stages as five distinct words: Détecter, Triage, Remédier, Corriger, Vérifier. French spacing before : ; ? ! where natural. |
| `ar` | Arabic | Modern Standard Arabic, formal and businesslike. Right-to-left: the page mirrors. Keep Latin product/protocol names (Checkmarx One, SMTP, API…) as they are, left-to-right within the sentence. |
| `he` | Hebrew | Formal written Hebrew. Right-to-left: the page mirrors. Keep Latin product/protocol names as they are, left-to-right within the sentence. Available only where its activation code is in force. |

## Terms that must stay distinct

- **The Mission Zero line on the Dashboard** has five stages. Their labels must be five different short words:
  - **Detect:** findings are open.
  - **Triage:** AI Triage judges them.
  - **Remediate:** AI Remediation proposes a fix.
  - **Fix:** the developer changes the code and rescans.
  - **Verify:** a rescan confirms the fix.
- **Remediate vs. Fix:** Remediate is the AI's step and Fix is the developer's. For example:
  - Japanese: AI修正 / 修正対応.
  - Spanish: Remediar / Corregir.
  - German: Beheben / Korrigieren.
  - French: Remédier / Corriger.
- **Remind vs. Reminders, Track vs. Tracked reports:** keep the same root word in each pair, so the button and the thing it makes are recognisably related.

## Core terms

Use these terms consistently. Where a term is shown as two forms, use the first in labels and the second in running text when it reads better.

| English | ja | zh-TW | zh-CN | ko | es | vi | th | ms | id |
|---|---|---|---|---|---|---|---|---|---|
| vulnerability | 脆弱性 | 弱點 | 漏洞 | 취약점 | vulnerabilidad | lỗ hổng | ช่องโหว่ | kerentanan | kerentanan |
| finding (one row Checkmarx One reports) | 検出結果 | 檢測結果 | 检测结果 | 탐지 결과 | hallazgo | phát hiện | ผลการตรวจพบ | penemuan | temuan |
| result (a Checkmarx One result, which several findings can share) | 結果 | 結果 | 结果 | 결과 | resultado | kết quả | ผลลัพธ์ | hasil | hasil |
| project | プロジェクト | 專案 | 项目 | 프로젝트 | proyecto | dự án | โปรเจกต์ | projek | proyek |
| scan / rescan | スキャン / 再スキャン | 掃描 / 重新掃描 | 扫描 / 重新扫描 | 스캔 / 재스캔 | escaneo / volver a escanear | quét / quét lại | การสแกน / สแกนซ้ำ | imbasan / imbas semula | pemindaian / pindai ulang |
| triage, AI Triage | トリアージ, AI トリアージ | 研判, AI 研判 | 研判, AI 研判 | 분류, AI 분류 | triaje, triaje con AI | phân loại, phân loại bằng AI | การคัดกรอง, การคัดกรองด้วย AI | triaj, triaj AI | triase, triase AI |
| remediation, AI Remediation | 修正, AI 修正 | 修補, AI 修補 | 修复, AI 修复 | 조치, AI 조치 | corrección, corrección con AI | khắc phục, khắc phục bằng AI | การแก้ไข, การแก้ไขด้วย AI | pembaikan, pembaikan AI | perbaikan, perbaikan AI |
| credit (an AI credit) | クレジット | 點數 | 点数 | 크레딧 | crédito | tín dụng | เครดิต | kredit | kredit |
| credit pool | クレジットプール | 點數額度 | 点数额度 | 크레딧 풀 | bolsa de créditos | hạn mức tín dụng | วงเงินเครดิต | kumpulan kredit | kumpulan kredit |
| allocate / allocation | 割り当てる / 割り当て | 分配 | 分配 | 할당 | asignar / asignación | phân bổ | จัดสรร / การจัดสรร | peruntukkan / peruntukan | alokasikan / alokasi |
| take back (unused credits) | 回収 | 收回 | 收回 | 회수 | recuperar | thu hồi | เรียกคืน | ambil semula | tarik kembali |
| severity | 重大度 | 嚴重性 | 严重程度 | 심각도 | gravedad | mức độ nghiêm trọng | ระดับความรุนแรง | tahap keterukan | tingkat keparahan |
| Critical / High / Medium / Low / Info | 緊急 / 高 / 中 / 低 / 情報 | 嚴重 / 高 / 中 / 低 / 資訊 | 严重 / 高 / 中 / 低 / 信息 | 심각 / 높음 / 보통 / 낮음 / 정보 | Crítica / Alta / Media / Baja / Informativa | Nghiêm trọng / Cao / Trung bình / Thấp / Thông tin | วิกฤต / สูง / ปานกลาง / ต่ำ / ข้อมูล | Kritikal / Tinggi / Sederhana / Rendah / Maklumat | Kritis / Tinggi / Sedang / Rendah / Info |
| To verify / Confirmed / Not exploitable / Proposed not exploitable / Urgent | 要検証 / 確認済み / 悪用不可 / 悪用不可（提案） / 緊急対応 | 待驗證 / 已確認 / 無法利用 / 建議為無法利用 / 緊急 | 待验证 / 已确认 / 不可利用 / 建议为不可利用 / 紧急 | 확인 필요 / 확인됨 / 악용 불가 / 악용 불가 제안 / 긴급 | Por verificar / Confirmado / No explotable / Propuesto como no explotable / Urgente | Cần xác minh / Đã xác nhận / Không thể khai thác / Đề xuất không thể khai thác / Khẩn cấp | รอตรวจสอบ / ยืนยันแล้ว / ไม่สามารถใช้ประโยชน์ได้ / เสนอว่าไม่สามารถใช้ประโยชน์ได้ / เร่งด่วน | Perlu disahkan / Disahkan / Tidak boleh dieksploitasi / Dicadangkan tidak boleh dieksploitasi / Segera | Perlu diverifikasi / Dikonfirmasi / Tidak dapat dieksploitasi / Diusulkan tidak dapat dieksploitasi / Mendesak |
| Dashboard | ダッシュボード | 儀表板 | 仪表板 | 대시보드 | Panel | Bảng điều khiển | แดชบอร์ด | Papan pemuka | Dasbor |
| Reports / report | レポート | 報告 | 报告 | 보고서 | Informes / informe | Báo cáo | รายงาน | Laporan | Laporan |
| tracked report | 追跡レポート | 追蹤報告 | 跟踪报告 | 추적 보고서 | informe de seguimiento | báo cáo theo dõi | รายงานติดตาม | laporan dijejaki | laporan terpantau |
| Credit Control | クレジット管理 | 點數管理 | 点数管理 | 크레딧 관리 | Control de créditos | Quản lý tín dụng | การควบคุมเครดิต | Kawalan kredit | Kontrol kredit |
| Audit / audit log | 監査 / 監査ログ | 稽核 / 稽核記錄 | 审计 / 审计日志 | 감사 / 감사 로그 | Auditoría / registro de auditoría | Kiểm tra / nhật ký kiểm tra | การตรวจสอบ / บันทึกการตรวจสอบ | Audit / log audit | Audit / log audit |
| People & roles | ユーザーとロール | 人員與角色 | 人员与角色 | 사용자 및 역할 | Personas y roles | Người dùng và vai trò | ผู้ใช้และบทบาท | Pengguna & peranan | Pengguna & peran |
| Settings | 設定 | 設定 | 设置 | 설정 | Configuración | Cài đặt | การตั้งค่า | Tetapan | Pengaturan |
| Logs | ログ | 記錄 | 日志 | 로그 | Registros | Nhật ký | บันทึก | Log | Log |
| Your profile | プロフィール | 個人檔案 | 个人资料 | 내 프로필 | Su perfil | Hồ sơ của bạn | โปรไฟล์ของคุณ | Profil anda | Profil Anda |
| time zone | タイムゾーン | 時區 | 时区 | 표준 시간대 | zona horaria | múi giờ | เขตเวลา | zon waktu | zona waktu |
| reminder | リマインダー | 提醒 | 提醒 | 알림 | recordatorio | lời nhắc | การแจ้งเตือน | peringatan | pengingat |
| follow-up | フォローアップ | 後續追蹤 | 后续跟进 | 후속 조치 | seguimiento | theo dõi tiếp | การติดตามผล | susulan | tindak lanjut |
| scan initiator (who ran the scan) | スキャン実行者 | 掃描執行者 | 扫描执行者 | 스캔 실행자 | quien ejecutó el escaneo | người chạy quét | ผู้เรียกใช้การสแกน | pelaksana imbasan | pelaksana pemindaian |
| code author / owner | コード作成者 / 所有者 | 程式碼作者 / 擁有者 | 代码作者 / 负责人 | 코드 작성자 / 소유자 | autor del código / responsable | tác giả mã / chủ sở hữu | ผู้เขียนโค้ด / เจ้าของ | pengarang kod / pemilik | penulis kode / pemilik |
| fetch / load findings | 取得する / 検出結果を読み込む | 取得 / 載入檢測結果 | 获取 / 加载检测结果 | 가져오기 / 탐지 결과 불러오기 | obtener / cargar hallazgos | lấy / tải các phát hiện | ดึงข้อมูล / โหลดผลการตรวจพบ | ambil / muatkan penemuan | ambil / muat temuan |
| sign in / sign out | サインイン / サインアウト | 登入 / 登出 | 登录 / 退出登录 | 로그인 / 로그아웃 | iniciar sesión / cerrar sesión | đăng nhập / đăng xuất | ลงชื่อเข้าใช้ / ออกจากระบบ | log masuk / log keluar | masuk / keluar |
| administrator (Admin role) | 管理者 | 管理員 | 管理员 | 관리자 | administrador | quản trị viên | ผู้ดูแลระบบ | pentadbir | administrator |
| Detect · Eliminate · Govern | 検出・排除・統制 | 偵測・消除・治理 | 检测・消除・治理 | 탐지 · 제거 · 거버넌스 | Detectar · Eliminar · Gobernar | Phát hiện · Loại bỏ · Quản trị | ตรวจจับ · กำจัด · กำกับดูแล | Kesan · Hapuskan · Tadbir urus | Deteksi · Eliminasi · Tata kelola |

Spanish keeps "AI" (not "IA") in "triaje con AI" and "corrección con AI", because "AI" is part of the feature's name in every language.
