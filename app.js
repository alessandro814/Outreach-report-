/* ─────────────────────────────────────────────────────
   Instantly Outreach Dashboard — app.js
───────────────────────────────────────────────────── */

let D = (typeof DASHBOARD_DATA !== 'undefined') ? DASHBOARD_DATA : { last_updated: '', campaigns: [], leads: [] };

// ── AI backend URL ────────────────────────────────────────────────────────────
// localhost  → talk to local Flask server on port 5000
// production → use Vercel's own /api/* serverless endpoints (same origin)
const _isLocal = window.location.hostname === 'localhost' ||
                 window.location.hostname === '127.0.0.1';
const AI_BASE_URL = _isLocal ? 'http://localhost:5000' : '';

// ── localStorage key for dashboard data cache ────────────────────────────────
const DATA_CACHE_KEY = 'instantly_dashboard_cache_v2';

// ── colours ──────────────────────────────────────────
const COLORS = {
  YES:            '#10b981',
  INTERESTED:     '#3b82f6',
  NO:             '#ef4444',
  NOT_INTERESTED: '#f59e0b',
  AUTO_REPLY:     '#8b5cf6',
};

// ── CRM Tag system ────────────────────────────────────────────────────────────
const TAGS = {
  'Free Affiliate':    { color: '#2563eb', bg: '#dbeafe', cls: 'tag-free-affiliate' },
  'Closed':            { color: '#059669', bg: '#d1fae5', cls: 'tag-closed' },
  'Said NO':           { color: '#dc2626', bg: '#fee2e2', cls: 'tag-said-no' },
  'LOST':              { color: '#6b7280', bg: '#f3f4f6', cls: 'tag-lost' },
  'Waiting for rates': { color: '#d97706', bg: '#fef3c7', cls: 'tag-waiting-rates' },
};
const TAG_LIST = Object.keys(TAGS);

// ── state ─────────────────────────────────────────────
// ── Date filter state ─────────────────────────────
let dateFilter = { mode: 'all', from: '', to: '' };

let leadsPage = 1;
const PER_PAGE = 50;

let leadsFilters = { search:'', campaign:'', classification:'', positiveOnly:false, autoOnly:false };
let leadsSort    = { col:'campaign_name', dir:'asc' };
let campSort     = { col:'health_score', dir:'desc' };

let noPage = 1;
const NO_PER_PAGE = 50;
let noFilters = { search:'', campaign:'', classification:'', category:'' };
let noSort    = { col:'campaign_name', dir:'asc' };

let hlPage = 1;
const HL_PER_PAGE = 50;
let hlFilters = { search: '', campaign: '', classification: '', reviewOnly: false };
let hlSort    = { col: 'classification', dir: 'asc' };

// ── Tag state ──────────────────────────────────────────────────────────────
let tagsMap = {};        // { email → { assigned_tag, notes, creator_handle, campaign_name, updated_at } }
let tagFilter = '';      // '' = no filter, or one of the TAG_LIST values
let tagsAvailable = true; // false if Supabase not configured

let chartDonut    = null;
let chartTopCamps = null;
let chartStacked  = null;

/* ═══════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await initData();
  showLastUpdated();
  startAutoRefresh();
  setupDateFilter();
  renderTodayMetrics();
  setupTabs();
  renderKPIs();
  renderOverviewCharts();
  renderRankingTable();
  populateCampaignFilter();
  renderCampaignTable();
  renderLeads();
  setupLeadsFilters();
  setupLeadsSort();
  setupEmailLookup();
  setupQuickLookup();
  renderHotLeadsKPIs();
  populateHlCampaignFilter();
  renderHotLeads();
  setupHlFilters();
  setupHlSort();
  renderNoReasonsKPIs();
  populateNoFilters();
  renderNoReasons();
  setupNoFilters();
  setupNoSort();
  renderZeroReplyCampaigns();
  setupAIChatInput();
  setupHandleLookup();
  checkAIStatus();
  // Set initial "Showing: All time" badge and populate debug panel counts
  const badge = document.getElementById('date-active-badge');
  if (badge) { badge.textContent = 'Showing: All time'; badge.style.display = ''; }
  updateDebugPanel();
  setupTagFilterBar();
  setupTagListeners();
  setupTagStatusFilter();
  loadAllTags();
});

/* ═══════════════════════════════════════════════════
   DATA LOADING — remote → localStorage → bundled
═══════════════════════════════════════════════════ */

function isValidData(d) {
  return d && typeof d === 'object' &&
    (Array.isArray(d.campaigns) && d.campaigns.length > 0 ||
     Array.isArray(d.leads)     && d.leads.length     > 0);
}

async function initData() {
  const remoteUrl = (typeof window.DASHBOARD_REMOTE_URL !== 'undefined')
    ? window.DASHBOARD_REMOTE_URL : '';

  let data    = null;
  let source  = 'bundled';
  let warning = null;

  // ── 1. Try remote source (Google Sheets via Apps Script) ──────────────────
  if (remoteUrl) {
    try {
      const resp = await fetch(remoteUrl, { cache: 'no-cache' });
      if (resp.ok) {
        const raw = await resp.json();
        if (raw && raw.error) {
          warning = `Remote source error: ${raw.error}`;
        } else if (isValidData(raw)) {
          data   = raw;
          source = 'remote';
          try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(raw)); } catch (_) {}
        } else {
          warning = 'Remote data returned empty dataset — using cached snapshot';
        }
      } else {
        warning = `Remote fetch returned HTTP ${resp.status} — using cached snapshot`;
      }
    } catch (e) {
      warning = 'Cannot reach remote data source — using cached snapshot';
    }
  }

  // ── 2. Try localStorage cache ─────────────────────────────────────────────
  if (!data) {
    try {
      const raw = localStorage.getItem(DATA_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isValidData(parsed)) {
          data   = parsed;
          source = 'cache';
          if (!warning && remoteUrl) warning = 'Showing cached data — remote source unavailable';
        }
      }
    } catch (_) {}
  }

  // ── 3. Fall back to bundled data.js ──────────────────────────────────────
  if (!data) {
    const bundled = (typeof DASHBOARD_DATA !== 'undefined') ? DASHBOARD_DATA : null;
    if (isValidData(bundled)) {
      data   = bundled;
      source = 'bundled';
      if (!warning && remoteUrl) warning = 'Showing bundled data — remote source and cache unavailable';
    } else {
      // All sources empty — still use bundled to avoid crash, show warning
      data   = bundled || { last_updated: '', campaigns: [], leads: [] };
      source = 'empty';
      warning = 'No data available yet — pipeline may not have run. Check back in a few minutes.';
    }
  }

  // ── Set global D ─────────────────────────────────────────────────────────
  D = window.D = data;

  // ── Update UI ────────────────────────────────────────────────────────────
  updateDataSourceUI(source, data.last_updated, warning);
}

function updateDataSourceUI(source, lastUpdated, warning) {
  // Badge in topbar
  const badge = document.getElementById('data-source-badge');
  if (badge) {
    const labels = {
      remote:  { text: '● Live',    cls: 'ds-live'    },
      cache:   { text: '● Cached',  cls: 'ds-cached'  },
      bundled: { text: '● Bundled', cls: 'ds-bundled' },
      empty:   { text: '● No data', cls: 'ds-error'   },
    };
    const { text, cls } = labels[source] || labels.bundled;
    badge.textContent  = text;
    badge.className    = `data-source-badge ${cls}`;
    badge.title        = lastUpdated ? `Data as of: ${lastUpdated}` : 'Data timestamp unknown';
  }

  // Warning banner
  const banner = document.getElementById('data-warning-banner');
  if (banner) {
    if (warning) {
      document.getElementById('data-warning-text').textContent = warning;
      const ageEl = document.getElementById('data-warning-age');
      if (ageEl && lastUpdated) ageEl.textContent = ` (snapshot: ${lastUpdated})`;
      banner.style.display = '';
    } else {
      banner.style.display = 'none';
    }
  }
}

/* ── Tabs ─────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.nav-tabs-custom button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tabs-custom button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
      if (btn.dataset.target === 'page-campaigns') renderStackedChart();
      if (btn.dataset.target === 'page-ai') checkAIStatus();
      if (btn.dataset.target === 'page-leadstatus') renderTagStatus();
    });
  });
}

/* ═══════════════════════════════════════════════════
   KPIs
═══════════════════════════════════════════════════ */
function renderKPIs() {
  const filtLeads    = applyDateFilter(D.leads);
  const totalYes     = filtLeads.filter(l => l.classification === 'YES').length;
  const totalInt     = filtLeads.filter(l => l.classification === 'INTERESTED').length;
  const totalNo      = filtLeads.filter(l => l.classification === 'NO').length;
  const totalNI      = filtLeads.filter(l => l.classification === 'NOT_INTERESTED').length;
  const totalAR      = filtLeads.filter(l => l.classification === 'AUTO_REPLY').length;
  const totalInbound = totalYes + totalInt + totalNo + totalNI + totalAR;
  const pos          = totalYes + totalInt;
  const neg          = totalNo  + totalNI;
  const activeCamps  = dateFilter.mode === 'all'
    ? D.campaigns.length
    : new Set(filtLeads.map(l => l.campaign_name)).size;

  set('kpi-camps',    activeCamps);
  set('kpi-leads',    D.leads.length.toLocaleString());
  set('kpi-inbound',  totalInbound);
  set('kpi-yes',      totalYes);
  set('kpi-int',      totalInt);
  set('kpi-no',       totalNo);
  set('kpi-ni',       totalNI);
  set('kpi-ar',       totalAR);
  set('kpi-pos-rate', totalInbound > 0 ? (pos/totalInbound*100).toFixed(1)+'%' : '0%');
  set('kpi-neg-rate', totalInbound > 0 ? (neg/totalInbound*100).toFixed(1)+'%' : '0%');
  set('kpi-zero',     D.campaigns.filter(x => x.total_inbound === 0).length);
}

function set(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

/* ═══════════════════════════════════════════════════
   OVERVIEW CHARTS
═══════════════════════════════════════════════════ */
function renderOverviewCharts() { renderDonut(); renderTopCampsChart(); }

function renderDonut() {
  const filtLeads = applyDateFilter(D.leads);
  const totals = {
    YES:            filtLeads.filter(l => l.classification === 'YES').length,
    INTERESTED:     filtLeads.filter(l => l.classification === 'INTERESTED').length,
    NO:             filtLeads.filter(l => l.classification === 'NO').length,
    NOT_INTERESTED: filtLeads.filter(l => l.classification === 'NOT_INTERESTED').length,
    AUTO_REPLY:     filtLeads.filter(l => l.classification === 'AUTO_REPLY').length,
  };
  if (chartDonut) { chartDonut.destroy(); chartDonut = null; }
  chartDonut = new Chart(document.getElementById('chartDonut').getContext('2d'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(totals).map(k => k.replace(/_/g,' ')),
      datasets: [{
        data: Object.values(totals),
        backgroundColor: Object.keys(totals).map(k => COLORS[k]),
        borderWidth: 2, borderColor: '#fff', hoverOffset: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 11, padding: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => {
              const t = ctx.dataset.data.reduce((a,b) => a+b, 0);
              return ` ${ctx.label}: ${ctx.raw} (${(ctx.raw/t*100).toFixed(1)}%)`;
            }
          }
        }
      }
    }
  });
}

