'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const CATEGORIES = ['Politics','Economics','Sports','Science','Tech','Culture','Other'];

// ============================================================
// SUPABASE INIT
// ============================================================
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { detectSessionInUrl: true }
});

// ============================================================
// STATE
// ============================================================
const app = { user: null, profile: null };
let _realtimeChannel = null;

// ============================================================
// UTILITIES
// ============================================================
const fmt$   = n  => '$' + Number(n || 0).toFixed(2);
const fmtPct = p  => (p * 100).toFixed(1) + '%';
const fmtDate = d => new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
const fmtDatetime = d => new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });

function timeAgo(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60)    return 'just now';
  if (s < 3600)  return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function setMain(html) {
  document.getElementById('main').innerHTML = html;
  window.scrollTo(0, 0);
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
}

// Simple modal returning a Promise<value|null>
function showModal({ title, body, confirmLabel = 'Confirm', confirmClass = 'btn-primary' }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        ${body}
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modal-cancel">Cancel</button>
          <button class="btn ${confirmClass}" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = val => { overlay.remove(); resolve(val); };
    overlay.querySelector('#modal-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('#modal-confirm').addEventListener('click', () => {
      // Collect any input inside the modal
      const inputs = overlay.querySelectorAll('input, textarea, select');
      if (inputs.length === 1) { cleanup(inputs[0].value); }
      else if (inputs.length > 1) {
        const vals = {};
        inputs.forEach(i => { vals[i.name || i.id] = i.value; });
        cleanup(vals);
      } else { cleanup(true); }
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(null); });
  });
}

// AMM cost calculator (mirrors the SQL function)
function calcAMM(yesPrice, liquidity, side, shares) {
  const liq = Math.max(liquidity, 10);
  const cur = side === 'yes' ? yesPrice : 1 - yesPrice;
  const impact = shares / (2 * liq);
  const avgPrice = Math.min(0.99, Math.max(0.01, cur + impact / 2));
  const cost = avgPrice * shares;
  const newPrice = side === 'yes'
    ? Math.min(0.99, Math.max(0.01, yesPrice + impact))
    : Math.min(0.99, Math.max(0.01, yesPrice - impact));
  return { cost, avgPrice, newPrice };
}

// ============================================================
// AUTH
// ============================================================
async function ensureProfile(user) {
  const { data, error } = await sb.rpc('ensure_profile', {
    p_user_id: user.id,
    p_email:   user.email
  });
  if (error) { console.error('ensureProfile:', error); return null; }
  app.profile = data;
  return data;
}

async function signIn(email) {
  return sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });
}

async function signOut() {
  await sb.auth.signOut();
  app.user = null; app.profile = null;
  window.location.hash = '#/';
}

// ============================================================
// DB HELPERS
// ============================================================
async function getMarkets(category, search) {
  let q = sb.from('markets')
    .select('*, profiles(username)')
    .order('volume', { ascending: false });
  if (category) q = q.eq('category', category);
  if (search)   q = q.ilike('title', `%${search}%`);
  const { data } = await q;
  return data || [];
}

async function getMarket(id) {
  const { data } = await sb.from('markets')
    .select('*, profiles(username)')
    .eq('id', id).single();
  return data;
}

async function getOpenOrders(marketId) {
  const { data } = await sb.from('orders')
    .select('*, profiles(username)')
    .eq('market_id', marketId)
    .in('status', ['open','partial'])
    .order('price', { ascending: false });
  return data || [];
}

async function getComments(marketId) {
  const { data } = await sb.from('comments')
    .select('*, profiles(username)')
    .eq('market_id', marketId)
    .order('created_at', { ascending: true });
  return data || [];
}

async function getUserPositions(userId) {
  const { data } = await sb.from('positions')
    .select('*, markets(id, title, yes_price, resolution, resolved_at, closes_at)')
    .eq('user_id', userId);
  return (data || []).filter(p => p.yes_shares > 0 || p.no_shares > 0);
}

async function getUserOrders(userId) {
  const { data } = await sb.from('orders')
    .select('*, markets(title)')
    .eq('user_id', userId)
    .in('status', ['open','partial'])
    .order('created_at', { ascending: false });
  return data || [];
}

async function refreshProfile() {
  if (!app.user) return;
  const { data } = await sb.from('profiles').select('*').eq('id', app.user.id).single();
  if (data) {
    app.profile = data;
    const el = document.getElementById('nav-balance');
    if (el) el.textContent = fmt$(data.balance);
  }
}

