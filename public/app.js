/* ================================================================
   Calcutta Auction 2026 — Client (HTTP Polling)
   ================================================================ */

let authToken = null;
let currentUser = null;
let teams = [];
let participants = [];
let onlineUsers = [];
let auctionState = null;
let selectedNominateTeamId = null;
let timerDuration = 15;
let bidIncrement = 1;
let pollInterval = null;
let clientTimerInterval = null;
let prevAuctionStatus = 'waiting';
let prevHighBid = 0;
let serverTimeOffset = 0; // serverTime - clientTime
let chatMessages = [];
let lastChatCount = 0;
let chatTabActive = false;

// Palette for avatars
const COLORS = [
  '#ef4444','#f59e0b','#22c55e','#3b82f6','#8b5cf6',
  '#ec4899','#14b8a6','#f97316','#6366f1','#06b6d4'
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}

// ================================================================
// API HELPER
// ================================================================
async function api(endpoint, data = null) {
  const opts = { headers: {} };
  if (authToken) opts.headers['Authorization'] = `Bearer ${authToken}`;
  if (data !== null) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  try {
    const res = await fetch(`/api/${endpoint}`, opts);
    const json = await res.json();
    if (!res.ok && json.error) toast(json.error, 'error');
    return json;
  } catch (e) {
    console.error('API error:', e);
    return { error: e.message };
  }
}

// ================================================================
// LOGIN
// ================================================================
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('login-name').value.trim();
  if (!name) return;

  const res = await api('auth', { name });
  if (res.error) {
    document.getElementById('login-error').textContent = res.error;
    return;
  }

  authToken = res.token;
  currentUser = res.user;
  document.getElementById('user-badge').textContent = currentUser.name;
  document.getElementById('login-view').classList.remove('active');
  document.getElementById('main-view').classList.add('active');

  if (res.state.serverTime) serverTimeOffset = res.state.serverTime - Date.now();
  handleStateSync(res.state);
  startPolling();
});

// ================================================================
// POLLING
// ================================================================
function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    const state = await api('state');
    if (!state.error) {
      if (state.serverTime) serverTimeOffset = state.serverTime - Date.now();
      handleStateSync(state);
    }
  }, 1500);
}

// ================================================================
// STATE SYNC
// ================================================================
function handleStateSync(state) {
  teams = state.teams;
  participants = state.participants;
  onlineUsers = state.onlineUsers;

  const newAuction = state.auction;
  bidIncrement = newAuction.bidIncrement || 1;
  timerDuration = newAuction.timerDuration || 15;

  // Detect transitions for toasts
  if (newAuction.status === 'sold' && prevAuctionStatus === 'active') {
    const soldName = newAuction.soldTeamName || '';
    const winner = newAuction.soldWinnerName || newAuction.highBidderName || '';
    const amount = newAuction.soldAmount || newAuction.highBid || 0;
    toast(`${soldName} sold to ${winner} for $${amount}`, 'success');
  }
  if (newAuction.status === 'cancelled' && prevAuctionStatus !== 'cancelled' && prevAuctionStatus !== 'waiting') {
    toast(newAuction.cancelReason || 'Auction cancelled', 'info');
  }
  if (newAuction.status === 'active' && newAuction.highBid > prevHighBid && prevHighBid > 0) {
    // New bid came in from someone else - handled via display update
  }

  prevAuctionStatus = newAuction.status;
  prevHighBid = newAuction.highBid || 0;

  // Build auction state with team info
  if (newAuction.status === 'active' || newAuction.status === 'paused') {
    const team = teams.find(t => t.id === newAuction.currentTeamId);
    auctionState = { ...newAuction, team };

    // Start client-side timer from deadline
    if (newAuction.status === 'active' && newAuction.timerDeadline) {
      startClientTimer(newAuction.timerDeadline);
    } else if (newAuction.status === 'paused') {
      stopClientTimer();
      const remaining = Math.max(0, Math.ceil((newAuction.pausedRemaining || 0) / 1000));
      updateTimer(remaining);
    }
  } else if (newAuction.status === 'sold') {
    auctionState = {
      ...newAuction,
      team: teams.find(t => t.id === newAuction.currentTeamId),
      winnerName: newAuction.soldWinnerName || newAuction.highBidderName,
      amount: newAuction.soldAmount || newAuction.highBid
    };
    stopClientTimer();
  } else {
    auctionState = { status: 'waiting' };
    stopClientTimer();
  }

  // Chat
  if (state.chat) {
    const hadNew = state.chat.length > lastChatCount && lastChatCount > 0;
    chatMessages = state.chat;
    if (hadNew && !chatTabActive) {
      showChatBadge(state.chat.length - lastChatCount);
    }
    lastChatCount = state.chat.length;
    renderChat();
  }

  renderTeams();
  renderParticipants();
  renderAuction();
  renderAvailableTeams();
  renderEditTeams();
  updatePot();

  document.getElementById('setting-increment').value = bidIncrement;
  document.getElementById('setting-timer').value = timerDuration;
}

