/**
 * Vercel KV (Upstash Redis) wrapper for all Calcutta state.
 *
 * Keys:
 *   teams              – JSON array of all team objects
 *   users              – JSON hash { id: { id, name } }
 *   bids               – JSON array of all bid records
 *   auction            – JSON object (live auction state)
 *   settings           – JSON { bidIncrement, timerDuration }
 *   chat               – JSON array of recent chat messages (last 100)
 *   session:{token}    – JSON { userId, userName } with TTL
 *   heartbeat:{userId} – "1" with 30s TTL
 */

const { kv } = require('@vercel/kv');

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_AUCTION = {
  status: 'waiting',
  currentTeamId: null,
  highBid: 0,
  highBidderId: null,
  highBidderName: '',
  timerDeadline: null,
  pausedRemaining: null,
  bidHistory: []
};

const DEFAULT_SETTINGS = { bidIncrement: 1, timerDuration: 15 };

const DEFAULT_TEAMS = (() => {
  const regions = {
    East: [
      'Duke','Alabama','Purdue','Marquette','Clemson',
      'BYU',"St. John's",'Mississippi St','Nebraska','New Mexico',
      'Drake','UC San Diego','Vermont','Colgate','UNC Asheville','Norfolk St'
    ],
    West: [
      'Houston','Tennessee','Wisconsin','Arizona','Michigan',
      'Illinois','UCLA','San Diego St','Boise St','Utah St',
      'VCU','Liberty','Iona','Montana St','Robert Morris','Southern'
    ],
    South: [
      'Auburn','Iowa St','Florida','Texas A&M','Michigan St',
      'Ole Miss','Baylor','Memphis','Arkansas','Oklahoma',
      'Xavier','McNeese St','High Point','Morehead St','Grambling St','Stetson'
    ],
    Midwest: [
      'UConn','Kansas','Gonzaga','Kentucky','Texas Tech',
      'North Carolina','Creighton','Oregon','Colorado St','Indiana',
      'Pittsburgh','Grand Canyon','Samford','Oakland','Montana','Howard'
    ]
  };
  let id = 1;
  const teams = [];
  for (const [region, names] of Object.entries(regions)) {
    names.forEach((name, i) => {
      teams.push({ id: id++, name, seed: i + 1, region, owner_id: null, owner_name: null, winning_bid: 0, status: 'available' });
    });
  }
  return teams;
})();

// ─── Init (called on first request if keys don't exist) ─────────────────────

async function ensureInitialized() {
  const existing = await kv.get('teams');
  if (!existing) {
    await kv.set('teams', DEFAULT_TEAMS);
    await kv.set('users', {});
    await kv.set('bids', []);
    await kv.set('auction', DEFAULT_AUCTION);
    await kv.set('settings', DEFAULT_SETTINGS);
    await kv.set('chat', []);
  }
}

// ─── Teams ───────────────────────────────────────────────────────────────────

async function getTeams() {
  return (await kv.get('teams')) || [];
}

async function setTeams(teams) {
  await kv.set('teams', teams);
}

// ─── Users ───────────────────────────────────────────────────────────────────

async function getUsers() {
  return (await kv.get('users')) || {};
}

async function upsertUser(id, name) {
  const users = await getUsers();
  users[id] = { id, name };
  await kv.set('users', users);
  return users[id];
}

// ─── Bids ────────────────────────────────────────────────────────────────────

async function getBids() {
  return (await kv.get('bids')) || [];
}

async function addBid(bid) {
  const bids = await getBids();
  bids.push(bid);
  await kv.set('bids', bids);
}

async function clearBids() {
  await kv.set('bids', []);
}

// ─── Auction state ───────────────────────────────────────────────────────────

async function getAuction() {
  return (await kv.get('auction')) || { ...DEFAULT_AUCTION };
}

async function setAuction(auction) {
  await kv.set('auction', auction);
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  return (await kv.get('settings')) || { ...DEFAULT_SETTINGS };
}

async function setSettings(settings) {
  await kv.set('settings', settings);
}

// ─── Chat ────────────────────────────────────────────────────────────────────

async function getChat() {
  return (await kv.get('chat')) || [];
}