// ============================================================
// NAVBAR
// ============================================================
function renderNavbar() {
  const nav = document.getElementById('navbar');
  if (!app.user) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');
  const hash = window.location.hash;

  nav.innerHTML = `
    <div class="nav-inner">
      <a href="#/" class="nav-brand">◈ Prism</a>
      <div class="nav-links">
        <a href="#/"          class="nav-link${hash === '#/' || hash === '' ? ' active' : ''}">Markets</a>
        <a href="#/create"    class="nav-link${hash === '#/create' ? ' active' : ''}">Create</a>
        <a href="#/portfolio" class="nav-link${hash === '#/portfolio' ? ' active' : ''}">Portfolio</a>
        ${app.profile?.is_admin ? `<a href="#/admin" class="nav-link${hash === '#/admin' ? ' active' : ''}">Admin</a>` : ''}
      </div>
      <div class="nav-right">
        <span class="nav-balance" id="nav-balance">${app.profile ? fmt$(app.profile.balance) : ''}</span>
        <button class="nav-avatar" id="nav-avatar-btn" title="Account">
          ${(app.profile?.username || app.user.email || '??').slice(0,2).toUpperCase()}
        </button>
        <button class="nav-hamburger" id="nav-hamburger-btn">
          <span></span><span></span><span></span>
        </button>
        <div class="nav-dropdown hidden" id="nav-dropdown">
          <div class="dropdown-user">${app.profile?.username || app.user.email}</div>
          <a href="#/profile" class="dropdown-item">Profile Settings</a>
          <button class="dropdown-item" id="signout-btn">Sign Out</button>
        </div>
      </div>
    </div>
    <div class="nav-mobile-menu" id="nav-mobile-menu">
      <a href="#/"          class="nav-mobile-link${hash === '#/' || hash === '' ? ' active' : ''}">Markets</a>
      <a href="#/create"    class="nav-mobile-link${hash === '#/create' ? ' active' : ''}">Create</a>
      <a href="#/portfolio" class="nav-mobile-link${hash === '#/portfolio' ? ' active' : ''}">Portfolio</a>
      ${app.profile?.is_admin ? `<a href="#/admin" class="nav-mobile-link${hash === '#/admin' ? ' active' : ''}">Admin</a>` : ''}
      <a href="#/profile" class="nav-mobile-link">Profile</a>
      <button class="nav-mobile-link" id="mobile-signout">Sign Out</button>
    </div>`;

  // Avatar dropdown
  document.getElementById('nav-avatar-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('nav-dropdown').classList.toggle('hidden');
    document.getElementById('nav-mobile-menu').classList.remove('active');
  });

  // Hamburger menu
  const hamBtn = document.getElementById('nav-hamburger-btn');
  const mobileMen = document.getElementById('nav-mobile-menu');
  hamBtn.addEventListener('click', e => {
    e.stopPropagation();
    hamBtn.classList.toggle('active');
    mobileMen.classList.toggle('active');
    document.getElementById('nav-dropdown').classList.add('hidden');
  });

  // Close menus on route
  document.querySelectorAll('.nav-mobile-link').forEach(link => {
    link.addEventListener('click', () => {
      hamBtn.classList.remove('active');
      mobileMen.classList.remove('active');
    });
  });

  // Global click to close menus
  document.addEventListener('click', e => {
    if (!e.target.closest('.nav-right') && !e.target.closest('.nav-mobile-menu')) {
      document.getElementById('nav-dropdown').classList.add('hidden');
      if (hamBtn) { hamBtn.classList.remove('active'); mobileMen.classList.remove('active'); }
    }
  });

  document.getElementById('signout-btn').addEventListener('click', signOut);
  document.getElementById('mobile-signout').addEventListener('click', signOut);
}

// ============================================================
// VIEW: LOGIN
// ============================================================
function renderLogin() {
  document.getElementById('navbar').classList.add('hidden');
  setMain(`
    <div class="login-page">
      <div class="login-card">
        <span class="login-logo">◈</span>
        <h1 class="login-title">Prism Markets</h1>
        <p class="login-sub">Trade on real-world outcomes with play money. No wallet needed.</p>
        <form class="login-form" id="login-form" novalidate>
          <div class="form-group">
            <label class="form-label" for="login-email">Email address</label>
            <input type="email" id="login-email" class="form-input"
              placeholder="you@example.com" required autocomplete="email">
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="login-btn">
            Send Magic Link
          </button>
          <div id="login-msg" class="login-message hidden"></div>
        </form>
        <p class="login-legal">You'll receive a sign-in link by email — no password required. Play money only, for entertainment.</p>
      </div>
    </div>`);

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    if (!email) return;
    const btn = document.getElementById('login-btn');
    btn.disabled = true; btn.textContent = 'Sending…';

    const { error } = await signIn(email);
    if (error) {
      toast(error.message, 'error');
      btn.disabled = false; btn.textContent = 'Send Magic Link';
    } else {
      const msg = document.getElementById('login-msg');
      msg.classList.remove('hidden');
      msg.innerHTML = `✓ Link sent to <strong>${escapeHtml(email)}</strong> — check your inbox.`;
      btn.textContent = 'Link Sent';
    }
  });
}