function renderTopCampsChart() {
  const sorted = [...getFilteredCampaigns()]
    .filter(c => c.total_inbound > 0)
    .sort((a,b) => b.positive_total - a.positive_total)
    .slice(0, 20);

  if (chartTopCamps) { chartTopCamps.destroy(); chartTopCamps = null; }
  chartTopCamps = new Chart(document.getElementById('chartTopCamps').getContext('2d'), {
    type: 'bar',
    data: {
      labels: sorted.map(c => c.campaign_name),
      datasets: [
        { label:'YES',            data: sorted.map(c => c.yes),            backgroundColor: COLORS.YES },
        { label:'INTERESTED',     data: sorted.map(c => c.interested),     backgroundColor: COLORS.INTERESTED },
        { label:'NO',             data: sorted.map(c => c.no),             backgroundColor: COLORS.NO },
        { label:'NOT INTERESTED', data: sorted.map(c => c.not_interested), backgroundColor: COLORS.NOT_INTERESTED },
        { label:'AUTO REPLY',     data: sorted.map(c => c.auto_reply),     backgroundColor: COLORS.AUTO_REPLY },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      scales: {
        x: { stacked: true, grid: { color: '#f3f4f6' }, ticks: { font:{ size:11 } } },
        y: { stacked: true, ticks: { font:{ size:11 } } }
      },
      plugins: { legend: { position:'bottom', labels:{ boxWidth:11, padding:12, font:{size:11} } } }
    }
  });
}

function renderStackedChart() {
  const camps = [...getFilteredCampaigns()].filter(c => c.total_inbound > 0);
  if (chartStacked) { chartStacked.destroy(); chartStacked = null; }
  chartStacked = new Chart(document.getElementById('chartStacked').getContext('2d'), {
    type: 'bar',
    data: {
      labels: camps.map(c => c.campaign_name),
      datasets: [
        { label:'YES',            data: camps.map(c => c.yes),            backgroundColor: COLORS.YES },
        { label:'INTERESTED',     data: camps.map(c => c.interested),     backgroundColor: COLORS.INTERESTED },
        { label:'NO',             data: camps.map(c => c.no),             backgroundColor: COLORS.NO },
        { label:'NOT INTERESTED', data: camps.map(c => c.not_interested), backgroundColor: COLORS.NOT_INTERESTED },
        { label:'AUTO REPLY',     data: camps.map(c => c.auto_reply),     backgroundColor: COLORS.AUTO_REPLY },
      ]
    },
    options: {
      responsive: false, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { font:{ size:10 }, maxRotation:60 } },
        y: { stacked: true, grid: { color:'#f3f4f6' }, ticks: { font:{ size:11 } } }
      },
      plugins: { legend: { position:'bottom', labels:{ boxWidth:11, padding:12, font:{size:11} } } }
    }
  });
}

/* ═══════════════════════════════════════════════════
   RANKING TABLE (Overview)
═══════════════════════════════════════════════════ */
function renderRankingTable() {
  const top = [...getFilteredCampaigns()]
    .sort((a,b) => b.health_score - a.health_score)
    .slice(0, 15);

  document.querySelector('#rankTable tbody').innerHTML = top.map((c,i) => `
    <tr>
      <td style="color:#9ca3af;font-weight:700">#${i+1}</td>
      <td class="camp-name">${esc(c.campaign_name)}</td>
      <td>${c.total_inbound}</td>
      <td><span class="badge badge-YES">${c.yes}</span></td>
      <td><span class="badge badge-INTERESTED">${c.interested}</span></td>
      <td>${c.no > 0 ? `<span class="badge badge-NO">${c.no}</span>` : '—'}</td>
      <td style="font-weight:700;color:#10b981">${c.positive_total}</td>
      <td>
        <div class="rate-bar-wrap">
          <div class="rate-bar"><div class="rate-bar-fill" style="width:${c.positive_rate}%"></div></div>
          <span class="rate-val">${c.positive_rate}%</span>
        </div>
      </td>
      <td style="font-weight:700;color:#6366f1">${c.health_score}</td>
    </tr>
  `).join('');
}

/* ═══════════════════════════════════════════════════
   CAMPAIGN TABLE (sortable)
═══════════════════════════════════════════════════ */
function renderCampaignTable() {
  const thead = document.querySelector('#campTable thead tr');
  thead.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      campSort.dir = (campSort.col === col && campSort.dir === 'asc') ? 'desc' : 'asc';
      campSort.col = col;
      thead.querySelectorAll('th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(campSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      paintCampaignRows();
    });
    if (th.dataset.col === campSort.col) th.classList.add('sort-desc');
  });
  paintCampaignRows();
}

function paintCampaignRows() {
  const { col, dir } = campSort;
  const sorted = [...getFilteredCampaigns()].sort((a,b) => {
    const av = typeof a[col]==='string' ? a[col].toLowerCase() : a[col];
    const bv = typeof b[col]==='string' ? b[col].toLowerCase() : b[col];
    return dir==='asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });

  document.querySelector('#campTable tbody').innerHTML = sorted.map(c => `
    <tr>
      <td class="camp-name">${esc(c.campaign_name)}</td>
      <td>${c.total_inbound === 0 ? '<span class="zero-tag">0</span>' : c.total_inbound}</td>
      <td><span class="badge badge-YES">${c.yes}</span></td>
      <td><span class="badge badge-INTERESTED">${c.interested}</span></td>
      <td>${c.no > 0 ? `<span class="badge badge-NO">${c.no}</span>` : '—'}</td>
      <td>${c.not_interested > 0 ? `<span class="badge badge-NOT_INTERESTED">${c.not_interested}</span>` : '—'}</td>
      <td>${c.auto_reply > 0 ? `<span class="badge badge-AUTO_REPLY">${c.auto_reply}</span>` : '—'}</td>
      <td style="font-weight:700">${c.positive_total}</td>
      <td>
        <div class="rate-bar-wrap">
          <div class="rate-bar"><div class="rate-bar-fill" style="width:${c.positive_rate}%"></div></div>
          <span class="rate-val">${c.positive_rate}%</span>
        </div>
      </td>
      <td>
        <div class="rate-bar-wrap">
          <div class="rate-bar"><div class="rate-bar-fill neg" style="width:${c.negative_rate}%"></div></div>
          <span class="rate-val" style="color:#ef4444">${c.negative_rate}%</span>
        </div>
      </td>
      <td>
        <span class="rate-val" style="color:${(c.no_reply_rate||0) > 10 ? '#ef4444' : '#6b7280'}">${c.no_reply_rate||0}%</span>
      </td>
      <td style="font-weight:700;color:#6366f1">${c.health_score}</td>
    </tr>
  `).join('');
}

/* ═══════════════════════════════════════════════════
   LEADS EXPLORER — filters + sort + pagination
═══════════════════════════════════════════════════ */
function populateCampaignFilter() {
  const sel = document.getElementById('filterCampaign');
  [...new Set(D.leads.map(l => l.campaign_name))].sort().forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
}

function setupLeadsFilters() {
  document.getElementById('leadsSearch').addEventListener('input', e => {
    leadsFilters.search = e.target.value.trim().toLowerCase();
    leadsPage = 1; renderLeads();
  });
  document.getElementById('filterCampaign').addEventListener('change', e => {
    leadsFilters.campaign = e.target.value; leadsPage = 1; renderLeads();
  });
  document.getElementById('filterClass').addEventListener('change', e => {
    leadsFilters.classification = e.target.value; leadsPage = 1; renderLeads();
  });
  document.getElementById('btnPositive').addEventListener('click', e => {
    leadsFilters.positiveOnly = !leadsFilters.positiveOnly;
    e.target.classList.toggle('active', leadsFilters.positiveOnly);
    leadsFilters.autoOnly = false;
    document.getElementById('btnAuto').classList.remove('active');
    leadsPage = 1; renderLeads();
  });
  document.getElementById('btnAuto').addEventListener('click', e => {
    leadsFilters.autoOnly = !leadsFilters.autoOnly;
    e.target.classList.toggle('active', leadsFilters.autoOnly);
    leadsFilters.positiveOnly = false;
    document.getElementById('btnPositive').classList.remove('active');
    leadsPage = 1; renderLeads();
  });
  document.getElementById('btnReset').addEventListener('click', resetLeadsFilters);
}

function resetLeadsFilters() {
  leadsFilters = { search:'', campaign:'', classification:'', positiveOnly:false, autoOnly:false };
  document.getElementById('leadsSearch').value = '';
  document.getElementById('filterCampaign').value = '';
  document.getElementById('filterClass').value = '';
  document.getElementById('btnPositive').classList.remove('active');
  document.getElementById('btnAuto').classList.remove('active');
  leadsPage = 1; renderLeads();
}

function setupLeadsSort() {
  document.querySelectorAll('#leadsTable thead th[data-lcol]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.lcol;
      leadsSort.dir = (leadsSort.col === col && leadsSort.dir === 'asc') ? 'desc' : 'asc';
      leadsSort.col = col;
      document.querySelectorAll('#leadsTable thead th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(leadsSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      leadsPage = 1; renderLeads();
    });
  });
}

