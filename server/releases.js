'use strict';

// Update notes. Every company hears about each update once, the first time the platform starts with it:
// everyone gets an in-app notice (and a "what's new" sheet), and owners and system admins also get the
// steps they need to take, in the app and by email when email is set up.
//
// For each update, add an entry at the TOP of RELEASES with a new, never-reused id.

const { now } = require('./db');

const ADMIN_SQL = `(u.role = 'owner' OR (',' || u.roles || ',') LIKE '%,admin,%' OR (',' || u.roles || ',') LIKE '%,owner,%')`;

const RELEASES = [
  {
    id: '2026-10-22-colleague-wording',
    date: '2026-10-22',
    title: 'الرسائل والتقارير بصيغة الزميل أو الزميلة',
    changes: [
      'رسائل واتساب والتذكيرات تبدأ بـ«الزميل العزيز» أو «الزميلة العزيزة» و«حضرة الأستاذ» أو «حضرة الأستاذة» حسب نوع المستلم، في كل الصفحات.',
      'التقرير يذكر مقدّمه بـ«الزميل …» أو «الزميلة …»، والمرفوع إليه بـ«الأستاذ …» أو «الأستاذة …»، على الشاشة وفي PDF وفي رسالة واتساب.',
      'إشعارات التقارير والطلبات والتذكيرات تذكر المرسل بـ«الزميل …» أو «الزميلة …».',
    ],
    actions: [
      {
        text: 'لتظهر الصيغة الصحيحة لكل شخص، حدّد نوع من لم يُحدَّد له بعد من «المستخدمين» ← «تحديد النوع».',
        link: '#/people?genders=1',
        needed: 'EXISTS (SELECT 1 FROM users x WHERE x.company_id = u.company_id AND x.active = 1 AND x.deleted_at IS NULL AND x.gender = \'\')',
      },
    ],
  },
  {
    id: '2026-10-22-requests-gender-brand',
    date: '2026-10-22',
    title: 'طلبات موحّدة، ومخاطبة كل شخص بصيغته، وهوية الشركة في التقارير',
    changes: [
      'صفحة «الطلبات» تجمع كل الطلبات: زر «إرسال طلب» ثم اختيار «مسؤول أعلى» أو «زميل»، ويضيفه المستلم إلى مهامه بضغطة زر أو يرد عليه.',
      'يمكن رفع التقارير والطلبات إلى أي مسؤول أعلى في التسلسل الإداري، وليس المسؤول المباشر فقط.',
      'تحديد النوع (ذكر/أنثى) لكل مستخدم لتُكتب الرسائل والإشعارات بالصيغة الصحيحة.',
      'هوية الشركة في التقارير: الشعار والألوان والخط في التقرير وملفات PDF وExcel، مع شعار أكبر عند الطباعة.',
      'صورة شخصية لكل مستخدم من «حسابي».',
    ],
    actions: [
      {
        text: 'حدّد نوع كل مستخدم (ذكر/أنثى) من صفحة «المستخدمين» ← «تحديد النوع».',
        link: '#/people?genders=1',
        // Only where someone still has no gender.
        needed: 'EXISTS (SELECT 1 FROM users x WHERE x.company_id = u.company_id AND x.active = 1 AND x.deleted_at IS NULL AND x.gender = \'\')',
      },
      {
        text: 'أضف شعار شركتكم وألوانها وخطها من صفحة «هوية الشركة» لتظهر في التقارير.',
        link: '#/brand',
        needed: 'NOT EXISTS (SELECT 1 FROM company_brands b WHERE b.company_id = u.company_id)',
      },
    ],
  },
];

// What the interface shows: every update, with the steps when the viewer is an owner or admin.
function releasesFor(isAdmin) {
  return RELEASES.map(({ actions, ...r }) => ({ ...r, actions: isAdmin ? actions.map(({ text, link }) => ({ text, link })) : [] }));
}

// Sends each update not sent yet. Safe with several servers starting at once: an update is claimed
// by inserting its id, and only the server whose insert succeeded sends it.
async function deliverReleases(db, messenger = null) {
  const sent = [];
  for (const release of [...RELEASES].reverse()) {
    const ts = now();
    const claim = await db.run('INSERT INTO release_notices (id, sent_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', release.id, ts);
    if (!claim.changes) continue;
    await db.run(`INSERT INTO notifications (user_id, type, message, link, created_at)
      SELECT u.id, 'update', ?, '#/updates', ? FROM users u WHERE u.active = 1 AND u.deleted_at IS NULL`,
    `تحديث جديد على المنصة: ${release.title}`, ts);
    for (const action of release.actions) {
      await db.run(`INSERT INTO notifications (user_id, type, message, link, created_at)
        SELECT u.id, 'update_action', ?, ?, ? FROM users u
        WHERE u.active = 1 AND u.deleted_at IS NULL AND ${ADMIN_SQL}${action.needed ? ` AND ${action.needed}` : ''}`,
      `مطلوب بعد التحديث: ${action.text}`, action.link, ts);
    }
    if (messenger && messenger.sendNotice) emailAdmins(db, messenger, release).catch((err) => console.error('update email:', err.message));
    sent.push(release.id);
  }
  return sent;
}

async function emailAdmins(db, messenger, release) {
  const admins = await db.all(`SELECT u.name, u.email FROM users u
    WHERE u.active = 1 AND u.deleted_at IS NULL AND ${ADMIN_SQL}`);
  const text = [
    `صدر تحديث جديد على منصة ابتكار: ${release.title}.`,
    '',
    'الجديد:',
    ...release.changes.map((c) => `• ${c}`),
    ...(release.actions.length ? ['', 'خطوات مطلوبة منكم:', ...release.actions.map((a) => `• ${a.text}`)] : []),
  ].join('\n');
  for (const a of admins) {
    try {
      await messenger.sendNotice({ email: a.email, name: a.name, subject: `تحديث منصة ابتكار — ${release.title}`, text });
    } catch (err) {
      console.error(`update email to ${a.email}:`, err.message);
    }
  }
}

module.exports = { RELEASES, releasesFor, deliverReleases };