// ============================================================
// VIEW: HOME
// ============================================================
async function renderHome() {
  setMain('<div class="loading-markets"><div class="spinner"></div></div>');
  const markets = await getMarkets();

  setMain(`
    <div class="page-home">
      <div class="home-header">
        <h1 class="home-title">Prediction Markets</h1>
        <p class="home-sub">Start with ${fmt$(1000)} in play money. Trade on the outcomes that matter.</p>
      </div>
      <div class="filter-bar">
        <button class="filter-btn active" data-cat="">All</button>
        ${CATEGORIES.map(c => `<button class="filter-btn" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}
        <input type="text" class="filter-search" id="market-search" placeholder="Search…" autocomplete="off">
      </div>
      <div class="markets-grid" id="markets-grid">
        ${markets.length ? markets.map(marketCard).join('') : emptyState('No markets yet', 'Create the first one!')}
      </div>
    </div>`);

  // Category filter
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const grid = document.getElementById('markets-grid');
      grid.innerHTML = '<div class="loading-markets"><div class="spinner"></div></div>';
      const filtered = await getMarkets(btn.dataset.cat || null, document.getElementById('market-search').value);
      grid.innerHTML = filtered.length ? filtered.map(marketCard).join('') : emptyState('No markets match this filter');
    });
  });

  // Search with debounce
  let t;
  document.getElementById('market-search').addEventListener('input', e => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const cat = document.querySelector('.filter-btn.active')?.dataset.cat || '';
      const filtered = await getMarkets(cat || null, e.target.value);
      const grid = document.getElementById('markets-grid');
      grid.innerHTML = filtered.length ? filtered.map(marketCard).join('') : emptyState('No markets match your search');
    }, 280);
  });
}

function marketCard(m) {
  const pct = Math.round(m.yes_price * 100);
  const resolved = !!m.resolved_at;
  const closed   = !resolved && new Date(m.closes_at) < new Date();
  return `
    <a href="#/market/${m.id}" class="market-card${resolved ? ' resolved' : ''}">
      <div class="card-header">
        <span class="card-category">${escapeHtml(m.category)}</span>
        ${resolved ? `<span class="badge badge-${m.resolution}">${m.resolution.toUpperCase()} ✓</span>` : ''}
        ${closed   ? '<span class="badge badge-closed">CLOSED</span>' : ''}
      </div>
      <h3 class="card-title">${escapeHtml(m.title)}</h3>
      <div class="prob-bar-wrapper">
        <div class="prob-bar"><div class="prob-fill yes-fill" style="width:${pct}%"></div></div>
        <div class="prob-labels">
          <span class="prob-yes">${pct}% YES</span>
          <span class="prob-no">${100 - pct}% NO</span>
        </div>
      </div>
      <div class="card-meta">
        <span>${fmt$(m.volume)} vol</span>
        <span>Closes ${fmtDate(m.closes_at)}</span>
        <span>by ${escapeHtml(m.profiles?.username || 'anon')}</span>
      </div>
    </a>`;
}

function emptyState(msg, sub = '') {
  return `<div class="empty-state" style="grid-column:1/-1">
    <div class="empty-icon">◈</div>
    <p>${escapeHtml(msg)}</p>
    ${sub ? `<p style="margin-top:8px;font-size:12px"><a href="#/create">${escapeHtml(sub)}</a></p>` : ''}
  </div>`;
}

// ============================================================
// VIEW: MARKET DETAIL
// ============================================================
async function renderMarket(id) {
  setMain('<div class="loading-markets"><div class="spinner"></div></div>');

  const [market, orders, comments] = await Promise.all([
    getMarket(id),
    getOpenOrders(id),
    getComments(id)
  ]);

  if (!market) {
    setMain(`<div class="empty-state" style="padding:80px 0">
      <h2>Market not found</h2>
      <a href="#/" class="btn btn-secondary" style="margin-top:16px">Go Home</a>
    </div>`);
    return;
  }

  const pct      = Math.round(market.yes_price * 100);
  const resolved = !!market.resolved_at;
  const closed   = !resolved && new Date(market.closes_at) < new Date();
  const noTrade  = resolved || closed;
  const isOwner  = app.user && market.creator_id === app.user.id;
  const yesBids  = orders.filter(o => o.side === 'yes').sort((a,b) => b.price - a.price);
  const noBids   = orders.filter(o => o.side === 'no').sort((a,b)  => b.price - a.price);

  setMain(`
    <div class="page-market">
      <a href="#/" class="back-link">← All Markets</a>

      <div class="market-header">
        <div class="market-meta-row">
          <span class="badge badge-cat">${escapeHtml(market.category)}</span>
          ${resolved ? `<span class="badge badge-${market.resolution}">${market.resolution.toUpperCase()} ✓</span>` : ''}
          ${closed   ? '<span class="badge badge-closed">CLOSED</span>' : ''}
          <span class="market-vol">${fmt$(market.volume)} volume</span>
        </div>
        <h1 class="market-title">${escapeHtml(market.title)}</h1>
        ${market.description ? `<p class="market-desc">${escapeHtml(market.description)}</p>` : ''}
        <div class="prob-display">
          <div class="prob-bar large">
            <div class="prob-fill yes-fill" style="width:${pct}%"></div>
          </div>
          <div class="prob-labels" style="margin-top:8px">
            <span class="prob-yes mono" style="font-size:18px">${pct}¢ YES</span>
            <span class="prob-no mono" style="font-size:18px">${100 - pct}¢ NO</span>
          </div>
        </div>
        <div class="market-dates">
          <span>Created by <strong>${escapeHtml(market.profiles?.username || 'anon')}</strong></span>
          <span>Closes <strong>${fmtDatetime(market.closes_at)}</strong></span>
          ${resolved ? `<span>Resolved <strong>${fmtDate(market.resolved_at)}</strong></span>` : ''}
          <span>Liquidity <strong class="mono">${fmt$(market.liquidity)}</strong></span>
        </div>
      </div>

      <div class="market-body">

        <!-- TRADE PANEL -->
        <div class="trade-panel">
          <div class="panel-title">Trade</div>
          ${noTrade ? `
            <div class="trading-disabled">
              ${resolved
                ? `Resolved <span class="color-${market.resolution}">${market.resolution.toUpperCase()}</span>`
                : 'This market is closed.'}
            </div>
          ` : `
            <div class="trade-tabs">
              <button class="trade-tab active" data-tab="market">Market</button>
              <button class="trade-tab" data-tab="limit">Limit</button>
            </div>

            <!-- Market Order -->
            <div id="tab-market" class="trade-tab-content">
              <div class="side-toggle">
                <button class="side-btn yes active" data-side="yes">YES</button>
                <button class="side-btn no"         data-side="no">NO</button>
              </div>
              <div class="form-group">
                <label class="form-label">Shares</label>
                <input type="number" class="form-input mono" id="m-shares" min="1" value="10" step="1">
              </div>
              <div class="trade-summary">
                <div class="summary-row"><span>Avg Price</span><span class="mono" id="m-avg">-</span></div>
                <div class="summary-row"><span>Estimated Cost</span><span class="mono" id="m-cost">-</span></div>
                <div class="summary-row"><span>Max Payout</span><span class="mono" id="m-payout">-</span></div>
              </div>
              <button class="btn btn-yes btn-block" id="m-buy-btn">Buy YES</button>
            </div>

            <!-- Limit Order -->
            <div id="tab-limit" class="trade-tab-content hidden">
              <div class="side-toggle">
                <button class="side-btn yes active" data-side="yes" data-for="limit">YES</button>
                <button class="side-btn no"         data-side="no"  data-for="limit">NO</button>
              </div>
              <div class="form-group">
                <label class="form-label">Limit Price (0.01 – 0.99)</label>
                <input type="number" class="form-input mono" id="l-price"
                  min="0.01" max="0.99" step="0.01" value="${market.yes_price.toFixed(2)}">
              </div>
              <div class="form-group">
                <label class="form-label">Shares</label>
                <input type="number" class="form-input mono" id="l-shares" min="1" value="10" step="1">
              </div>
              <div class="trade-summary">
                <div class="summary-row"><span>Funds Reserved</span><span class="mono" id="l-reserved">-</span></div>
              </div>
              <button class="btn btn-yes btn-block" id="l-place-btn">Place YES Limit</button>
              <p style="font-size:11px;color:var(--text-dim);margin-top:8px;line-height:1.5">
                Funds are reserved. Other traders can fill your order.
                Cancel anytime to get them back.
              </p>
            </div>
          `}

          ${isOwner && !resolved ? `
            <div class="resolve-section">
              <div class="resolve-title">Resolve Market</div>
              <div class="resolve-btns">
                <button class="btn btn-yes btn-sm" id="res-yes" data-mid="${market.id}">Resolve YES</button>
                <button class="btn btn-no btn-sm"  id="res-no"  data-mid="${market.id}">Resolve NO</button>
              </div>
            </div>
          ` : ''}
        </div>

        <!-- ORDER BOOK -->
        <div class="orderbook-panel">
          <div class="panel-title">Order Book</div>
          ${buildOrderBook(yesBids, noBids, market.yes_price)}
        </div>

        <!-- COMMENTS -->
        <div class="comments-panel">
          <div class="panel-title">Discussion</div>
          <div id="comments-list">${buildComments(comments)}</div>
          ${!resolved ? `
            <div class="comment-form">
              <textarea class="form-input comment-input" id="comment-text"
                placeholder="Share your analysis or reasoning…" rows="2"></textarea>
              <button class="btn btn-secondary btn-sm" id="comment-post">Post</button>
            </div>
          ` : ''}
        </div>

      </div>
    </div>`);

  if (!noTrade) attachTradeHandlers(market);
  if (isOwner && !resolved) attachResolveHandlers(market.id);
  attachCommentHandlers(market.id);
  attachRealtimeForMarket(market.id);
}

/* --- order book HTML --- */
function buildOrderBook(yesBids, noBids, yesPrice) {
  const rows = (orders, side) => {
    if (!orders.length) return `<div class="ob-empty">No open ${side.toUpperCase()} orders</div>`;
    return orders.slice(0, 10).map(o => {
      const remaining = o.quantity - o.filled;
      const isOwn = app.user && o.user_id === app.user.id;
      return `
        <div class="ob-row">
          <span class="ob-price ${side}">${(o.price * 100).toFixed(1)}¢</span>
          <span class="ob-qty">${Math.floor(remaining)}</span>
          <span class="ob-user">${escapeHtml((o.profiles?.username || 'anon').slice(0,10))}</span>
          ${isOwn
            ? `<button class="ob-cancel" data-oid="${o.id}">Cancel</button>`
            : `<button class="ob-fill"   data-oid="${o.id}" data-qty="${remaining}" data-side="${side}">Fill</button>`}
        </div>`;
    }).join('');
  };

  const bestYes = yesBids[0]?.price;
  const bestNo  = noBids[0]?.price;
  const spread  = (bestYes && bestNo) ? ((bestYes - (1 - bestNo)) * 100).toFixed(1) + '¢' : '--';

  return `
    <div class="orderbook">
      <div class="ob-header"><span>Price</span><span>Qty</span><span>User</span><span></span></div>
      <div class="ob-section-label yes">YES Bids</div>
      ${rows(yesBids, 'yes')}
      <div class="ob-spread">
        <span>Mid: <span class="mono">${(yesPrice * 100).toFixed(1)}¢</span></span>
        <span>Spread: <span class="mono">${spread}</span></span>
      </div>
      <div class="ob-section-label no">NO Bids</div>
      ${rows(noBids, 'no')}
    </div>`;
}

/* --- comments HTML --- */
function buildComments(comments) {
  if (!comments.length) return `<div class="ob-empty">No comments yet — start the discussion!</div>`;
  return comments.map(c => `
    <div class="comment">
      <div class="comment-header">
        <span class="comment-user">${escapeHtml(c.profiles?.username || 'anon')}</span>
        <span class="comment-time">${timeAgo(c.created_at)}</span>
      </div>
      <p class="comment-body">${escapeHtml(c.content)}</p>
    </div>`).join('');
}

/* --- trade handlers --- */
function attachTradeHandlers(market) {
  let mSide = 'yes';
  let lSide = 'yes';

  // Tab switching
  document.querySelectorAll('.trade-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.trade-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.trade-tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${tab.dataset.tab}`).classList.remove('hidden');
    });
  });

  // Market order — side toggle
  document.querySelectorAll('#tab-market .side-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-market .side-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mSide = btn.dataset.side;
      updateMarketSummary();
      const b = document.getElementById('m-buy-btn');
      b.textContent = `Buy ${mSide.toUpperCase()}`;
      b.className   = `btn btn-${mSide} btn-block`;
    });
  });

  const updateMarketSummary = () => {
    const shares = parseFloat(document.getElementById('m-shares').value) || 0;
    const { cost, avgPrice } = calcAMM(market.yes_price, market.liquidity, mSide, shares);
    document.getElementById('m-avg').textContent    = (avgPrice * 100).toFixed(1) + '¢';
    document.getElementById('m-cost').textContent   = fmt$(cost);
    document.getElementById('m-payout').textContent = fmt$(shares);
  };
  document.getElementById('m-shares').addEventListener('input', updateMarketSummary);
  updateMarketSummary();

  document.getElementById('m-buy-btn').addEventListener('click', async () => {
    const shares = parseFloat(document.getElementById('m-shares').value);
    if (!shares || shares <= 0) { toast('Enter a share amount', 'error'); return; }

    const btn = document.getElementById('m-buy-btn');
    btn.disabled = true; btn.textContent = 'Executing…';

    const { data, error } = await sb.rpc('execute_market_order', {
      p_user_id: app.user.id, p_market_id: market.id,
      p_side: mSide, p_shares: shares
    });

    if (error || data?.error) {
      toast(data?.error || error.message, 'error');
      btn.disabled = false; btn.textContent = `Buy ${mSide.toUpperCase()}`;
      return;
    }
    toast(`Bought ${shares} ${mSide.toUpperCase()} shares for ${fmt$(data.cost)}!`, 'success');
    await refreshProfile();
    await renderMarket(market.id);
  });

  // Limit order — side toggle
  document.querySelectorAll('#tab-limit .side-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-limit .side-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      lSide = btn.dataset.side;
      updateLimitSummary();
      const b = document.getElementById('l-place-btn');
      b.textContent = `Place ${lSide.toUpperCase()} Limit`;
      b.className   = `btn btn-${lSide} btn-block`;
    });
  });

  const updateLimitSummary = () => {
    const price = parseFloat(document.getElementById('l-price').value)  || 0;
    const qty   = parseFloat(document.getElementById('l-shares').value) || 0;
    document.getElementById('l-reserved').textContent = fmt$(price * qty);
  };
  document.getElementById('l-price').addEventListener('input', updateLimitSummary);
  document.getElementById('l-shares').addEventListener('input', updateLimitSummary);
  updateLimitSummary();

  document.getElementById('l-place-btn').addEventListener('click', async () => {
    const price = parseFloat(document.getElementById('l-price').value);
    const qty   = parseFloat(document.getElementById('l-shares').value);
    if (!price || price <= 0.01 || price >= 0.99) { toast('Price must be between 0.01 and 0.99', 'error'); return; }
    if (!qty || qty <= 0) { toast('Enter a share amount', 'error'); return; }

    const btn = document.getElementById('l-place-btn');
    btn.disabled = true; btn.textContent = 'Placing…';

    const { data, error } = await sb.rpc('place_limit_order', {
      p_user_id: app.user.id, p_market_id: market.id,
      p_side: lSide, p_price: price, p_quantity: qty
    });

    if (error || data?.error) {
      toast(data?.error || error.message, 'error');
      btn.disabled = false; btn.textContent = `Place ${lSide.toUpperCase()} Limit`;
      return;
    }
    toast(`${lSide.toUpperCase()} limit order placed! ${fmt$(data.reserved)} reserved.`, 'success');
    await refreshProfile();
    await renderMarket(market.id);
  });
}