function filteredLeads() {
  const { search, campaign, classification, positiveOnly, autoOnly } = leadsFilters;
  let data = applyDateFilter(D.leads).filter(l => {
    if (campaign       && l.campaign_name !== campaign)        return false;
    if (classification && l.classification !== classification) return false;
    if (positiveOnly   && !['YES','INTERESTED'].includes(l.classification)) return false;
    if (autoOnly       && l.classification !== 'AUTO_REPLY')   return false;
    if (search) {
      const hay = (l.email+(l.creator_handle||'')+l.campaign_name+l.classification+l.reason+l.reply_text).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // sort
  const { col, dir } = leadsSort;
  data.sort((a,b) => {
    const av = (a[col]||'').toLowerCase();
    const bv = (b[col]||'').toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  return data;
}

function renderLeads() {
  const data  = filteredLeads();
  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  leadsPage   = Math.min(leadsPage, pages);
  const slice = data.slice((leadsPage-1)*PER_PAGE, leadsPage*PER_PAGE);

  document.getElementById('leadsCount').textContent = `${total.toLocaleString()} leads`;

  const tbody = document.querySelector('#leadsTable tbody');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#9ca3af;padding:36px">No leads match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = slice.map(l => {
      const hotBadge  = l.hot_lead ? ' <span class="hot-tag">🔥 hot</span>' : '';
      const tsDisplay = l.timestamp ? `<div class="lead-ts">${esc(l.timestamp.slice(0,10))}</div>` : '';
      const reasonDisplay = l.decline_category
        ? `<span class="decline-cat">${esc(l.decline_category)}</span><br><small>${esc(l.reason)}</small>`
        : esc(l.reason);
      const summary = l.clean_reply_summary || l.reply_text || '';
      const handleCell = l.creator_handle
        ? `<span class="handle-tag">@${esc(l.creator_handle)}</span>`
        : '<span style="color:#d1d5db">—</span>';
      return `
        <tr>
          <td style="white-space:nowrap">${handleCell}</td>
          <td style="font-weight:600;color:#111827;white-space:nowrap">${esc(l.email)}${tsDisplay}</td>
          <td class="camp-name">${esc(l.campaign_name)}</td>
          <td><span class="badge badge-${l.classification}">${l.classification.replace(/_/g,' ')}</span>${hotBadge}${l.is_fallback ? ' <span class="fallback-tag">review</span>' : ''}</td>
          <td class="reason-cell">${reasonDisplay}</td>
          <td class="reply-cell" title="${esc(l.reply_text)}">${esc(summary)||'<span style="color:#d1d5db">—</span>'}</td>
          <td>${tagSelectHtml(l)}</td>
          <td style="text-align:center"><button class="btn-ai-sm" onclick="openAIPanel('${esc(l.email)}','${esc(l.campaign_name)}')">✦</button></td>
        </tr>
      `;
    }).join('');
  }
  // Apply tag select styles
  document.querySelectorAll('#leadsTable .tag-select').forEach(sel => styleTagSelect(sel, sel.value));
  renderPagination(pages);
}

function renderPagination(pages) {
  const bar = document.getElementById('leadsPagination');
  const cur = leadsPage;
  let html = `<span class="pagination-info">Page ${cur} of ${pages}</span>`;
  html += btn('«', 1,         cur===1);
  html += btn('‹', cur-1,     cur===1);
  for (let p = Math.max(1, cur-2); p <= Math.min(pages, cur+2); p++)
    html += `<button class="${p===cur?'current':''}" onclick="gotoPage(${p})">${p}</button>`;
  html += btn('›', cur+1,     cur===pages);
  html += btn('»', pages,     cur===pages);
  bar.innerHTML = html;
}
function btn(label, p, disabled) {
  return `<button ${disabled?'disabled':''} onclick="gotoPage(${p})">${label}</button>`;
}
function gotoPage(p) { leadsPage = p; renderLeads(); }

/* ═══════════════════════════════════════════════════
   DOWNLOAD CSV
═══════════════════════════════════════════════════ */
function downloadLeadsCSV() {
  const data = filteredLeads();
  const rows = [['email','campaign_name','classification','reason','reply_text']];
  data.forEach(l => rows.push([
    csvCell(l.email),
    csvCell(l.campaign_name),
    csvCell(l.classification),
    csvCell(l.reason),
    csvCell(l.reply_text),
  ]));
  triggerDownload(rows.map(r => r.join(',')).join('\n'), 'instantly_leads_filtered.csv');
}

function downloadCampaignCSV() {
  const { col, dir } = campSort;
  const data = [...D.campaigns].sort((a,b) => {
    const av = typeof a[col]==='string' ? a[col].toLowerCase() : a[col];
    const bv = typeof b[col]==='string' ? b[col].toLowerCase() : b[col];
    return dir==='asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
  const rows = [['campaign_name','total_inbound','yes','interested','no','not_interested','auto_reply','positive_total','positive_rate','negative_rate','no_reply_rate','health_score']];
  data.forEach(c => rows.push([
    csvCell(c.campaign_name), c.total_inbound, c.yes, c.interested,
    c.no, c.not_interested, c.auto_reply, c.positive_total,
    c.positive_rate+'%', c.negative_rate+'%', (c.no_reply_rate||0)+'%', c.health_score,
  ]));
  triggerDownload(rows.map(r => r.join(',')).join('\n'), 'instantly_campaigns.csv');
}

function csvCell(v) {
  const s = String(v||'').replace(/"/g,'""');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
}

function triggerDownload(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ═══════════════════════════════════════════════════
   EMAIL LOOKUP — full page
═══════════════════════════════════════════════════ */
function setupEmailLookup() {
  document.getElementById('lookupBtn').addEventListener('click', doLookup);
  document.getElementById('lookupInput').addEventListener('keydown', e => { if (e.key==='Enter') doLookup(); });
}

function _emailLookupScore(l, q) {
  // Score a lead against a query across all relevant fields
  const emailNorm   = l.email.toLowerCase().trim();
  const emailLocal  = emailNorm.split('@')[0];
  const handleNorm  = (l.creator_handle || '').toLowerCase().replace(/^@+/, '').trim();
  const replyNorm   = (l.reply_text || '').toLowerCase();
  const summaryNorm = (l.clean_reply_summary || '').toLowerCase();
  // _fuzzyScore and _normalizeHandle are defined in the Handle Lookup section (hoisted)
  return Math.max(
    _fuzzyScore(emailNorm, q),
    _fuzzyScore(emailLocal, q),
    _fuzzyScore(handleNorm, q),
    replyNorm.includes(q) ? 0.3 : 0,
    summaryNorm.includes(q) ? 0.2 : 0
  );
}

function doLookup() {
  const raw = document.getElementById('lookupInput').value.trim();
  const q   = raw.toLowerCase().trim();
  const out = document.getElementById('lookup-results');
  if (!q) { out.innerHTML = ''; return; }

  // Always search full D.leads — NEVER the date-filtered or tag-filtered subset
  const allLeads = D.leads;

  const scored = allLeads
    .map(l => ({ l, score: _emailLookupScore(l, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const hits    = scored.filter(x => x.score >= 0.5).map(x => x.l);
  const similar = scored.filter(x => x.score > 0 && x.score < 0.5).map(x => x.l).slice(0, 5);

  const lastUpd = D.last_updated ? ` &middot; Updated: <b>${esc(D.last_updated)}</b>` : '';
  const debugHtml = `
    <div class="handle-debug">
      Dataset: <b>${allLeads.length.toLocaleString()}</b> leads (full, unfiltered)${lastUpd}
      &nbsp;|&nbsp; Searched: email · email-local · creator_handle · reply text
      &nbsp;|&nbsp; Query: <code>${esc(q)}</code>
      &nbsp;|&nbsp; Hits: <b>${hits.length}</b> &middot; Similar: <b>${similar.length}</b>
    </div>`;

  if (!hits.length && !similar.length) {
    out.innerHTML = debugHtml + `<div class="lookup-empty">
      No result for <strong>${esc(raw)}</strong> in the production dataset (${allLeads.length.toLocaleString()} leads).<br>
      <small style="color:#d97706;display:block;margin-top:6px">
        If this creator should exist, the dataset may be incomplete — old fetches only retrieved the first 100 replies per campaign.
        Re-run <code>run_all.sh</code> to fetch full historical data from Instantly.
      </small>
    </div>`;
    return;
  }

  let html = debugHtml;
  if (hits.length) {
    html += `<div class="handle-section-label">${hits.length} result${hits.length > 1 ? 's' : ''} for <strong>${esc(raw)}</strong></div>`;
    html += hits.map(_renderHitCard).join('');
  }
  if (similar.length) {
    html += `<div class="handle-section-label" style="margin-top:12px;color:#6b7280">Similar matches</div>`;
    html += similar.map(_renderHitCard).join('');
  }
  out.innerHTML = html;
}

/* ── Quick lookup (overview card) ─────────────────── */
function setupQuickLookup() {
  const input  = document.getElementById('quickLookupInput');
  const btn    = document.getElementById('quickLookupBtn');
  const clear  = document.getElementById('quickLookupClear');
  const out    = document.getElementById('quick-lookup-results');

  function run() {
    const q = input.value.trim().toLowerCase();
    if (!q) { out.innerHTML = ''; clear.style.display = 'none'; return; }
    clear.style.display = '';
    // Quick lookup also searches full D.leads across all fields
    const hits = D.leads.filter(l => _emailLookupScore(l, q) >= 0.5);
    renderHits(hits, out, q);
  }

  btn.addEventListener('click', run);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  clear.addEventListener('click', () => {
    input.value = ''; out.innerHTML = ''; clear.style.display = 'none';
  });
}

/* ── Shared hit renderer (used by quick lookup and renderHits callers) ── */
function renderHits(hits, container, q) {
  if (!hits.length) {
    container.innerHTML = `<div class="lookup-empty">No result matching <strong>${esc(q)}</strong> found.</div>`;
    return;
  }
  container.innerHTML = hits.map(_renderHitCard).join('');
}

/* ── utils ────────────────────────────────────────── */
function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

/* ═══════════════════════════════════════════════════
   HOT LEADS
═══════════════════════════════════════════════════ */

function renderHotLeadsKPIs() {
  const hot = applyDateFilter(D.leads).filter(l => l.classification === 'YES' || l.classification === 'INTERESTED');
  set('hl-total',  hot.length);
  set('hl-yes',    hot.filter(l => l.classification === 'YES').length);
  set('hl-int',    hot.filter(l => l.classification === 'INTERESTED').length);
  set('hl-review', hot.filter(l => l.is_fallback).length);
}

function populateHlCampaignFilter() {
  const sel = document.getElementById('hlFilterCampaign');
  const campaigns = [...new Set(
    D.leads
      .filter(l => l.classification === 'YES' || l.classification === 'INTERESTED')
      .map(l => l.campaign_name)
  )].sort();
  campaigns.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });
}

function setupHlFilters() {
  document.getElementById('hlSearch').addEventListener('input', e => {
    hlFilters.search = e.target.value.trim().toLowerCase();
    hlPage = 1; renderHotLeads();
  });
  document.getElementById('hlFilterCampaign').addEventListener('change', e => {
    hlFilters.campaign = e.target.value; hlPage = 1; renderHotLeads();
  });
  document.getElementById('hlFilterClass').addEventListener('change', e => {
    hlFilters.classification = e.target.value; hlPage = 1; renderHotLeads();
  });
  document.getElementById('hlBtnReview').addEventListener('click', e => {
    hlFilters.reviewOnly = !hlFilters.reviewOnly;
    e.target.classList.toggle('active', hlFilters.reviewOnly);
    hlPage = 1; renderHotLeads();
  });
  document.getElementById('hlBtnReset').addEventListener('click', () => {
    hlFilters = { search: '', campaign: '', classification: '', reviewOnly: false };
    document.getElementById('hlSearch').value = '';
    document.getElementById('hlFilterCampaign').value = '';
    document.getElementById('hlFilterClass').value = '';
    document.getElementById('hlBtnReview').classList.remove('active');
    hlPage = 1; renderHotLeads();
  });
}

function setupHlSort() {
  document.querySelectorAll('#hlTable thead th[data-hlcol]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.hlcol;
      hlSort.dir = (hlSort.col === col && hlSort.dir === 'asc') ? 'desc' : 'asc';
      hlSort.col = col;
      document.querySelectorAll('#hlTable thead th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(hlSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      hlPage = 1; renderHotLeads();
    });
  });
}

function filteredHotLeads() {
  const { search, campaign, classification, reviewOnly } = hlFilters;
  let data = applyDateFilter(D.leads).filter(l => {
    if (l.classification !== 'YES' && l.classification !== 'INTERESTED') return false;
    if (campaign       && l.campaign_name !== campaign)        return false;
    if (classification && l.classification !== classification) return false;
    if (reviewOnly     && !l.is_fallback)                      return false;
    if (search) {
      const hay = (l.email+(l.creator_handle||'')+l.campaign_name+l.classification+l.reply_text).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const { col, dir } = hlSort;
  data.sort((a, b) => {
    const av = (a[col] || '').toString().toLowerCase();
    const bv = (b[col] || '').toString().toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  return data;
}

function renderHotLeads() {
  const data  = filteredHotLeads();
  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / HL_PER_PAGE));
  hlPage      = Math.min(hlPage, pages);
  const slice = data.slice((hlPage - 1) * HL_PER_PAGE, hlPage * HL_PER_PAGE);

  document.getElementById('hlCount').textContent = `${total.toLocaleString()} leads`;

  const tbody = document.querySelector('#hlTable tbody');
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:36px">No hot leads match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = slice.map(l => {
      const reviewTag  = l.is_fallback ? ' <span class="fallback-tag">review</span>' : '';
      const handleCell = l.creator_handle
        ? `<span class="handle-tag">@${esc(l.creator_handle)}</span>`
        : '<span style="color:#d1d5db">—</span>';
      return `
        <tr>
          <td style="white-space:nowrap">${handleCell}</td>
          <td style="font-weight:600;color:#111827;white-space:nowrap">${esc(l.email)}</td>
          <td class="camp-name">${esc(l.campaign_name)}</td>
          <td><span class="badge badge-${l.classification}">${l.classification.replace(/_/g,' ')}</span>${reviewTag}</td>
          <td class="reply-cell" title="${esc(l.reply_text)}">${esc(l.reply_text) || '<span style="color:#d1d5db">—</span>'}</td>
          <td style="text-align:center"><button class="btn-copy" onclick="copyEmail(this,'${esc(l.email)}')">Copy</button></td>
          <td style="text-align:center"><button class="btn-ai-sm" onclick="openAIPanel('${esc(l.email)}','${esc(l.campaign_name)}')">✦</button></td>
        </tr>
      `;
    }).join('');
  }
  renderHlPagination(pages);
}

function renderHlPagination(pages) {
  const bar = document.getElementById('hlPagination');
  const cur = hlPage;
  let html = `<span class="pagination-info">Page ${cur} of ${pages}</span>`;
  html += hlBtn('«', 1,       cur === 1);
  html += hlBtn('‹', cur - 1, cur === 1);
  for (let p = Math.max(1, cur - 2); p <= Math.min(pages, cur + 2); p++)
    html += `<button class="${p === cur ? 'current' : ''}" onclick="hlGotoPage(${p})">${p}</button>`;
  html += hlBtn('›', cur + 1, cur === pages);
  html += hlBtn('»', pages,   cur === pages);
  bar.innerHTML = html;
}
function hlBtn(label, p, disabled) {
  return `<button ${disabled ? 'disabled' : ''} onclick="hlGotoPage(${p})">${label}</button>`;
}
function hlGotoPage(p) { hlPage = p; renderHotLeads(); }

/* ── Copy utilities ───────────────────────────────── */
function copyToClipboard(text) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

function copyEmail(btn, email) {
  copyToClipboard(email).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
}

function copyAllHotEmails() {
  const data   = filteredHotLeads();
  const emails = [...new Set(data.map(l => l.email))].join('\n');
  const btn    = document.getElementById('hlCopyAllBtn');
  copyToClipboard(emails).then(() => {
    const orig = btn.textContent;
    btn.textContent = `Copied ${data.length} emails!`;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
  });
}

function downloadHotLeadsCSV() {
  const data = filteredHotLeads();
  const rows = [['email', 'campaign_name', 'classification', 'is_fallback', 'reply_text']];
  data.forEach(l => rows.push([
    csvCell(l.email), csvCell(l.campaign_name),
    csvCell(l.classification), l.is_fallback ? 'true' : 'false',
    csvCell(l.reply_text),
  ]));
  triggerDownload(rows.map(r => r.join(',')).join('\n'), 'hot_leads.csv');
}

/* ═══════════════════════════════════════════════════
   AI — SHARED STATE
═══════════════════════════════════════════════════ */

let currentAILead     = null;
let currentAICampaign = null;
let aiChatHistory     = [];

/* ═══════════════════════════════════════════════════
   AI — SSE STREAMING HELPER
═══════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════
   AI STATUS
═══════════════════════════════════════════════════ */

async function checkAIStatus() {
  renderAIStatus('checking', '');
  try {
    const resp = await fetch(AI_BASE_URL + '/api/health', { method: 'GET' });
    if (!resp.ok) { renderAIStatus('offline', 'Backend returned an error'); return; }
    const data = await resp.json();
    if (!data.anthropic_configured) {
      renderAIStatus('no_key', 'Set ANTHROPIC_API_KEY on the backend');
    } else {
      renderAIStatus('online', data.last_data_refresh ? 'Data: ' + data.last_data_refresh : '');
    }
  } catch (_) {
    renderAIStatus('disconnected', 'Run: python3 server.py');
  }
}

function renderAIStatus(state, detail) {
  const el = document.getElementById('ai-status-bar');
  if (!el) return;
  const map = {
    checking:     { text: 'Checking AI…',        cls: 'checking' },
    online:       { text: 'AI online',            cls: 'online'   },
    offline:      { text: 'AI offline',           cls: 'offline'  },
    no_key:       { text: 'Missing API key',      cls: 'nokey'    },
    disconnected: { text: 'Backend disconnected', cls: 'offline'  },
  };
  const { text, cls } = map[state] || map.offline;
  el.className = 'ai-status-bar ai-status-' + cls;
  el.innerHTML =
    `<span class="ai-status-dot"></span>` +
    `<span class="ai-status-text">${text}</span>` +
    (detail ? `<span class="ai-status-detail">${esc(detail)}</span>` : '');
}

function friendlyError(msg) {
  if (!msg) return 'Unknown error';
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('net::')) {
    return 'Cannot reach backend. Make sure server.py is running on port 5000.';
  }
  try { const j = JSON.parse(msg); if (j.error) return j.error; } catch (_) {}
  return msg;
}

/* ═══════════════════════════════════════════════════
   STREAMING HELPER
═══════════════════════════════════════════════════ */

async function streamFromAPI(url, body, onChunk, onDone, onError) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      let msg = await resp.text();
      try { msg = JSON.parse(msg).error || msg; } catch (_) {}
      if (onError) onError(friendlyError(msg));
      return;
    }
    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') { onDone(); return; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) { if (onError) onError(parsed.error); return; }
            if (parsed.text)  onChunk(parsed.text);
          } catch (_) {}
        }
      }
    }
    onDone();
  } catch (e) {
    if (onError) onError(friendlyError(e.message));
  }
}