async function addChatMessage(message) {
  const messages = await getChat();
  messages.push(message);
  // Keep last 100 messages
  const trimmed = messages.slice(-100);
  await kv.set('chat', trimmed);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

async function setSession(token, userId, userName) {
  await kv.set(`session:${token}`, { userId, userName }, { ex: 14400 }); // 4h TTL
}

async function getSession(token) {
  if (!token) return null;
  return kv.get(`session:${token}`);
}

// ─── Heartbeats (online presence) ────────────────────────────────────────────

async function heartbeat(userId) {
  await kv.set(`heartbeat:${userId}`, '1', { ex: 30 });
}

async function getOnlineUserIds(userIds) {
  if (userIds.length === 0) return [];
  const pipeline = kv.pipeline();
  for (const id of userIds) pipeline.get(`heartbeat:${id}`);
  const results = await pipeline.exec();
  return userIds.filter((_, i) => results[i] !== null);
}

// ─── Check deadline & finalize auction ───────────────────────────────────────

async function checkAndFinalizeAuction() {
  const auction = await getAuction();
  if (auction.status !== 'active' || !auction.timerDeadline) return auction;

  const now = Date.now();
  if (now < auction.timerDeadline) return auction;

  // Deadline passed — try to acquire finalization lock
  const lockAcquired = await kv.set('auction:finalizing', '1', { nx: true, ex: 10 });
  if (!lockAcquired) {
    // Another request is finalizing; return current state
    return getAuction();
  }

  try {
    // Re-read to avoid race
    const fresh = await getAuction();
    if (fresh.status !== 'active' || !fresh.timerDeadline || Date.now() < fresh.timerDeadline) {
      return fresh;
    }

    const teams = await getTeams();

    if (fresh.highBidderId) {
      // Sold
      const idx = teams.findIndex(t => t.id === fresh.currentTeamId);
      if (idx >= 0) {
        const users = await getUsers();
        teams[idx].status = 'sold';
        teams[idx].owner_id = fresh.highBidderId;
        teams[idx].owner_name = users[fresh.highBidderId]?.name || '?';
        teams[idx].winning_bid = fresh.highBid;
        await setTeams(teams);
      }

      fresh.status = 'sold';
      fresh.soldTeamName = teams[idx]?.name || '';
      fresh.soldWinnerName = fresh.highBidderName;
      fresh.soldAmount = fresh.highBid;
    } else {
      // No bids — revert
      const idx = teams.findIndex(t => t.id === fresh.currentTeamId);
      if (idx >= 0) {
        teams[idx].status = 'available';
        await setTeams(teams);
      }
      fresh.status = 'cancelled';
      fresh.cancelReason = 'No bids placed';
    }

    fresh.timerDeadline = null;
    await setAuction(fresh);
    return fresh;
  } finally {
    await kv.del('auction:finalizing');
  }
}

// ─── Full state for polling ──────────────────────────────────────────────────

async function getFullState() {
  const [teams, users, auction, settings, chat] = await Promise.all([
    getTeams(), getUsers(), checkAndFinalizeAuction(), getSettings(), getChat()
  ]);

  const userList = Object.values(users);
  const onlineIds = await getOnlineUserIds(userList.map(u => u.id));

  // Compute participant totals
  const participants = userList.map(u => {
    const owned = teams.filter(t => t.owner_id === u.id);
    return {
      id: u.id,
      name: u.name,
      total_spent: owned.reduce((s, t) => s + (t.winning_bid || 0), 0),
      teams_owned: owned.length
    };
  });

  // Compute timer seconds remaining
  let timerSeconds = 0;
  if (auction.status === 'active' && auction.timerDeadline) {
    timerSeconds = Math.max(0, Math.ceil((auction.timerDeadline - Date.now()) / 1000));
  }

  return {
    auction: { ...auction, timerSeconds, bidIncrement: settings.bidIncrement, timerDuration: settings.timerDuration },
    teams,
    participants,
    onlineUsers: userList.filter(u => onlineIds.includes(u.id)),
    chat,
    serverTime: Date.now()
  };
}

module.exports = {
  ensureInitialized,
  getTeams, setTeams,
  getUsers, upsertUser,
  getBids, addBid, clearBids,
  getAuction, setAuction,
  getSettings, setSettings,
  getChat, addChatMessage,
  setSession, getSession,
  heartbeat, getOnlineUserIds,
  checkAndFinalizeAuction,
  getFullState,
  DEFAULT_AUCTION, DEFAULT_SETTINGS
};