// ================================================================
// CLIENT-SIDE TIMER
// ================================================================
function startClientTimer(deadline) {
  stopClientTimer();
  clientTimerInterval = setInterval(() => {
    const adjustedNow = Date.now() + serverTimeOffset;
    const remaining = Math.max(0, Math.ceil((deadline - adjustedNow) / 1000));
    updateTimer(remaining);
    if (remaining <= 0) stopClientTimer();
  }, 200);
}

function stopClientTimer() {
  if (clientTimerInterval) {
    clearInterval(clientTimerInterval);
    clientTimerInterval = null;
  }
}

// ================================================================
// RENDER: Teams
// ================================================================
function renderTeams() {
  const container = document.getElementById('team-list');
  const activeFilter = document.querySelector('.filter-btn.active')?.dataset.region || 'all';

  const regions = ['East', 'West', 'South', 'Midwest'];
  let html = '';
  let available = 0, sold = 0;

  for (const region of regions) {
    const regionTeams = teams.filter(t => t.region === region);
    if (activeFilter !== 'all' && activeFilter !== region) continue;

    html += `<div class="team-region-header">${region}</div>`;
    for (const t of regionTeams) {
      if (t.status === 'sold') sold++;
      else available++;

      let statusHtml = '';
      if (t.status === 'sold') {
        statusHtml = `<span class="team-owner">${t.owner_name || '?'}</span><span class="team-price">$${t.winning_bid}</span>`;
      } else if (t.status === 'active') {
        statusHtml = `<span class="team-status active">LIVE</span>`;
      }

      html += `
        <div class="team-item" data-id="${t.id}" data-status="${t.status}">
          <span class="team-seed">${t.seed}</span>
          <span class="team-name">${t.name}</span>
          ${statusHtml}
        </div>`;
    }
  }
  container.innerHTML = html;
  document.getElementById('teams-summary').textContent = `${sold} sold / ${available} available`;
}

// Filter buttons
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderTeams();
  });
});

// ================================================================
// RENDER: Participants
// ================================================================
function renderParticipants() {
  const container = document.getElementById('participants-list');
  const onlineIds = new Set(onlineUsers.map(u => u.id));

  const sorted = [...participants].sort((a, b) => b.total_spent - a.total_spent);

  let html = '';
  for (const p of sorted) {
    const isOnline = onlineIds.has(p.id);
    const color = avatarColor(p.name);
    html += `
      <div class="participant-item ${isOnline ? 'participant-online' : ''}">
        <div class="participant-avatar" style="background:${color}20; color:${color}">${p.name.charAt(0).toUpperCase()}</div>
        <div class="participant-info">
          <div class="participant-name">${p.name}</div>
          <div class="participant-stats">${p.teams_owned} team${p.teams_owned !== 1 ? 's' : ''}</div>
        </div>
        <div class="participant-total">${p.total_spent > 0 ? '$' + p.total_spent : ''}</div>
      </div>`;
  }

  for (const u of onlineUsers) {
    if (!participants.find(p => p.id === u.id)) {
      const color = avatarColor(u.name);
      html += `
        <div class="participant-item participant-online">
          <div class="participant-avatar" style="background:${color}20; color:${color}">${u.name.charAt(0).toUpperCase()}</div>
          <div class="participant-info">
            <div class="participant-name">${u.name}</div>
            <div class="participant-stats">0 teams</div>
          </div>
          <div class="participant-total"></div>
        </div>`;
    }
  }

  container.innerHTML = html;
  document.getElementById('online-count').textContent = `${onlineUsers.length} online`;
}