/* ═══════════════════════════════════════════════════
   AI PANEL — OPEN / CLOSE
═══════════════════════════════════════════════════ */

function openAIPanel(email, campName) {
  const lead = D.leads.find(l => l.email === email && l.campaign_name === campName)
            || D.leads.find(l => l.email === email);
  if (!lead) return;

  const campaign = D.campaigns.find(c => c.campaign_name === lead.campaign_name) || {};
  currentAILead     = lead;
  currentAICampaign = campaign;

  /* ── Lead header ── */
  document.getElementById('ai-lead-info').innerHTML = `
    <div class="ai-lead-email">${esc(lead.email)}</div>
    <div class="ai-lead-meta">
      <span class="badge badge-${lead.classification}">${lead.classification.replace(/_/g,' ')}</span>
      <span class="ai-lead-camp">${esc(lead.campaign_name)}</span>
      ${lead.is_fallback ? '<span class="fallback-tag">review</span>' : ''}
    </div>
    ${lead.reply_text
      ? `<div class="ai-lead-reply">${esc(lead.reply_text.slice(0, 220))}${lead.reply_text.length > 220 ? '…' : ''}</div>`
      : ''}
  `;

  /* ── Reset reply section ── */
  document.getElementById('ai-reply-textarea').value   = '';
  document.getElementById('ai-reply-instruction').value = '';
  const genBtn = document.getElementById('ai-generate-btn');
  genBtn.textContent = 'Generate Reply';
  genBtn.disabled    = false;

  /* ── Open panel ── */
  document.getElementById('ai-panel').classList.add('open');
  document.getElementById('ai-panel-overlay').classList.add('open');
  document.body.classList.add('ai-panel-open');

  /* ── Auto-analyse ── */
  runAnalysis(lead.email, lead.campaign_name);
}

function closeAIPanel() {
  document.getElementById('ai-panel').classList.remove('open');
  document.getElementById('ai-panel-overlay').classList.remove('open');
  document.body.classList.remove('ai-panel-open');
  currentAILead     = null;
  currentAICampaign = null;
}

/* ═══════════════════════════════════════════════════
   AI PANEL — ANALYSIS
═══════════════════════════════════════════════════ */

async function runAnalysis(email, campaignName) {
  const el = document.getElementById('ai-analysis-content');
  el.innerHTML = '<div class="ai-loading"><span class="ai-spinner"></span> Analysing…</div>';
  try {
    const resp = await fetch(AI_BASE_URL + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, campaign_name: campaignName }),
    });
    if (!resp.ok) {
      let msg = await resp.text();
      try { msg = JSON.parse(msg).error || msg; } catch (_) {}
      el.innerHTML = `<div class="ai-error">${esc(friendlyError(msg))}</div>`;
      return;
    }
    const data = await resp.json();
    renderAnalysis(data);
  } catch (e) {
    el.innerHTML = `<div class="ai-error">${esc(friendlyError(e.message))}</div>`;
  }
}

