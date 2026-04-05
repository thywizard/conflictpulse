// ============================================================
//  ConflictPulse — Smart Config
//  Works on BOTH conflictpulse.vercel.app AND thywizard.github.io
//  Include this in every HTML page FIRST before any other script
// ============================================================

const CP = {
  // ── Backend API (same for both domains) ──────────────────
  API: 'https://conflictpulse-api.onrender.com',

  // ── Detect which domain we're on ─────────────────────────
  isVercel:  location.hostname.includes('vercel.app'),
  isGitHub:  location.hostname.includes('github.io'),
  isLocal:   location.hostname === 'localhost',

  // ── Base URL for internal links (relative) ────────────────
  // Using relative paths means links work on BOTH domains
  base: '',

  // ── AdSense Publisher ID ──────────────────────────────────
  adsenseId: 'ca-pub-8026135429131617',

  // ── App info ──────────────────────────────────────────────
  name:    'ConflictPulse',
  tagline: 'Real-Time War & Conflict Intelligence',
  version: '2.0.0',
};

// ── Visitor ID ───────────────────────────────────────────────
CP.visitorId = localStorage.getItem('cp_vid') || crypto.randomUUID();
localStorage.setItem('cp_vid', CP.visitorId);

// ── Liked / Saved articles ───────────────────────────────────
CP.liked = JSON.parse(localStorage.getItem('cp_liked') || '[]');
CP.saved = JSON.parse(localStorage.getItem('cp_saved') || '[]');

// ── Analytics tracker ─────────────────────────────────────────
CP.track = (page, articleId = null) => {
  const device   = window.innerWidth < 768 ? 'mobile' : window.innerWidth < 1024 ? 'tablet' : 'desktop';
  const referrer = document.referrer ? new URL(document.referrer).hostname : 'direct';
  fetch(`${CP.API}/api/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId: CP.visitorId, page, articleId, device, referrer })
  }).catch(() => {});
};

// ── Toast helper ──────────────────────────────────────────────
CP.toast = (msg, type = 'success') => {
  let t = document.getElementById('cp-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'cp-toast';
    t.style.cssText = `position:fixed;bottom:5.5rem;left:50%;transform:translateX(-50%) translateY(80px);
      background:#111827;border:1px solid #1E293B;color:#F0F4F8;padding:0.65rem 1.2rem;
      border-radius:10px;font-size:0.82rem;font-weight:600;z-index:9000;opacity:0;
      transition:all 0.3s;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,0.4);
      font-family:'Inter',sans-serif;`;
    document.body.appendChild(t);
  }
  const colors = { success: '#22C55E', error: '#FF3B3B', info: '#3B82F6' };
  t.textContent = msg;
  t.style.borderColor = `${colors[type] || colors.success}66`;
  t.style.opacity = '1';
  t.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(CP._toastTimer);
  CP._toastTimer = setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(-50%) translateY(80px)';
  }, 2800);
};

// ── Helpers ──────────────────────────────────────────────────
CP.timeAgo = (date) => {
  const diff = Date.now() - new Date(date);
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (m < 1)  return '🔴 Just now';
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  return `${d}d ago`;
};

CP.regionEmoji = r => ({'Middle East':'🕌','Europe':'🇪🇺','Africa':'🌍','Asia':'🌏',
  'Americas':'🌎','Global':'🌐','Russia & CIS':'🐻','South Asia':'🇮🇳'}[r] || '🌐');

CP.importanceDot = i => ({breaking:'🔴',high:'🟠',medium:'🔵',low:'⚪'}[i] || '⚪');

CP.scoreClass = s => s >= 7 ? 'crit' : s >= 4 ? 'high' : 'low-s';

CP.srcClass = s => ({'BBC':'src-bbc','Al Jazeera':'src-aljazeera','Reuters':'src-reuters',
  'DW':'src-dw','France 24':'src-france24','Sky News':'src-skynews',
  'The Intercept':'src-intercept','Foreign Policy':'src-fp'}[s] || 'src-default');

CP.esc = s => (s||'').replace(/['"<>&]/g,
  c => ({'\'':'&#39;','"':'&quot;','<':'&lt;','>':'&gt;','&':'&amp;'}[c]));

CP.isNew = date => (Date.now() - new Date(date)) < 30 * 60 * 1000;

console.log(`✅ ConflictPulse v${CP.version} loaded on ${location.hostname}`);