/* --- resolve handlers --- */
function attachResolveHandlers(marketId) {
  ['yes','no'].forEach(side => {
    document.getElementById(`res-${side}`)?.addEventListener('click', async () => {
      const ok = await showModal({
        title: `Resolve as ${side.toUpperCase()}?`,
        body: `<p>This will pay out all ${side.toUpperCase()} holders ${fmt$(1)} per share and close the market permanently.</p>`,
        confirmLabel: `Resolve ${side.toUpperCase()}`,
        confirmClass: `btn-${side}`
      });
      if (!ok) return;

      const { data, error } = await sb.rpc('resolve_market', {
        p_resolver_id: app.user.id, p_market_id: marketId, p_resolution: side
      });
      if (error || data?.error) { toast(data?.error || error.message, 'error'); return; }
      toast(`Market resolved ${side.toUpperCase()}! ${fmt$(data.total_payout)} paid out.`, 'success');
      await refreshProfile();
      await renderMarket(marketId);
    });
  });
}

/* --- comment handlers --- */
function attachCommentHandlers(marketId) {
  const btn = document.getElementById('comment-post');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ta  = document.getElementById('comment-text');
    const txt = ta.value.trim();
    if (!txt) return;
    btn.disabled = true;

    const { error } = await sb.from('comments').insert({
      user_id: app.user.id, market_id: marketId, content: txt
    });
    if (error) { toast(error.message, 'error'); btn.disabled = false; return; }
    ta.value = '';
    btn.disabled = false;
    const comments = await getComments(marketId);
    document.getElementById('comments-list').innerHTML = buildComments(comments);
  });
}