function renderAnalysis(a) {
  const el = document.getElementById('ai-analysis-content');

  const sentimentColors = { hot:'#ef4444', warm:'#f59e0b', cold:'#6b7280', neutral:'#6366f1' };
  const priorityColors  = { high:'#ef4444', medium:'#f59e0b', low:'#10b981' };
  const urgencyIcons    = { 'reply today':'🔥', 'reply this week':'📅', 'low priority':'💤', 'do not contact':'🚫' };

  const sc = sentimentColors[a.sentiment]  || '#6b7280';
  const pc = priorityColors[a.priority]    || '#6b7280';
  const ui = urgencyIcons[a.urgency]       || '⏰';

  el.innerHTML = `
    <div class="ai-badges-row">
      <span class="ai-badge" style="background:${sc}18;color:${sc};border-color:${sc}40">${a.sentiment || '—'}</span>
      <span class="ai-badge" style="background:${pc}18;color:${pc};border-color:${pc}40">${a.priority || '—'} priority</span>
      <span class="ai-badge ai-badge-neutral">${ui} ${a.urgency || '—'}</span>
    </div>
    ${a.key_signals?.length
      ? `<div class="ai-signals">${a.key_signals.map(s => `<span class="ai-signal">${esc(s)}</span>`).join('')}</div>`
      : ''}
    <div class="ai-approach">${esc(a.approach || '')}</div>
  `;
}

/* ═══════════════════════════════════════════════════
   AI PANEL — DRAFT REPLY
═══════════════════════════════════════════════════ */

function generateReply(followup = false) {
  if (!currentAILead) return;

  const textarea    = document.getElementById('ai-reply-textarea');
  const genBtn      = document.getElementById('ai-generate-btn');
  const instruction = document.getElementById('ai-reply-instruction').value.trim();

  textarea.value    = '';
  genBtn.disabled   = true;
  genBtn.textContent = 'Generating…';

  streamFromAPI(
    AI_BASE_URL + '/api/reply',
    { email: currentAILead.email, campaign_name: currentAILead.campaign_name, instruction, followup },
    text  => { textarea.value += text; },
    ()    => { genBtn.disabled = false; genBtn.textContent = 'Regenerate'; },
    err   => { textarea.value = `Error: ${err}`; genBtn.disabled = false; genBtn.textContent = 'Try Again'; },
  );
}

function copyReply() {
  const text = document.getElementById('ai-reply-textarea').value;
  if (!text) return;
  copyToClipboard(text).then(() => {
    const btn = document.getElementById('ai-copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

/* ═══════════════════════════════════════════════════
   AI PANEL — RECOMMEND-REPLY (combined)
═══════════════════════════════════════════════════ */

async function runRecommendReply() {
  if (!currentAILead) return;
  const el      = document.getElementById('ai-rec-reply-content');
  const btn     = document.getElementById('ai-rec-reply-btn');
  const lead    = currentAILead;
  if (!el || !btn) return;

  btn.disabled = true;
  el.innerHTML = '<div class="ai-loading"><span class="ai-spinner"></span> Getting recommendation…</div>';

  try {
    const resp = await fetch(AI_BASE_URL + '/api/recommend-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:          lead.email,
        campaign_name:  lead.campaign_name,
        classification: lead.classification,
        reply_text:     lead.reply_text  || '',
        reason:         lead.reason      || '',
      }),
    });
    if (!resp.ok) {
      let msg = await resp.text();
      try { msg = JSON.parse(msg).error || msg; } catch (_) {}
      el.innerHTML = `<div class="ai-error">${esc(friendlyError(msg))}</div>`;
      btn.disabled = false;
      return;
    }
    const d = await resp.json();
    const conf = d.confidence != null ? Math.round(d.confidence * 100) + '%' : '—';
    const hot  = d.hot_lead ? '<span class="badge badge-YES">HOT</span>' : '';
    el.innerHTML = `
      <div class="ai-rec-reply-row"><strong>Interpretation:</strong> ${esc(d.interpretation || '—')}</div>
      <div class="ai-rec-reply-row">
        <strong>Action:</strong> ${esc(d.recommended_action || '—')}
        &nbsp;${hot}&nbsp;<span class="ai-rec-conf">Confidence: ${conf}</span>
      </div>
      <div class="ai-rec-reply-label">Suggested reply:</div>
      <textarea class="ai-reply-textarea" style="height:120px" readonly>${esc(d.suggested_reply || '')}</textarea>
      <button class="btn-ai-ghost" style="margin-top:6px" onclick="
        navigator.clipboard.writeText(document.querySelector('#ai-rec-reply-content textarea').value);
        this.textContent='Copied!'; setTimeout(()=>this.textContent='Copy reply',1500)
      ">Copy reply</button>
    `;
  } catch (e) {
    el.innerHTML = `<div class="ai-error">${esc(friendlyError(e.message))}</div>`;
  }
  btn.disabled = false;
}

/* ═══════════════════════════════════════════════════
   AI RECOMMENDATIONS
═══════════════════════════════════════════════════ */

async function loadRecommendations() {
  const btn     = document.getElementById('ai-rec-btn');
  const content = document.getElementById('ai-rec-content');

  btn.disabled   = true;
  btn.textContent = '✦ Loading…';
  content.innerHTML = '<div class="ai-loading"><span class="ai-spinner"></span> Getting AI recommendations…</div>';

  try {
    const resp = await fetch(AI_BASE_URL + '/api/recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!resp.ok) {
      let msg = await resp.text();
      try { msg = JSON.parse(msg).error || msg; } catch (_) {}
      content.innerHTML = `<div class="ai-error">${esc(friendlyError(msg))}</div>`;
      btn.disabled = false; btn.textContent = '✦ Refresh';
      return;
    }
    const data = await resp.json();
    renderRecommendations(data.recommendations || []);
  } catch (e) {
    content.innerHTML = `<div class="ai-error">${esc(friendlyError(e.message))}</div>`;
  }

  btn.disabled    = false;
  btn.textContent = '✦ Refresh';
}

function renderRecommendations(recs) {
  const content = document.getElementById('ai-rec-content');
  if (!recs.length) {
    content.innerHTML = '<div class="ai-rec-empty">No recommendations returned.</div>';
    return;
  }
  content.innerHTML = `<div class="ai-rec-grid">${recs.map((r, i) => `
    <div class="ai-rec-card">
      <div class="ai-rec-rank">#${i + 1}</div>
      <div class="ai-rec-body">
        <div class="ai-rec-top">
          <span class="ai-rec-email">${esc(r.email)}</span>
          <span class="ai-rec-score">${r.priority_score}/10</span>
        </div>
        <div class="ai-rec-campaign">${esc(r.campaign_name)}</div>
        <div class="ai-rec-reason">${esc(r.reason)}</div>
        <div class="ai-rec-action">→ ${esc(r.action)}</div>
      </div>
      <button class="btn-ai-outline" onclick="openAIPanel('${esc(r.email)}','${esc(r.campaign_name)}')">Reply</button>
    </div>
  `).join('')}</div>`;
}

/* ═══════════════════════════════════════════════════
   AI ASSISTANT — CHAT
═══════════════════════════════════════════════════ */

function setupAIChatInput() {
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
}

function sendChatMessage() {
  const input = document.getElementById('ai-chat-input');
  const msg   = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.style.height = 'auto';

  appendChatBubble('user', msg);
  aiChatHistory.push({ role: 'user', content: msg });

  const sendBtn = document.getElementById('ai-chat-send');
  sendBtn.disabled = true;

  const aiBubble = appendChatBubble('ai', '');
  let aiText = '';

  streamFromAPI(
    AI_BASE_URL + '/api/chat',
    { message: msg, history: aiChatHistory.slice(-8) },
    text => {
      aiText += text;
      aiBubble.textContent = aiText;
      scrollChatBottom();
    },
    () => {
      aiChatHistory.push({ role: 'assistant', content: aiText });
      sendBtn.disabled = false;
    },
    err => {
      aiBubble.textContent = friendlyError(err);
      sendBtn.disabled = false;
    },
  );
}

function appendChatBubble(role, text) {
  const messages = document.getElementById('ai-chat-messages');
  const div = document.createElement('div');
  div.className = `ai-chat-msg ai-chat-msg-${role}`;
  div.textContent = text || (role === 'ai' ? '…' : '');
  messages.appendChild(div);
  scrollChatBottom();
  return div;
}

function scrollChatBottom() {
  const el = document.getElementById('ai-chat-messages');
  el.scrollTop = el.scrollHeight;
}

/* ═══════════════════════════════════════════════════
   NO REASONS PAGE
═══════════════════════════════════════════════════ */

function negativeLeads() {
  return D.leads.filter(l => l.classification === 'NO' || l.classification === 'NOT_INTERESTED');
}

function renderNoReasonsKPIs() {
  const neg  = applyDateFilter(negativeLeads());
  const nos  = neg.filter(l => l.classification === 'NO').length;
  const nis  = neg.filter(l => l.classification === 'NOT_INTERESTED').length;

  // Count by decline category
  const cats = {};
  neg.forEach(l => {
    const c = l.decline_category || 'Other';
    cats[c] = (cats[c] || 0) + 1;
  });
  const topCat = Object.entries(cats).sort((a,b) => b[1]-a[1])[0];

  const container = document.getElementById('no-reasons-kpis');
  if (!container) return;
  container.innerHTML = `
    <div class="kpi-card kpi-no">
      <div class="kpi-label">Total Negative</div>
      <div class="kpi-value">${neg.length}</div>
    </div>
    <div class="kpi-card kpi-no">
      <div class="kpi-label">Hard NO</div>
      <div class="kpi-value">${nos}</div>
    </div>
    <div class="kpi-card kpi-ni">
      <div class="kpi-label">NOT INTERESTED</div>
      <div class="kpi-value">${nis}</div>
    </div>
    ${topCat ? `
    <div class="kpi-card kpi-total">
      <div class="kpi-label">Top Decline Reason</div>
      <div class="kpi-value" style="font-size:1rem">${esc(topCat[0])}</div>
      <div class="kpi-sub">${topCat[1]} leads</div>
    </div>` : ''}
  `;
}

function populateNoFilters() {
  const campaigns = [...new Set(negativeLeads().map(l => l.campaign_name))].sort();
  const sel = document.getElementById('noFilterCampaign');
  campaigns.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    sel.appendChild(o);
  });

  const categories = [...new Set(negativeLeads().map(l => l.decline_category).filter(Boolean))].sort();
  const catSel = document.getElementById('noFilterCategory');
  categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });
}