// ================================================================
// RENDER: Auction Center
// ================================================================
function renderAuction() {
  const waiting = document.getElementById('auction-waiting');
  const active = document.getElementById('auction-active');
  const soldEl = document.getElementById('auction-sold');
  const paused = document.getElementById('auction-paused-overlay');

  waiting.style.display = 'none';
  active.style.display = 'none';
  soldEl.style.display = 'none';
  paused.style.display = 'none';

  if (!auctionState || auctionState.status === 'waiting') {
    waiting.style.display = 'flex';
    updatePot();
    return;
  }

  if (auctionState.status === 'sold') {
    soldEl.style.display = 'flex';
    document.getElementById('sold-team-name').textContent = `${auctionState.team?.seed || ''} ${auctionState.team?.name || ''}`;
    document.getElementById('sold-winner').textContent = auctionState.winnerName || '';
    document.getElementById('sold-amount').textContent = `$${auctionState.amount || 0}`;
    return;
  }

  if (auctionState.status === 'cancelled') {
    waiting.style.display = 'flex';
    updatePot();
    return;
  }

  // Active or paused
  active.style.display = 'flex';
  if (auctionState.status === 'paused') paused.style.display = 'flex';

  const team = auctionState.team;
  if (team) {
    document.getElementById('auction-seed').textContent = `#${team.seed} Seed`;
    document.getElementById('auction-team-name').textContent = team.name;
    document.getElementById('auction-region').textContent = team.region + ' Region';
  }

  renderBidDisplay();
  renderBidHistory();
  renderQuickBids();
}

function renderBidDisplay() {
  if (!auctionState) return;
  const amount = auctionState.highBid || 0;
  const leader = auctionState.highBidderName || 'No bids yet';
  document.getElementById('current-bid-amount').textContent = amount > 0 ? `$${amount}` : '$0';
  document.getElementById('current-bid-leader').textContent = amount > 0 ? leader : 'No bids yet';
}

function renderQuickBids() {
  const container = document.getElementById('quick-bids');
  if (!auctionState) return;
  const current = auctionState.highBid || 0;
  const inc = bidIncrement;
  const amounts = [
    current + inc,
    current + inc * 2,
    current + inc * 5,
    current + inc * 10
  ].filter(a => a > current);

  const unique = [...new Set(amounts)].slice(0, 4);
  container.innerHTML = unique.map(a =>
    `<button class="btn btn-primary" onclick="placeBidAmount(${a})">$${a}</button>`
  ).join('');

  document.getElementById('custom-bid').value = '';
  document.getElementById('custom-bid').min = current + 1;
  document.getElementById('custom-bid').placeholder = `$${current + 1}+`;
}

function renderBidHistory() {
  const container = document.getElementById('bid-history-list');
  if (!auctionState || !auctionState.bidHistory) { container.innerHTML = ''; return; }
  container.innerHTML = auctionState.bidHistory.slice(0, 20).map(b =>
    `<div class="bid-entry"><span class="bid-entry-name">${b.userName}</span><span class="bid-entry-amount">$${b.amount}</span></div>`
  ).join('');
}

// ================================================================
// TIMER DISPLAY
// ================================================================
function updateTimer(seconds) {
  const text = document.getElementById('timer-text');
  const circle = document.getElementById('timer-circle');
  if (!text || !circle) return;

  text.textContent = Math.max(0, seconds);
  const circumference = 2 * Math.PI * 54;
  const pct = seconds / timerDuration;
  circle.style.strokeDashoffset = circumference * (1 - pct);

  if (seconds <= 5) {
    circle.classList.add('urgent');
    text.style.color = 'var(--red)';
  } else {
    circle.classList.remove('urgent');
    text.style.color = 'var(--text)';
  }
}

// ================================================================
// BIDDING
// ================================================================
async function placeBidAmount(amount) {
  await api('bid', { amount });
}

async function placeBid() {
  const input = document.getElementById('custom-bid');
  const val = parseInt(input.value);
  if (!val || val <= 0) return;
  await api('bid', { amount: val });
  input.value = '';
}

document.getElementById('custom-bid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') placeBid();
});

