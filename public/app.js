/* ================================================================
   Calcutta Auction 2026 — Client
   ================================================================ */

const socket = io();

let currentUser = null;
let teams = [];
let participants = [];
let onlineUsers = [];
let auctionState = null;
let selectedNominateTeamId = null;
let timerDuration = 15;
let bidIncrement = 1;

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
// LOGIN
// ================================================================
document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('login-name').value.trim();
  if (!name) return;

  socket.emit('auth', name, (res) => {
    if (res.error) {
      document.getElementById('login-error').textContent = res.error;
      return;
    }
    currentUser = res.user;
    document.getElementById('user-badge').textContent = currentUser.name;
    document.getElementById('login-view').classList.remove('active');
    document.getElementById('main-view').classList.add('active');
    handleStateSync(res.state);
  });
});

// ================================================================
// SOCKET EVENTS
// ================================================================
socket.on('state:sync', handleStateSync);
socket.on('users:online', (users) => { onlineUsers = users; renderParticipants(); });
socket.on('settings:update', (s) => {
  bidIncrement = s.bidIncrement;
  timerDuration = s.timerDuration;
  document.getElementById('setting-increment').value = bidIncrement;
  document.getElementById('setting-timer').value = timerDuration;
});

socket.on('auction:start', (data) => {
  auctionState = { status: 'active', team: data.team, startingBid: data.startingBid, highBid: 0, highBidderName: '', bidHistory: [] };
  // Update team in local list
  const idx = teams.findIndex(t => t.id === data.team.id);
  if (idx >= 0) teams[idx].status = 'active';
  renderTeams();
  renderAuction();
  toast(`Bidding open: ${data.team.seed} ${data.team.name}`, 'info');
});

socket.on('auction:bid', (data) => {
  if (!auctionState) return;
  auctionState.highBid = data.amount;
  auctionState.highBidderName = data.userName;
  auctionState.bidHistory = data.bidHistory;
  renderBidDisplay();
  renderBidHistory();
  renderQuickBids();
});

socket.on('auction:timer', (seconds) => {
  updateTimer(seconds);
});

socket.on('auction:sold', (data) => {
  auctionState = { status: 'sold', team: data.team, winnerName: data.winnerName, amount: data.amount };
  renderAuction();
  toast(`${data.team.name} sold to ${data.winnerName} for $${data.amount}`, 'success');
});

socket.on('auction:cancelled', (data) => {
  auctionState = { status: 'waiting' };
  renderAuction();
  toast(data.reason || 'Auction cancelled', 'info');
});

socket.on('auction:paused', (seconds) => {
  if (auctionState) auctionState.status = 'paused';
  document.getElementById('auction-paused-overlay').style.display = 'flex';
});

socket.on('auction:resumed', () => {
  if (auctionState) auctionState.status = 'active';
  document.getElementById('auction-paused-overlay').style.display = 'none';
});

socket.on('error:message', (msg) => toast(msg, 'error'));

// ================================================================
// STATE SYNC
// ================================================================
function handleStateSync(state) {
  teams = state.teams;
  participants = state.participants;
  onlineUsers = state.onlineUsers;
  auctionState = state.auction;
  bidIncrement = state.auction.bidIncrement || 1;
  timerDuration = state.auction.timerDuration || 15;

  if (auctionState.status === 'active' || auctionState.status === 'paused') {
    const team = teams.find(t => t.id === auctionState.currentTeamId);
    if (team) {
      auctionState.team = team;
      auctionState.highBidderName = auctionState.highBidderName || '';
    }
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

  // Merge participants with online status, sort by total spent desc
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

  // Show online users who haven't bid yet
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
    document.getElementById('sold-winner').textContent = auctionState.winnerName;
    document.getElementById('sold-amount').textContent = `$${auctionState.amount}`;
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

  // Deduplicate
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
// TIMER
// ================================================================
function updateTimer(seconds) {
  const text = document.getElementById('timer-text');
  const circle = document.getElementById('timer-circle');
  if (!text || !circle) return;

  text.textContent = Math.max(0, seconds);
  const circumference = 2 * Math.PI * 54; // r=54
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
function placeBidAmount(amount) {
  socket.emit('bid', { amount });
}

function placeBid() {
  const input = document.getElementById('custom-bid');
  const val = parseInt(input.value);
  if (!val || val <= 0) return;
  socket.emit('bid', { amount: val });
  input.value = '';
}

// Enter key on custom bid
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

function nominateTeam() {
  if (!selectedNominateTeamId) return;
  const startingBid = parseInt(document.getElementById('starting-bid').value) || 1;
  socket.emit('nominate', { teamId: selectedNominateTeamId, startingBid });
  toggleAdmin();
}

function pauseAuction() { socket.emit('pause'); }
function resumeAuction() { socket.emit('resume'); }
function skipAuction() {
  if (confirm('Cancel the current auction?')) socket.emit('skip');
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

function saveTeamEdit(id, btn) {
  const row = btn.closest('.edit-team-row');
  const seed = parseInt(row.querySelector('.edit-seed').value);
  const region = row.querySelector('.edit-region').value;
  const name = row.querySelector('.edit-name').value.trim();
  if (!name) return;
  socket.emit('update-team', { id, name, seed, region }, (res) => {
    if (res.success) toast('Team updated', 'success');
  });
}

// Import
function importTeams() {
  const text = document.getElementById('import-textarea').value.trim();
  if (!text) return;

  const lines = text.split('\n');
  const teamsData = [];
  let currentRegion = 'East';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Region header
    const regionMatch = trimmed.match(/^\[(.+)\]$/);
    if (regionMatch) {
      currentRegion = regionMatch[1].trim();
      continue;
    }

    // Team line: "1 Duke" or "1. Duke"
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
    socket.emit('import-teams', teamsData, (res) => {
      if (res.error) toast(res.error, 'error');
      else toast(`Imported ${res.count} teams`, 'success');
    });
  }
}

// Settings
function saveSettings() {
  const timer = parseInt(document.getElementById('setting-timer').value) || 15;
  const increment = parseInt(document.getElementById('setting-increment').value) || 1;
  socket.emit('update-settings', { timerDuration: timer, bidIncrement: increment });
  toast('Settings saved', 'success');
}

function resetAll() {
  if (confirm('Reset ALL auctions? This will clear all bids and team ownership. This cannot be undone.')) {
    if (confirm('Are you absolutely sure?')) {
      socket.emit('reset-all');
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