function setupNoFilters() {
  document.getElementById('noSearch').addEventListener('input', e => {
    noFilters.search = e.target.value.trim().toLowerCase();
    noPage = 1; renderNoReasons();
  });
  document.getElementById('noFilterCampaign').addEventListener('change', e => {
    noFilters.campaign = e.target.value; noPage = 1; renderNoReasons();
  });
  document.getElementById('noFilterClass').addEventListener('change', e => {
    noFilters.classification = e.target.value; noPage = 1; renderNoReasons();
  });
  document.getElementById('noFilterCategory').addEventListener('change', e => {
    noFilters.category = e.target.value; noPage = 1; renderNoReasons();
  });
  document.getElementById('noBtnReset').addEventListener('click', () => {
    noFilters = { search:'', campaign:'', classification:'', category:'' };
    document.getElementById('noSearch').value = '';
    document.getElementById('noFilterCampaign').value = '';
    document.getElementById('noFilterClass').value = '';
    document.getElementById('noFilterCategory').value = '';
    noPage = 1; renderNoReasons();
  });
}

function setupNoSort() {
  document.querySelectorAll('#noTable thead th[data-nocol]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.nocol;
      noSort.dir = (noSort.col === col && noSort.dir === 'asc') ? 'desc' : 'asc';
      noSort.col = col;
      document.querySelectorAll('#noTable thead th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(noSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      noPage = 1; renderNoReasons();
    });
  });
}

function filteredNoLeads() {
  const { search, campaign, classification, category } = noFilters;
  let data = applyDateFilter(negativeLeads()).filter(l => {
    if (campaign       && l.campaign_name !== campaign)        return false;
    if (classification && l.classification !== classification) return false;
    if (category       && l.decline_category !== category)     return false;
    if (search) {
      const hay = (l.email+(l.creator_handle||'')+l.campaign_name+l.reason+l.decline_category+l.clean_reply_summary).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const { col, dir } = noSort;
  data.sort((a, b) => {
    const av = (a[col] || '').toString().toLowerCase();
    const bv = (b[col] || '').toString().toLowerCase();
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });

  return data;
}

function renderNoReasons() {
  const data  = filteredNoLeads();
  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / NO_PER_PAGE));
  noPage      = Math.min(noPage, pages);
  const slice = data.slice((noPage-1)*NO_PER_PAGE, noPage*NO_PER_PAGE);

  const countEl = document.getElementById('noCount');
  if (countEl) countEl.textContent = `${total.toLocaleString()} leads`;

  const tbody = document.querySelector('#noTable tbody');
  if (!tbody) return;
  if (!slice.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af;padding:36px">No negative leads match the current filters.</td></tr>';
  } else {
    tbody.innerHTML = slice.map(l => {
      const handleCell = l.creator_handle
        ? `<span class="handle-tag">@${esc(l.creator_handle)}</span>`
        : '<span style="color:#d1d5db">—</span>';
      return `
      <tr>
        <td style="white-space:nowrap">${handleCell}</td>
        <td style="font-weight:600;color:#111827;white-space:nowrap">${esc(l.email)}${l.timestamp ? `<div class="lead-ts">${esc(l.timestamp.slice(0,10))}</div>` : ''}</td>
        <td class="camp-name">${esc(l.campaign_name)}</td>
        <td><span class="badge badge-${l.classification}">${l.classification.replace(/_/g,' ')}</span></td>
        <td>${l.decline_category ? `<span class="decline-cat">${esc(l.decline_category)}</span>` : '<span style="color:#9ca3af">—</span>'}</td>
        <td class="reason-cell">${esc(l.reason) || '<span style="color:#d1d5db">—</span>'}</td>
        <td class="reply-cell" title="${esc(l.reply_text)}">${esc(l.clean_reply_summary || l.reply_text) || '<span style="color:#d1d5db">—</span>'}</td>
      </tr>
    `}).join('');
  }
  renderNoPagination(pages);
}

function renderNoPagination(pages) {
  const bar = document.getElementById('noPagination');
  if (!bar) return;
  const cur = noPage;
  let html = `<span class="pagination-info">Page ${cur} of ${pages}</span>`;
  html += noBtn('«', 1,       cur === 1);
  html += noBtn('‹', cur - 1, cur === 1);
  for (let p = Math.max(1, cur - 2); p <= Math.min(pages, cur + 2); p++)
    html += `<button class="${p === cur ? 'current' : ''}" onclick="noGotoPage(${p})">${p}</button>`;
  html += noBtn('›', cur + 1, cur === pages);
  html += noBtn('»', pages,   cur === pages);
  bar.innerHTML = html;
}
function noBtn(label, p, disabled) {
  return `<button ${disabled ? 'disabled' : ''} onclick="noGotoPage(${p})">${label}</button>`;
}
function noGotoPage(p) { noPage = p; renderNoReasons(); }

function downloadNoReasonsCSV() {
  const data = filteredNoLeads();
  const rows = [['email','campaign_name','classification','decline_category','reason','clean_reply_summary','timestamp']];
  data.forEach(l => rows.push([
    csvCell(l.email), csvCell(l.campaign_name), csvCell(l.classification),
    csvCell(l.decline_category||''), csvCell(l.reason||''),
    csvCell(l.clean_reply_summary||''), csvCell(l.timestamp||''),
  ]));
  triggerDownload(rows.map(r => r.join(',')).join('\n'), 'no_reasons_filtered.csv');
}


/* ═══════════════════════════════════════════════════
   ZERO REPLY CAMPAIGNS PAGE
═══════════════════════════════════════════════════ */

function renderZeroReplyCampaigns() {
  const zeros = D.campaigns.filter(c => c.total_inbound === 0);
  const countEl = document.getElementById('zero-count');
  if (countEl) countEl.textContent = `${zeros.length} campaigns`;

  const tbody = document.querySelector('#zeroTable tbody');
  if (!tbody) return;
  if (!zeros.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:36px">No zero-reply campaigns. Great job! 🎉</td></tr>';
    return;
  }
  const sorted = [...zeros].sort((a,b) => a.campaign_name.localeCompare(b.campaign_name));
  tbody.innerHTML = sorted.map((c, i) => `
    <tr>
      <td style="color:#9ca3af;font-weight:700">#${i+1}</td>
      <td class="camp-name">${esc(c.campaign_name)}</td>
      <td style="text-align:center"><span class="zero-tag">0</span></td>
      <td style="text-align:center"><span class="badge badge-NO" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5">No replies</span></td>
    </tr>
  `).join('');
}


function quickChat(msg) {
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  // Switch to AI tab first
  document.querySelectorAll('.nav-tabs-custom button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const aiBtn = document.querySelector('[data-target="page-ai"]');
  if (aiBtn) aiBtn.classList.add('active');
  document.getElementById('page-ai')?.classList.add('active');

  input.value = msg;
  sendChatMessage();
}

/* ═══════════════════════════════════════════════════
   LAST UPDATED DISPLAY
═══════════════════════════════════════════════════ */

function showLastUpdated() {
  const el = document.getElementById('last-updated-display');
  if (!el) return;
  if (!D.last_updated) { el.textContent = ''; return; }
  // Show relative time + absolute timestamp on hover
  const abs = D.last_updated;
  try {
    const d      = new Date(abs.replace(' ', 'T'));
    const diffMs = Date.now() - d.getTime();
    const diffM  = Math.round(diffMs / 60000);
    let rel;
    if      (diffM <  2)  rel = 'just now';
    else if (diffM < 60)  rel = `${diffM}m ago`;
    else if (diffM < 120) rel = '1h ago';
    else                  rel = `${Math.round(diffM / 60)}h ago`;
    el.textContent = `Updated ${rel}`;
    el.title       = abs;
  } catch (_) {
    el.textContent = `Updated ${abs}`;
  }
}

/* ═══════════════════════════════════════════════════
   AUTO-REFRESH (every 5 minutes)
═══════════════════════════════════════════════════ */

function startAutoRefresh() {
  const INTERVAL = 300; // 5 minutes in seconds
  let countdown = INTERVAL;
  const el = document.getElementById('refresh-countdown');

  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      location.reload();
      return;
    }
    if (el) {
      const m = Math.floor(countdown / 60);
      const s = String(countdown % 60).padStart(2, '0');
      el.textContent = `Auto-refresh in ${m}:${s}`;
    }
  }, 1000);
}

/* ═══════════════════════════════════════════════════
   CRM TAGS
═══════════════════════════════════════════════════ */

async function loadAllTags() {
  try {
    const resp = await fetch(`${AI_BASE_URL}/api/tags`);
    if (resp.status === 503) {
      const j = await resp.json().catch(() => ({}));
      if (j.code === 'no_supabase') {
        tagsAvailable = false;
        showTagsUnavailableBanner(true);
        return;
      }
    }
    if (!resp.ok) return;
    const rows = await resp.json();
    tagsMap = {};
    (Array.isArray(rows) ? rows : []).forEach(r => {
      tagsMap[r.email] = r;
    });
    tagsAvailable = true;
    showTagsUnavailableBanner(false);
    refreshTagUI();
  } catch (e) {
    // network error — don't mark unavailable, just silently fail
    console.warn('Tags: could not load', e);
  }
}

function showTagsUnavailableBanner(show) {
  const el = document.getElementById('tags-unavailable-banner');
  if (el) el.style.display = show ? '' : 'none';
}