// ================================================================
// POT
// ================================================================
function updatePot() {
  const total = teams.reduce((sum, t) => sum + (t.winning_bid || 0), 0);
  document.getElementById('pot-amount').textContent = `$${total}`;
}

// ================================================================
// ADMIN
// ================================================================
function toggleAdmin() {
  const modal = document.getElementById('admin-modal');
  modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
  if (modal.style.display === 'flex') {
    renderAvailableTeams();
    renderEditTeams();
  }
}

function showAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.admin-tab[onclick*="${tab}"]`).classList.add('active');
  document.getElementById(`admin-${tab}`).classList.add('active');
}

function renderAvailableTeams() {
  const container = document.getElementById('available-teams-list');
  const available = teams.filter(t => t.status === 'available');
  selectedNominateTeamId = null;
  document.getElementById('nominate-controls').style.display = 'none';

  if (available.length === 0) {
    container.innerHTML = '<p style="color:var(--text-dim);text-align:center;padding:20px;">All teams have been auctioned!</p>';
    return;
  }

  container.innerHTML = available.map(t =>
    `<div class="available-team-row" onclick="selectNominateTeam(${t.id}, this)">
      <span class="team-seed">${t.seed}</span>
      <span>${t.name}</span>
      <span style="color:var(--text-muted);margin-left:auto;font-size:12px">${t.region}</span>
    </div>`
  ).join('');
}

function selectNominateTeam(id, el) {
  document.querySelectorAll('.available-team-row').forEach(r => r.classList.remove('selected'));
  el.classList.add('selected');
  selectedNominateTeamId = id;
  document.getElementById('nominate-controls').style.display = 'flex';
}

async function nominateTeam() {
  if (!selectedNominateTeamId) return;
  const startingBid = parseInt(document.getElementById('starting-bid').value) || 1;
  await api('nominate', { teamId: selectedNominateTeamId, startingBid });
  toggleAdmin();
}

async function pauseAuction() { await api('auction-control', { action: 'pause' }); }
async function resumeAuction() { await api('auction-control', { action: 'resume' }); }
async function skipAuction() {
  if (confirm('Cancel the current auction?')) await api('auction-control', { action: 'skip' });
}

// Edit teams
function renderEditTeams() {
  const container = document.getElementById('edit-teams-list');
  container.innerHTML = teams.map(t =>
    `<div class="edit-team-row" data-id="${t.id}">
      <input type="number" value="${t.seed}" min="1" max="16" class="edit-seed">
      <select class="edit-region">
        <option ${t.region === 'East' ? 'selected' : ''}>East</option>
        <option ${t.region === 'West' ? 'selected' : ''}>West</option>
        <option ${t.region === 'South' ? 'selected' : ''}>South</option>
        <option ${t.region === 'Midwest' ? 'selected' : ''}>Midwest</option>
      </select>
      <input type="text" value="${t.name}" class="edit-name">
      <button class="btn btn-sm btn-outline" onclick="saveTeamEdit(${t.id}, this)">Save</button>
    </div>`
  ).join('');
}

async function saveTeamEdit(id, btn) {
  const row = btn.closest('.edit-team-row');
  const seed = parseInt(row.querySelector('.edit-seed').value);
  const region = row.querySelector('.edit-region').value;
  const name = row.querySelector('.edit-name').value.trim();
  if (!name) return;
  const res = await api('admin', { action: 'update-team', id, name, seed, region });
  if (res.success) toast('Team updated', 'success');
}

// Import
async function importTeams() {
  const text = document.getElementById('import-textarea').value.trim();
  if (!text) return;

  const lines = text.split('\n');
  const teamsData = [];
  let currentRegion = 'East';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const regionMatch = trimmed.match(/^\[(.+)\]$/);
    if (regionMatch) {
      currentRegion = regionMatch[1].trim();
      continue;
    }

    const teamMatch = trimmed.match(/^(\d+)\.?\s+(.+)$/);
    if (teamMatch) {
      teamsData.push({
        seed: parseInt(teamMatch[1]),
        name: teamMatch[2].trim(),
        region: currentRegion
      });
    }
  }

  if (teamsData.length === 0) {
    toast('No teams parsed. Check format.', 'error');
    return;
  }

  if (confirm(`Import ${teamsData.length} teams? This will replace all existing teams and bids.`)) {
    const res = await api('admin', { action: 'import-teams', teams: teamsData });
    if (res.success) toast(`Imported ${res.count} teams`, 'success');
  }
}

// Settings
async function saveSettings() {
  const timer = parseInt(document.getElementById('setting-timer').value) || 15;
  const increment = parseInt(document.getElementById('setting-increment').value) || 1;
  const res = await api('admin', { action: 'settings', timerDuration: timer, bidIncrement: increment });
  if (res.success) toast('Settings saved', 'success');
}

async function resetAll() {
  if (confirm('Reset ALL auctions? This will clear all bids and team ownership. This cannot be undone.')) {
    if (confirm('Are you absolutely sure?')) {
      await api('admin', { action: 'reset' });
      toast('All auctions reset', 'info');
    }
  }
}

// ================================================================
// RESULTS
// ================================================================
function toggleResults() {
  const modal = document.getElementById('results-modal');
  modal.style.display = modal.style.display === 'none' ? 'flex' : 'none';
  if (modal.style.display === 'flex') renderResults();
}

function renderResults() {
  const total = teams.reduce((sum, t) => sum + (t.winning_bid || 0), 0);
  document.getElementById('results-pot').innerHTML =
    `<span class="pot-label">Total Pot</span><span class="pot-amount">$${total}</span>`;

  const tbody = document.getElementById('results-tbody');
  const sorted = [...teams].sort((a, b) => {
    if (a.status === 'sold' && b.status !== 'sold') return -1;
    if (a.status !== 'sold' && b.status === 'sold') return 1;
    return b.winning_bid - a.winning_bid;
  });

  tbody.innerHTML = sorted.map(t =>
    `<tr class="${t.status === 'sold' ? 'sold-row' : 'available-row'}">
      <td>${t.seed}</td>
      <td>${t.name}</td>
      <td>${t.region}</td>
      <td>${t.owner_name || '-'}</td>
      <td>${t.winning_bid ? '$' + t.winning_bid : '-'}</td>
    </tr>`
  ).join('');
}

// ================================================================
// CHAT
// ================================================================
function switchRightTab(tab) {
  document.querySelectorAll('.right-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.right-tab-content').forEach(t => { t.classList.remove('active'); t.style.display = 'none'; });
  document.querySelector(`.right-tab[onclick*="${tab}"]`).classList.add('active');
  const el = document.getElementById(`right-${tab}`);
  el.classList.add('active');
  el.style.display = 'flex';

  chatTabActive = (tab === 'chat');
  if (chatTabActive) {
    clearChatBadge();
    scrollChatToBottom();
  }
}

function renderChat() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

  container.innerHTML = chatMessages.map(m => {
    const isMine = currentUser && m.userId === currentUser.id;
    const time = new Date(m.time);
    const ts = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const color = avatarColor(m.userName);
    return `<div class="chat-msg ${isMine ? 'mine' : ''}">
      <div class="chat-msg-header">
        <span class="chat-msg-name" style="color:${color}">${escapeHtml(m.userName)}</span>
        <span class="chat-msg-time">${ts}</span>
      </div>
      <div class="chat-msg-text">${escapeHtml(m.text)}</div>
    </div>`;
  }).join('');

  if (wasAtBottom) scrollChatToBottom();
}

function scrollChatToBottom() {
  const container = document.getElementById('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

function showChatBadge(count) {
  const tab = document.querySelector('.right-tab[onclick*="chat"]');
  if (!tab) return;
  let badge = tab.querySelector('.chat-unread-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'chat-unread-badge';
    tab.appendChild(badge);
  }
  badge.textContent = count > 9 ? '9+' : count;
}

function clearChatBadge() {
  const badge = document.querySelector('.chat-unread-badge');
  if (badge) badge.remove();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

document.getElementById('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  await api('chat', { text });
});

// ================================================================
// RANDOM NOMINATE
// ================================================================
async function randomNominate() {
  const res = await api('nominate', { random: true, startingBid: 1 });
  if (res.success && res.team) {
    toast(`Auctioning: #${res.team.seed} ${res.team.name} (${res.team.region})`, 'info');
  }
}

// ================================================================
// TOAST
// ================================================================
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4000);
}