/* --- realtime subscription --- */
function attachRealtimeForMarket(marketId) {
  if (_realtimeChannel) sb.removeChannel(_realtimeChannel);
  _realtimeChannel = sb.channel(`mkt-${marketId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'comments', filter: `market_id=eq.${marketId}`
    }, async () => {
      const list = document.getElementById('comments-list');
      if (!list) return;
      const comments = await getComments(marketId);
      list.innerHTML = buildComments(comments);
    })
    .subscribe();
}

/* --- global delegated handlers for order book fill / cancel --- */
function attachGlobalHandlers() {
  document.addEventListener('click', async e => {
    // Fill order
    if (e.target.classList.contains('ob-fill')) {
      const btn  = e.target;
      const oid  = btn.dataset.oid;
      const max  = parseFloat(btn.dataset.qty);
      const side = btn.dataset.side;

      const qtyStr = await showModal({
        title: `Fill ${side.toUpperCase()} Order`,
        body: `
          <p>Enter how many shares to fill (max <span class="mono">${Math.floor(max)}</span>).</p>
          <div class="form-group" style="margin-top:0">
            <input id="fill-qty-input" name="fill-qty-input" type="number"
              class="form-input mono" min="1" max="${Math.floor(max)}" value="${Math.floor(max)}" step="1">
          </div>`,
        confirmLabel: `Fill ${side.toUpperCase()}`,
        confirmClass: `btn-${side}`
      });
      if (!qtyStr) return;
      const qty = parseFloat(qtyStr);
      if (!qty || qty <= 0) { toast('Invalid quantity', 'error'); return; }

      btn.disabled = true; btn.textContent = 'Filling…';
      const { data, error } = await sb.rpc('fill_limit_order', {
        p_filler_id: app.user.id, p_order_id: oid, p_quantity: qty
      });
      if (error || data?.error) {
        toast(data?.error || error.message, 'error');
        btn.disabled = false; btn.textContent = 'Fill';
        return;
      }
      toast(`Filled ${data.filled} shares for ${fmt$(data.cost)}!`, 'success');
      await refreshProfile();
      // Re-render just the order book section
      const marketId = window.location.hash.split('/market/')[1];
      if (marketId) {
        const [market, orders] = await Promise.all([getMarket(marketId), getOpenOrders(marketId)]);
        if (market) {
          const ob = document.querySelector('.orderbook-panel');
          if (ob) {
            const yesBids = orders.filter(o => o.side === 'yes').sort((a,b) => b.price - a.price);
            const noBids  = orders.filter(o => o.side === 'no').sort((a,b)  => b.price - a.price);
            ob.innerHTML = `<div class="panel-title">Order Book</div>${buildOrderBook(yesBids, noBids, market.yes_price)}`;
          }
        }
      }
    }

    // Cancel order
    if (e.target.classList.contains('ob-cancel')) {
      const btn = e.target;
      const oid = btn.dataset.oid;
      const ok  = await showModal({
        title: 'Cancel Order',
        body:  '<p>Cancel this limit order? Your reserved funds will be returned to your balance.</p>',
        confirmLabel: 'Cancel Order',
        confirmClass: 'btn-danger'
      });
      if (!ok) return;
      btn.disabled = true;
      const { data, error } = await sb.rpc('cancel_limit_order', {
        p_user_id: app.user.id, p_order_id: oid
      });
      if (error || data?.error) { toast(data?.error || error.message, 'error'); btn.disabled = false; return; }
      toast(`Order cancelled — ${fmt$(data.refunded)} returned.`, 'success');
      await refreshProfile();
      const marketId = window.location.hash.split('/market/')[1];
      if (marketId) await renderMarket(marketId);
    }

    // Portfolio cancel order
    if (e.target.classList.contains('cancel-order-btn')) {
      const btn = e.target;
      const oid = btn.dataset.oid;
      const ok  = await showModal({
        title: 'Cancel Order',
        body:  '<p>Cancel this limit order? Your reserved funds will be returned.</p>',
        confirmLabel: 'Cancel Order',
        confirmClass: 'btn-danger'
      });
      if (!ok) return;
      btn.disabled = true;
      const { data, error } = await sb.rpc('cancel_limit_order', {
        p_user_id: app.user.id, p_order_id: oid
      });
      if (error || data?.error) { toast(data?.error || error.message, 'error'); btn.disabled = false; return; }
      toast(`Order cancelled — ${fmt$(data.refunded)} returned.`, 'success');
      await refreshProfile();
      await renderPortfolio();
    }
  });
}

// ============================================================
// VIEW: CREATE MARKET
// ============================================================
function renderCreate() {
  const minDate = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0,16);
  setMain(`
    <div class="page-create">
      <div class="create-card">
        <h1 class="page-heading">Create a Market</h1>
        <p class="page-sub">Write a clear yes/no question about a verifiable future outcome.</p>
        <div class="form-group">
          <label class="form-label">Question *</label>
          <input type="text" class="form-input" id="c-title" maxlength="200"
            placeholder="Will [thing] happen by [date]?">
          <span class="form-hint">Should be answerable with a clear yes or no.</span>
        </div>
        <div class="form-group">
          <label class="form-label">Resolution Criteria</label>
          <textarea class="form-input" id="c-desc" rows="3"
            placeholder="How will this market be resolved? What sources will you use? What are the edge cases?"></textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Category *</label>
            <select class="form-input" id="c-cat">
              ${CATEGORIES.map(c => `<option>${escapeHtml(c)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Closes At *</label>
            <input type="datetime-local" class="form-input" id="c-closes" min="${minDate}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Starting Probability</label>
          <div class="slider-row">
            <input type="range" class="prob-slider" id="c-prob" min="1" max="99" value="50">
            <span class="slider-val" id="c-prob-val">50%</span>
          </div>
          <div class="prob-bar" style="margin-top:8px">
            <div class="prob-fill yes-fill" id="c-prob-bar" style="width:50%"></div>
          </div>
          <span class="form-hint" style="margin-top:6px">
            Your best estimate of the probability this resolves YES.
          </span>
        </div>
        <button class="btn btn-primary btn-block" id="c-submit">Create Market</button>
      </div>
    </div>`);

  document.getElementById('c-prob').addEventListener('input', e => {
    const v = e.target.value;
    document.getElementById('c-prob-val').textContent = v + '%';
    document.getElementById('c-prob-bar').style.width = v + '%';
  });

  document.getElementById('c-submit').addEventListener('click', async () => {
    const title  = document.getElementById('c-title').value.trim();
    const desc   = document.getElementById('c-desc').value.trim();
    const cat    = document.getElementById('c-cat').value;
    const closes = document.getElementById('c-closes').value;
    const prob   = parseInt(document.getElementById('c-prob').value, 10) / 100;

    if (!title)                              { toast('Question is required', 'error'); return; }
    if (title.length < 10)                   { toast('Question too short', 'error'); return; }
    if (!closes)                             { toast('Closing date is required', 'error'); return; }
    if (new Date(closes) <= new Date())      { toast('Closing date must be in the future', 'error'); return; }

    const btn = document.getElementById('c-submit');
    btn.disabled = true; btn.textContent = 'Creating…';

    const { data, error } = await sb.from('markets').insert({
      title, description: desc || null, category: cat,
      creator_id: app.user.id,
      closes_at: new Date(closes).toISOString(),
      yes_price: prob, volume: 0, liquidity: 100
    }).select().single();

    if (error) {
      toast(error.message, 'error');
      btn.disabled = false; btn.textContent = 'Create Market';
      return;
    }
    toast('Market created!', 'success');
    window.location.hash = `#/market/${data.id}`;
  });
}

// ============================================================
// VIEW: PORTFOLIO
// ============================================================
async function renderPortfolio() {
  setMain('<div class="loading-markets"><div class="spinner"></div></div>');
  const [positions, openOrders] = await Promise.all([
    getUserPositions(app.user.id),
    getUserOrders(app.user.id)
  ]);

  let posVal = 0;
  positions.forEach(p => {
    const yp = p.markets?.yes_price || 0.5;
    posVal += p.markets?.resolved_at
      ? 0  // already settled
      : p.yes_shares * yp + p.no_shares * (1 - yp);
  });
  const cash    = app.profile?.balance || 0;
  const total   = cash + posVal;
  const pnl     = total - 1000;
  const pnlPos  = pnl >= 0;

  setMain(`
    <div class="page-portfolio">
      <h1 class="page-heading">Portfolio</h1>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Cash</div>
          <div class="stat-value">${fmt$(cash)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Position Value</div>
          <div class="stat-value">${fmt$(posVal)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total</div>
          <div class="stat-value highlight">${fmt$(total)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">P&amp;L</div>
          <div class="stat-value ${pnlPos ? 'gain' : 'loss'}">${pnlPos ? '+' : ''}${fmt$(pnl)}</div>
        </div>
      </div>

      <h2 class="section-heading">Positions</h2>
      ${positions.length ? `
        <div class="table-wrapper">
          <table class="data-table">
            <thead><tr>
              <th>Market</th>
              <th class="ta-right">YES</th>
              <th class="ta-right">NO</th>
              <th class="ta-right">Price</th>
              <th class="ta-right">Value</th>
              <th class="ta-right">Status</th>
            </tr></thead>
            <tbody>
              ${positions.map(p => {
                const yp  = p.markets?.yes_price || 0.5;
                const res = p.markets?.resolved_at;
                const val = res
                  ? (p.markets.resolution === 'yes' ? p.yes_shares : p.no_shares)
                  : p.yes_shares * yp + p.no_shares * (1 - yp);
                return `<tr>
                  <td><a href="#/market/${p.market_id}" class="table-link">${escapeHtml(p.markets?.title || 'Unknown')}</a></td>
                  <td class="ta-right mono yes">${p.yes_shares.toFixed(1)}</td>
                  <td class="ta-right mono no">${p.no_shares.toFixed(1)}</td>
                  <td class="ta-right mono">${(yp * 100).toFixed(1)}¢</td>
                  <td class="ta-right mono">${fmt$(val)}</td>
                  <td class="ta-right">
                    ${res
                      ? `<span class="badge badge-${p.markets.resolution}">${p.markets.resolution.toUpperCase()}</span>`
                      : (new Date(p.markets?.closes_at) < new Date()
                          ? '<span class="badge badge-closed">CLOSED</span>'
                          : '<span class="badge badge-open">OPEN</span>')}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="ob-empty">No positions. <a href="#/">Browse markets</a> to start trading.</div>'}

      <h2 class="section-heading" style="margin-top:32px">Open Limit Orders</h2>
      ${openOrders.length ? `
        <div class="table-wrapper">
          <table class="data-table">
            <thead><tr>
              <th>Market</th><th>Side</th>
              <th class="ta-right">Price</th>
              <th class="ta-right">Qty</th>
              <th class="ta-right">Filled</th>
              <th class="ta-right">Reserved</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${openOrders.map(o => `<tr>
                <td><a href="#/market/${o.market_id}" class="table-link">${escapeHtml(o.markets?.title || '—')}</a></td>
                <td><span class="badge badge-${o.side}">${o.side.toUpperCase()}</span></td>
                <td class="ta-right mono">${(o.price * 100).toFixed(1)}¢</td>
                <td class="ta-right mono">${Number(o.quantity).toFixed(0)}</td>
                <td class="ta-right mono">${Number(o.filled).toFixed(0)}</td>
                <td class="ta-right mono">${fmt$(o.price * (o.quantity - o.filled))}</td>
                <td class="ta-right">
                  <button class="btn btn-sm cancel-order-btn" data-oid="${o.id}"
                    style="background:var(--no-dim);color:var(--no);border:1px solid var(--no-border)">Cancel</button>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="ob-empty">No open limit orders.</div>'}
    </div>`);
}

// ============================================================
// VIEW: PROFILE
// ============================================================
function renderProfile() {
  setMain(`
    <div class="page-profile">
      <div class="profile-card">
        <h1 class="page-heading">Profile</h1>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" value="${escapeHtml(app.user?.email || '')}" disabled>
        </div>
        <div class="form-group">
          <label class="form-label">Username</label>
          <input class="form-input" id="p-username" value="${escapeHtml(app.profile?.username || '')}">
        </div>
        <div class="form-group">
          <label class="form-label">Bio</label>
          <textarea class="form-input" id="p-bio" rows="3">${escapeHtml(app.profile?.bio || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Balance</label>
          <input class="form-input mono" value="${fmt$(app.profile?.balance || 0)}" disabled>
        </div>
        <button class="btn btn-primary btn-block" id="p-save">Save Changes</button>
        <button class="btn btn-ghost btn-block" id="p-signout" style="margin-top:10px">Sign Out</button>
      </div>
    </div>`);

  document.getElementById('p-signout').addEventListener('click', signOut);

  document.getElementById('p-save').addEventListener('click', async () => {
    const username = document.getElementById('p-username').value.trim();
    const bio      = document.getElementById('p-bio').value.trim();
    if (!username) { toast('Username cannot be empty', 'error'); return; }

    const btn = document.getElementById('p-save');
    btn.disabled = true; btn.textContent = 'Saving…';

    const { error } = await sb.from('profiles')
      .update({ username, bio: bio || null })
      .eq('id', app.user.id);

    if (error) {
      toast(error.message, 'error');
      btn.disabled = false; btn.textContent = 'Save Changes';
      return;
    }
    app.profile.username = username; app.profile.bio = bio;
    renderNavbar();
    toast('Profile updated!', 'success');
    btn.disabled = false; btn.textContent = 'Save Changes';
  });
}

// ============================================================
// VIEW: ADMIN
// ============================================================
async function renderAdmin() {
  if (!app.user || !app.profile?.is_admin) {
    setMain(`<div class="empty-state" style="padding:80px 0">
      <h2>Access Denied</h2>
      <p style="margin-top:8px">You don't have admin privileges.</p>
    </div>`);
    return;
  }

  setMain('<div class="loading-markets"><div class="spinner"></div></div>');

  const { data: stats, error } = await sb.rpc('get_admin_stats', { p_user_id: app.user.id });
  if (error || stats?.error) { toast(error?.message || stats.error, 'error'); return; }

  const { total_users, total_balance, total_markets, resolved_markets, total_volume, users, markets } = stats;

  setMain(`
    <div class="page-admin">
      <h1 class="page-heading">Admin Dashboard</h1>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Total Users</div>
          <div class="stat-value">${total_users}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Platform Balance</div>
          <div class="stat-value highlight">${fmt$(total_balance)}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Markets</div>
          <div class="stat-value">${total_markets}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Volume</div>
          <div class="stat-value">${fmt$(total_volume)}</div>
        </div>
      </div>

      <h2 class="section-heading" style="margin-top:32px">Users (Last 100)</h2>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Username</th>
            <th>Email</th>
            <th class="ta-right">Balance</th>
            <th class="ta-right">Positions</th>
            <th class="ta-right">Open Orders</th>
            <th class="ta-right">Joined</th>
          </tr></thead>
          <tbody>
            ${(users || []).map(u => `<tr>
              <td><strong>${escapeHtml(u.username)}</strong></td>
              <td style="font-size:12px;color:var(--text-dim)">${escapeHtml(u.email)}</td>
              <td class="ta-right mono">${fmt$(u.balance)}</td>
              <td class="ta-right">${u.open_positions}</td>
              <td class="ta-right">${u.open_orders}</td>
              <td class="ta-right" style="font-size:12px;color:var(--text-dim)">${fmtDate(u.created_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>

      <h2 class="section-heading" style="margin-top:32px">Markets (Last 50)</h2>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr>
            <th>Title</th>
            <th>Category</th>
            <th class="ta-right">Price</th>
            <th class="ta-right">Volume</th>
            <th class="ta-right">Traders</th>
            <th class="ta-right">Status</th>
            <th class="ta-right">Action</th>
          </tr></thead>
          <tbody>
            ${(markets || []).map(m => {
              const closed = !m.resolved_at && new Date(m.closes_at) < new Date();
              return `<tr>
              <td><a href="#/market/${m.id}" class="table-link">${escapeHtml(m.title)}</a></td>
              <td style="font-size:12px"><span class="badge badge-cat">${escapeHtml(m.category)}</span></td>
              <td class="ta-right mono">${(m.yes_price * 100).toFixed(0)}¢</td>
              <td class="ta-right mono">${fmt$(m.volume)}</td>
              <td class="ta-right">${m.traders}</td>
              <td class="ta-right">
                ${m.resolved_at
                  ? `<span class="badge badge-${m.resolution}">${m.resolution}</span>`
                  : (closed
                      ? '<span class="badge badge-closed">CLOSED</span>'
                      : '<span class="badge badge-open">OPEN</span>')}
              </td>
              <td class="ta-right">
                ${closed ? `<button class="btn btn-sm btn-secondary reopen-btn" data-mid="${m.id}">Reopen</button>` : ''}
              </td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`);

  // Attach reopen handlers
  document.querySelectorAll('.reopen-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const marketId = btn.dataset.mid;
      const minDate = new Date(Date.now() + 60*1000).toISOString().slice(0,16);
      const newTime = await showModal({
        title: 'Reopen Market',
        body: `
          <p>Set a new closing time (must be in the future):</p>
          <div class="form-group" style="margin-top:0">
            <input id="reopen-datetime" name="reopen-datetime" type="datetime-local"
              class="form-input" min="${minDate}">
          </div>`,
        confirmLabel: 'Reopen Market',
        confirmClass: 'btn-primary'
      });
      if (!newTime) return;

      btn.disabled = true; btn.textContent = 'Reopening…';
      const closesAt = new Date(newTime).toISOString();
      const { data, error } = await sb.rpc('reopen_market', {
        p_admin_id: app.user.id, p_market_id: marketId, p_new_closes_at: closesAt
      });

      if (error || data?.error) {
        toast(data?.error || error.message, 'error');
        btn.disabled = false; btn.textContent = 'Reopen';
        return;
      }
      toast(`Market reopened until ${fmtDatetime(data.new_closes_at)}`, 'success');
      await renderAdmin();
    });
  });
}

// ============================================================
// ROUTER
// ============================================================
function route() {
  renderNavbar();
  const hash = window.location.hash || '#/';

  if (!app.user) { renderLogin(); return; }

  if      (hash === '#/' || hash === '')       renderHome();
  else if (hash.startsWith('#/market/'))       renderMarket(hash.split('#/market/')[1].split('?')[0]);
  else if (hash === '#/create')                renderCreate();
  else if (hash === '#/portfolio')             renderPortfolio();
  else if (hash === '#/profile')               renderProfile();
  else if (hash === '#/admin')                 renderAdmin();
  else                                         renderHome();

  // Close any open nav dropdown/mobile menu
  const hamBtn = document.getElementById('nav-hamburger-btn');
  if (hamBtn) { hamBtn.classList.remove('active'); }
  document.getElementById('nav-mobile-menu')?.classList.remove('active');
  document.getElementById('nav-dropdown')?.classList.add('hidden');
}

// ============================================================
// INIT
// ============================================================
async function init() {
  attachGlobalHandlers();

  // Auth state listener — fires INITIAL_SESSION on page load
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') {
      if (session) {
        app.user = session.user;
        app.profile = await ensureProfile(session.user);
      }
      // Hide loader & start routing
      const loader = document.getElementById('loader');
      if (loader) { loader.style.opacity = '0'; setTimeout(() => loader.remove(), 300); }
      route();
      window.addEventListener('hashchange', route);

    } else if (event === 'SIGNED_IN' && !app.user) {
      // Magic link callback
      app.user    = session.user;
      app.profile = await ensureProfile(session.user);
      // Clear token fragments from URL hash
      window.location.hash = '#/';

    } else if (event === 'TOKEN_REFRESHED' && session) {
      app.user = session.user;

    } else if (event === 'SIGNED_OUT') {
      app.user = null; app.profile = null;
      renderNavbar();
      renderLogin();
    }
  });
}

init();