async function quickSaveTag(email, handle, campaign, tag, notes) {
  if (!email) return;
  notes = notes !== undefined ? notes : (tagsMap[email]?.notes || '');
  // Optimistic update
  if (tag) {
    tagsMap[email] = { email, creator_handle: handle || '', campaign_name: campaign || '', assigned_tag: tag, notes, updated_at: new Date().toISOString() };
  } else {
    delete tagsMap[email];
  }
  refreshTagUI();

  try {
    if (tag) {
      await fetch(`${AI_BASE_URL}/api/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, creator_handle: handle || '', campaign_name: campaign || '', assigned_tag: tag, notes }),
      });
    } else {
      await fetch(`${AI_BASE_URL}/api/tags?email=${encodeURIComponent(email)}`, { method: 'DELETE' });
    }
  } catch (e) {
    console.warn('Tags: save failed', e);
  }
}

async function saveTagNotes(email, notes) {
  const existing = tagsMap[email];
  if (!existing) return;
  await quickSaveTag(email, existing.creator_handle, existing.campaign_name, existing.assigned_tag, notes);
}

function refreshTagUI() {
  renderTagCounts();
  renderTagStatus();
  // Re-style existing tag selects in leads table
  document.querySelectorAll('.tag-select').forEach(sel => {
    styleTagSelect(sel, sel.value);
  });
}

function renderTagCounts() {
  const vals = Object.values(tagsMap);
  set('tag-count-free-affiliate', vals.filter(t => t.assigned_tag === 'Free Affiliate').length);
  set('tag-count-closed',         vals.filter(t => t.assigned_tag === 'Closed').length);
  set('tag-count-said-no',        vals.filter(t => t.assigned_tag === 'Said NO').length);
  set('tag-count-lost',           vals.filter(t => t.assigned_tag === 'LOST').length);
  set('tag-count-waiting',        vals.filter(t => t.assigned_tag === 'Waiting for rates').length);
}

function tagBadgeHtml(email) {
  const t = tagsMap[email];
  if (!t || !t.assigned_tag) return '';
  const cfg = TAGS[t.assigned_tag];
  if (!cfg) return '';
  return `<span class="lead-tag-badge ${cfg.cls}" style="background:${cfg.bg};color:${cfg.color};border-color:${cfg.color}">${esc(t.assigned_tag)}</span>`;
}

function tagSelectHtml(lead) {
  const email    = lead.email;
  const handle   = (lead.creator_handle || '').replace(/"/g, '&quot;');
  const campaign = (lead.campaign_name  || '').replace(/"/g, '&quot;');
  const current  = tagsMap[email]?.assigned_tag || '';
  const opts = TAG_LIST.map(t =>
    `<option value="${t}" ${current === t ? 'selected' : ''}>${t}</option>`
  ).join('');
  return `<select class="tag-select" data-email="${esc(email)}" data-handle="${handle}" data-campaign="${campaign}">
    <option value="">— Tag —</option>${opts}
  </select>`;
}

function styleTagSelect(sel, tag) {
  if (!tag) {
    sel.style.background  = '';
    sel.style.color       = '';
    sel.style.borderColor = '';
    sel.style.fontWeight  = '';
    return;
  }
  const cfg = TAGS[tag];
  if (cfg) {
    sel.style.background  = cfg.bg;
    sel.style.color       = cfg.color;
    sel.style.borderColor = cfg.color;
    sel.style.fontWeight  = '600';
  }
}

function setupTagListeners() {
  // Event delegation: tag select changes anywhere on page
  document.body.addEventListener('change', e => {
    const sel = e.target.closest('.tag-select');
    if (!sel) return;
    const email    = sel.dataset.email    || '';
    const handle   = sel.dataset.handle   || '';
    const campaign = sel.dataset.campaign || '';
    const tag = sel.value;
    styleTagSelect(sel, tag);
    quickSaveTag(email, handle, campaign, tag);
  });

  // Notes blur: auto-save notes
  document.body.addEventListener('focusout', e => {
    const el = e.target;
    if (!el.classList.contains('tag-notes-input')) return;
    const email = el.dataset.email || '';
    if (!email) return;
    saveTagNotes(email, el.value.trim());
  });
}

function setupTagFilterBar() {
  document.querySelectorAll('.tag-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tag-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tagFilter = btn.dataset.tag || '';
      // Update badge
      const badge = document.getElementById('tag-filter-badge');
      if (badge) {
        if (tagFilter) {
          const cfg = TAGS[tagFilter];
          badge.textContent = `Filtered: ${tagFilter}`;
          badge.style.display = '';
          if (cfg) { badge.style.background = cfg.bg; badge.style.color = cfg.color; badge.style.borderColor = cfg.color; }
        } else {
          badge.style.display = 'none';
        }
      }
      applyDateFilterToAll();
    });
  });
}

function setupTagStatusFilter() {
  const sel = document.getElementById('tag-status-filter');
  if (sel) sel.addEventListener('change', renderTagStatus);
}

function renderTagStatus() {
  const filterSel = document.getElementById('tag-status-filter');
  const activeTagFilter = filterSel ? filterSel.value : '';

  // Build list of tagged leads from tagsMap, enriched with lead data
  const taggedEmails = Object.keys(tagsMap);
  const rows = taggedEmails
    .filter(email => !activeTagFilter || tagsMap[email].assigned_tag === activeTagFilter)
    .map(email => {
      const tagData = tagsMap[email];
      // Find lead in D.leads for extra fields
      const lead = D.leads.find(l => l.email === email) || {
        email,
        creator_handle: tagData.creator_handle || '',
        campaign_name:  tagData.campaign_name  || '',
        classification: '', reason: '', clean_reply_summary: '', reply_text: '', hot_lead: false,
      };
      return { ...lead, ...tagData, assigned_tag: tagData.assigned_tag, notes: tagData.notes || '', updated_at: tagData.updated_at || '' };
    })
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  const hint = document.getElementById('tag-status-hint');
  if (hint) hint.textContent = `— ${rows.length} tagged lead${rows.length !== 1 ? 's' : ''}`;

  const tbody = document.getElementById('tag-status-tbody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:#9ca3af;padding:36px">No tagged leads yet. Assign tags in Leads Explorer or Email Lookup.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const cfg = TAGS[r.assigned_tag] || {};
    const handleCell = r.creator_handle
      ? `<span class="handle-tag">@${esc(r.creator_handle)}</span>`
      : '<span style="color:#d1d5db">—</span>';
    const hotIcon = r.hot_lead ? '🔥' : '—';
    const summary = r.clean_reply_summary || r.reply_text || '';
    const updatedDisp = r.updated_at ? r.updated_at.slice(0, 10) : '—';
    return `
      <tr>
        <td>${handleCell}</td>
        <td style="font-weight:600;color:#111827;white-space:nowrap">${esc(r.email)}</td>
        <td class="camp-name">${esc(r.campaign_name || '')}</td>
        <td>${r.classification ? `<span class="badge badge-${r.classification}">${r.classification.replace(/_/g,' ')}</span>` : '—'}</td>
        <td class="reason-cell">${esc(r.reason || '')}</td>
        <td class="reply-cell" title="${esc(r.reply_text || '')}">${esc(summary) || '<span style="color:#d1d5db">—</span>'}</td>
        <td style="text-align:center">${hotIcon}</td>
        <td><span class="lead-tag-badge ${cfg.cls || ''}" style="background:${cfg.bg||'#f3f4f6'};color:${cfg.color||'#374151'};border-color:${cfg.color||'#e5e7eb'}">${esc(r.assigned_tag)}</span></td>
        <td><input type="text" class="tag-notes-input" data-email="${esc(r.email)}" value="${esc(r.notes || '')}" placeholder="Add note…"></td>
        <td style="color:#9ca3af;font-size:11px;white-space:nowrap">${updatedDisp}</td>
        <td style="text-align:center"><button class="btn-ai-sm" onclick="openAIPanel('${esc(r.email)}','${esc(r.campaign_name||'')}')">✦</button></td>
      </tr>
    `;
  }).join('');
}

function downloadTaggedLeadsCSV() {
  const rows = Object.values(tagsMap).map(t => {
    const lead = D.leads.find(l => l.email === t.email) || {};
    return [t.email, t.creator_handle||'', t.campaign_name||'', lead.classification||'', t.assigned_tag, t.notes||'', t.updated_at||''];
  });
  const headers = ['email','creator_handle','campaign_name','classification','assigned_tag','notes','updated_at'];
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'tagged_leads.csv';
  a.click();
}

/* ═══════════════════════════════════════════════════
   DATE FILTER
═══════════════════════════════════════════════════ */

// ── Local-time date helpers (avoids UTC off-by-one for non-UTC timezones) ─────
function _localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function _localMonthStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function todayStr()     { return _localDateStr(new Date()); }
function yesterdayStr() { const d = new Date(); d.setDate(d.getDate()-1); return _localDateStr(d); }
function last7Str()     { const d = new Date(); d.setDate(d.getDate()-6); return _localDateStr(d); }
function thisMonthStr() { return _localMonthStr(new Date()); }

// ── Compute campaign stats from a set of leads (for date-filtered views) ──────
function campaignsFromLeads(leads) {
  const map = {};
  leads.forEach(l => {
    if (!map[l.campaign_name]) {
      map[l.campaign_name] = {
        campaign_name: l.campaign_name,
        total_inbound: 0, yes: 0, interested: 0,
        no: 0, not_interested: 0, auto_reply: 0,
      };
    }
    const c = map[l.campaign_name];
    c.total_inbound++;
    const cls = l.classification;
    if      (cls === 'YES')            c.yes++;
    else if (cls === 'INTERESTED')     c.interested++;
    else if (cls === 'NO')             c.no++;
    else if (cls === 'NOT_INTERESTED') c.not_interested++;
    else if (cls === 'AUTO_REPLY')     c.auto_reply++;
  });
  return Object.values(map).map(c => {
    const pos = c.yes + c.interested;
    const neg = c.no + c.not_interested;
    const tot = c.total_inbound;
    return Object.assign(c, {
      positive_total: pos,
      negative_total: neg,
      positive_rate:  tot > 0 ? +(pos/tot*100).toFixed(1) : 0,
      negative_rate:  tot > 0 ? +(neg/tot*100).toFixed(1) : 0,
      no_reply_rate:  tot > 0 ? +(c.no/tot*100).toFixed(1) : 0,
      health_score:   tot > 0 ? +(pos*pos/tot).toFixed(1)  : 0,
    });
  });
}

// Returns D.campaigns for 'all time', otherwise computes from filtered leads
function getFilteredCampaigns() {
  return dateFilter.mode === 'all'
    ? D.campaigns
    : campaignsFromLeads(applyDateFilter(D.leads));
}

function applyDateFilter(leads) {
  const { mode, from, to } = dateFilter;
  let filtered = leads;

  if (mode !== 'all') {
    filtered = leads.filter(l => {
      const d = l.date;
      if (!d) return false; // no timestamp — exclude from date-filtered views
      switch (mode) {
        case 'today':     return d === todayStr();
        case 'yesterday': return d === yesterdayStr();
        case 'last7':     return d >= last7Str() && d <= todayStr();
        case 'thismonth': return l.month === thisMonthStr();
        case 'range':
          if (from && d < from) return false;
          if (to   && d > to)   return false;
          return true;
        default: return true;
      }
    });
  }

  if (tagFilter) {
    filtered = filtered.filter(l => tagsMap[l.email]?.assigned_tag === tagFilter);
  }

  return filtered;
}

function setupDateFilter() {
  document.querySelectorAll('.date-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('.date-btn[data-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const rangeInputs = document.getElementById('date-range-inputs');
      if (mode === 'range') {
        rangeInputs.style.display = '';
        dateFilter.mode = 'range';
        // don't apply yet — wait for Apply button
        return;
      }
      if (rangeInputs) rangeInputs.style.display = 'none';
      dateFilter = { mode, from: '', to: '' };
      applyDateFilterToAll();
    });
  });

  const applyBtn = document.getElementById('date-apply-btn');
  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      dateFilter.from = document.getElementById('date-from').value;
      dateFilter.to   = document.getElementById('date-to').value;
      dateFilter.mode = 'range';
      applyDateFilterToAll();
    });
  }
}

function applyDateFilterToAll() {
  // ── Update active filter label (always visible) ───────────────────────────
  const badge = document.getElementById('date-active-badge');
  if (badge) {
    const labels = {
      all:       'All time',
      today:     'Today',
      yesterday: 'Yesterday',
      last7:     'Last 7 days',
      thismonth: 'This month',
      range:     `${dateFilter.from || '…'} to ${dateFilter.to || '…'}`,
    };
    badge.textContent = `Showing: ${labels[dateFilter.mode] || dateFilter.mode}`;
    badge.style.display = '';
  }

  // ── Re-render KPIs, charts, tables ───────────────────────────────────────
  renderKPIs();
  renderDonut();
  renderTopCampsChart();
  renderRankingTable();
  if (chartStacked) renderStackedChart();   // only if campaigns tab was already opened
  renderHotLeadsKPIs();
  renderNoReasonsKPIs();

  leadsPage = 1; renderLeads();
  hlPage    = 1; renderHotLeads();
  noPage    = 1; renderNoReasons();
  renderTagStatus();

  updateDebugPanel();
}

/* ═══════════════════════════════════════════════════
   HANDLE LOOKUP
═══════════════════════════════════════════════════ */

function setupHandleLookup() {
  const input = document.getElementById('handleLookupInput');
  const btn   = document.getElementById('handleLookupBtn');
  if (!input || !btn) return;
  btn.addEventListener('click', doHandleLookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doHandleLookup(); });
}

function _normalizeHandle(s) {
  return (s || '').toLowerCase().replace(/^@+/, '').trim();
}

function _fuzzyScore(haystack, needle) {
  // Returns 0–1: 1=exact, 0.8=starts-with, 0.5=contains, 0=no match
  if (!haystack || !needle) return 0;
  const h = haystack.toLowerCase(), n = needle.toLowerCase();
  if (h === n) return 1;
  if (h.startsWith(n)) return 0.8;
  if (h.includes(n)) return 0.5;
  return 0;
}

function _renderHitCard(l) {
  const hotLine     = l.hot_lead ? `<span class="hot-tag" style="margin-left:6px">Hot Lead</span>` : '';
  const tsLine      = l.timestamp ? `<span style="color:#9ca3af;font-size:11px;margin-left:8px">${esc(l.timestamp.slice(0,10))}</span>` : '';
  const handleDisp  = l.creator_handle ? `<span class="handle-tag" style="margin-right:6px">@${esc(l.creator_handle)}</span>` : '';
  const declineLine = l.decline_category
    ? `<div class="hit-reason" style="color:#ef4444">Decline reason: <strong>${esc(l.decline_category)}</strong></div>` : '';
  const summary  = l.clean_reply_summary || l.reply_text || '';
  const tagBadge = tagBadgeHtml(l.email);
  return `
    <div class="lookup-hit hit-${l.classification}">
      <div class="hit-top">
        ${handleDisp}<span class="hit-email">${esc(l.email)}</span>
        <span class="badge badge-${l.classification}">${l.classification.replace(/_/g,' ')}</span>
        ${hotLine}
        ${tagBadge ? `<span style="margin-left:6px">${tagBadge}</span>` : ''}
        ${tsLine}
      </div>
      <div class="hit-meta"><span>Campaign: <strong>${esc(l.campaign_name)}</strong></span></div>
      ${l.reason ? `<div class="hit-reason">${esc(l.reason)}</div>` : ''}
      ${declineLine}
      ${summary ? `<div class="hit-text">${esc(summary)}</div>` : ''}
    </div>
  `;
}

async function doHandleLookup() {
  const raw = document.getElementById('handleLookupInput').value.trim();
  const q   = _normalizeHandle(raw);
  const out = document.getElementById('handle-lookup-results');
  if (!q) { out.innerHTML = ''; return; }

  // Always search full D.leads — never date/tag filtered
  const allLeads      = D.leads;
  const totalCreators = new Set(allLeads.map(l => _normalizeHandle(l.creator_handle)).filter(Boolean)).size;
  const totalEmails   = new Set(allLeads.map(l => l.email.toLowerCase())).size;
  const emailUser     = q.includes('@') ? q.split('@')[0] : q;

  // Score every lead across handle, email username, email full, and reply text
  const scored = allLeads.map(l => {
    const handleNorm = _normalizeHandle(l.creator_handle);
    const emailNorm  = l.email.toLowerCase();
    const emailLocal = emailNorm.split('@')[0];
    const replyNorm  = (l.reply_text || '').toLowerCase();
    const score = Math.max(
      _fuzzyScore(handleNorm, q),
      _fuzzyScore(emailLocal, emailUser),
      _fuzzyScore(emailNorm, q),
      replyNorm.includes(q) ? 0.3 : 0
    );
    return { l, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

  const hits    = scored.filter(x => x.score >= 0.5).map(x => x.l);
  const similar = scored.filter(x => x.score > 0 && x.score < 0.5).map(x => x.l).slice(0, 5);
  const exactMatch = allLeads.some(l => _normalizeHandle(l.creator_handle) === q || l.email.toLowerCase() === q);

  const _lastUpd2 = D.last_updated ? ` &middot; Updated: <b>${esc(D.last_updated)}</b>` : '';
  const debugHtml = `
    <div class="handle-debug">
      Dataset: <b>${allLeads.length.toLocaleString()}</b> leads &middot;
      <b>${totalCreators.toLocaleString()}</b> creators &middot;
      <b>${totalEmails.toLocaleString()}</b> emails${_lastUpd2}
      &nbsp;|&nbsp; Query: <code>${esc(q)}</code>
      &nbsp;|&nbsp; Exact: <b>${exactMatch ? 'yes' : 'no'}</b>
      &nbsp;|&nbsp; Hits: <b>${hits.length}</b> &middot; Similar: <b>${similar.length}</b>
    </div>`;

  if (!hits.length && !similar.length) {
    out.innerHTML = debugHtml + `<div class="lookup-empty">
      No creator matching <strong>${esc(raw)}</strong> in the production dataset (${allLeads.length.toLocaleString()} leads).<br>
      <small style="color:#d97706;display:block;margin-top:6px">
        Dataset may be incomplete — old fetches only retrieved the first 100 replies per campaign.
        Re-run <code>run_all.sh</code> to fetch full historical data.
      </small>
    </div>`;
    _tryLiveHandleLookup(q, raw, out);
    return;
  }

  let html = debugHtml;
  if (hits.length) {
    html += `<div class="handle-section-label">${hits.length} result${hits.length > 1 ? 's' : ''} for <strong>${esc(raw)}</strong></div>`;
    html += hits.map(_renderHitCard).join('');
  }
  if (similar.length) {
    html += `<div class="handle-section-label" style="margin-top:12px;color:#6b7280">Similar matches</div>`;
    html += similar.map(_renderHitCard).join('');
  }
  out.innerHTML = html;
}

async function _tryLiveHandleLookup(q, raw, out) {
  const notice = document.createElement('div');
  notice.className = 'lookup-empty';
  notice.style.fontStyle = 'italic';
  notice.innerHTML = `Checking Instantly API live for <strong>${esc(raw)}</strong>...`;
  out.appendChild(notice);
  try {
    const res = await fetch(`${AI_BASE_URL}/api/lookup-handle?q=${encodeURIComponent(q)}`);
    notice.remove();
    if (!res.ok) return;
    const data = await res.json();
    if (!data.results || !data.results.length) {
      out.insertAdjacentHTML('beforeend', `<div class="lookup-empty">Not found in Instantly API either.</div>`);
      return;
    }
    let html = `<div class="handle-section-label" style="color:#7c3aed">Live from Instantly API (${data.results.length} result${data.results.length > 1 ? 's' : ''})</div>`;
    html += data.results.map(_renderHitCard).join('');
    out.insertAdjacentHTML('beforeend', html);
  } catch {
    notice.remove();
  }
}

/* ═══════════════════════════════════════════════════
   TODAY'S ACTIVITY METRICS
═══════════════════════════════════════════════════ */

function renderTodayMetrics() {
  const today = D.leads.filter(l => l.date === todayStr());
  set('today-replies', today.length);
  set('today-hot',     today.filter(l => l.hot_lead).length);
  set('today-no',      today.filter(l => l.classification === 'NO' || l.classification === 'NOT_INTERESTED').length);
  set('today-camps',   new Set(today.map(l => l.campaign_name)).size);
}

/* ═══════════════════════════════════════════════════
   DEBUG PANEL
═══════════════════════════════════════════════════ */

function updateDebugPanel() {
  const panel = document.getElementById('debug-panel-body');
  if (!panel) return;
  const totalRaw      = D.leads.length;
  const withTimestamp = D.leads.filter(l => l.date).length;
  const afterFilter   = applyDateFilter(D.leads).length;
  const localDate     = todayStr();
  const tz            = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const filterLabels  = {
    all: 'All time', today: 'Today', yesterday: 'Yesterday',
    last7: 'Last 7 days', thismonth: 'This month', range: 'Custom range',
  };
  panel.innerHTML = `
    <table class="debug-table">
      <tr><td>Total raw rows loaded</td><td><strong>${totalRaw.toLocaleString()}</strong></td></tr>
      <tr><td>Rows with valid timestamps</td><td><strong>${withTimestamp.toLocaleString()}</strong></td></tr>
      <tr><td>Rows after current filter</td><td><strong>${afterFilter.toLocaleString()}</strong></td></tr>
      <tr><td>Current detected local date</td><td><strong>${localDate}</strong></td></tr>
      <tr><td>Active timezone</td><td><strong>${tz}</strong></td></tr>
      <tr><td>Active filter</td><td><strong>${filterLabels[dateFilter.mode] || dateFilter.mode}${dateFilter.mode === 'range' ? ` (${dateFilter.from || '…'} → ${dateFilter.to || '…'})` : ''}</strong></td></tr>
    </table>
  `;
}

function toggleDebugPanel() {
  const body = document.getElementById('debug-panel-body');
  const btn  = document.getElementById('debug-toggle-btn');
  if (!body) return;
  const visible = body.style.display !== 'none';
  body.style.display = visible ? 'none' : '';
  btn.textContent    = visible ? 'Show Debug' : 'Hide Debug';
  if (!visible) updateDebugPanel();
}
