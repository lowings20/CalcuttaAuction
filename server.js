const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(path.join(__dirname, 'calcutta.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    seed INTEGER NOT NULL,
    region TEXT NOT NULL,
    owner_id TEXT,
    winning_bid REAL DEFAULT 0,
    status TEXT DEFAULT 'available',
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Seed default teams (64-team bracket) on first run
// ---------------------------------------------------------------------------
const teamCount = db.prepare('SELECT COUNT(*) AS cnt FROM teams').get().cnt;
if (teamCount === 0) {
  const regions = {
    East: [
      'Duke', 'Alabama', 'Purdue', 'Marquette', 'Clemson',
      'BYU', "St. John's", 'Mississippi St', 'Nebraska', 'New Mexico',
      'Drake', 'UC San Diego', 'Vermont', 'Colgate', 'UNC Asheville', 'Norfolk St'
    ],
    West: [
      'Houston', 'Tennessee', 'Wisconsin', 'Arizona', 'Michigan',
      'Illinois', 'UCLA', 'San Diego St', 'Boise St', 'Utah St',
      'VCU', 'Liberty', 'Iona', 'Montana St', 'Robert Morris', 'Southern'
    ],
    South: [
      'Auburn', 'Iowa St', 'Florida', 'Texas A&M', 'Michigan St',
      'Ole Miss', 'Baylor', 'Memphis', 'Arkansas', 'Oklahoma',
      'Xavier', 'McNeese St', 'High Point', 'Morehead St', 'Grambling St', 'Stetson'
    ],
    Midwest: [
      'UConn', 'Kansas', 'Gonzaga', 'Kentucky', 'Texas Tech',
      'North Carolina', 'Creighton', 'Oregon', 'Colorado St', 'Indiana',
      'Pittsburgh', 'Grand Canyon', 'Samford', 'Oakland', 'Montana', 'Howard'
    ]
  };

  const insert = db.prepare('INSERT INTO teams (name, seed, region) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (const [region, teams] of Object.entries(regions)) {
      teams.forEach((name, i) => insert.run(name, i + 1, region));
    }
  });
  tx();
  console.log('Seeded 64 default teams.');
}

// ---------------------------------------------------------------------------
// In-memory auction state
// ---------------------------------------------------------------------------
let auction = {
  status: 'waiting',        // waiting | active | paused | sold
  currentTeamId: null,
  highBid: 0,
  highBidderId: null,
  highBidderName: '',
  timerSeconds: 0,
  bidIncrement: 1,
  timerDuration: 15,
  bidHistory: []
};
let auctionInterval = null;

// Connected users: socketId -> { id, name }
const connectedUsers = new Map();

// ---------------------------------------------------------------------------
// Helper queries
// ---------------------------------------------------------------------------
const getTeams = () => db.prepare('SELECT t.*, u.name AS owner_name FROM teams t LEFT JOIN users u ON t.owner_id = u.id ORDER BY t.region, t.seed').all();
const getUsers = () => db.prepare('SELECT * FROM users ORDER BY name').all();
const getUserTotals = () => db.prepare(`
  SELECT u.id, u.name,
    COALESCE(SUM(t.winning_bid), 0) AS total_spent,
    COUNT(t.id) AS teams_owned
  FROM users u
  LEFT JOIN teams t ON t.owner_id = u.id
  GROUP BY u.id
  ORDER BY u.name
`).all();

function getFullState() {
  return {
    auction,
    teams: getTeams(),
    participants: getUserTotals(),
    onlineUsers: Array.from(connectedUsers.values())
  };
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function startTimer() {
  stopTimer();
  auction.timerSeconds = auction.timerDuration;
  auctionInterval = setInterval(() => {
    auction.timerSeconds--;
    io.emit('auction:timer', auction.timerSeconds);
    if (auction.timerSeconds <= 0) {
      stopTimer();
      endAuction();
    }
  }, 1000);
}

function stopTimer() {
  if (auctionInterval) {
    clearInterval(auctionInterval);
    auctionInterval = null;
  }
}

function endAuction() {
  if (!auction.currentTeamId) return;

  if (auction.highBidderId) {
    db.prepare('UPDATE teams SET status = ?, owner_id = ?, winning_bid = ? WHERE id = ?')
      .run('sold', auction.highBidderId, auction.highBid, auction.currentTeamId);

    const team = db.prepare('SELECT t.*, u.name AS owner_name FROM teams t LEFT JOIN users u ON t.owner_id = u.id WHERE t.id = ?').get(auction.currentTeamId);
    auction.status = 'sold';
    io.emit('auction:sold', {
      team,
      winnerName: auction.highBidderName,
      amount: auction.highBid
    });
  } else {
    db.prepare('UPDATE teams SET status = ? WHERE id = ?').run('available', auction.currentTeamId);
    auction.status = 'waiting';
    io.emit('auction:cancelled', { teamId: auction.currentTeamId, reason: 'No bids placed' });
  }

  setTimeout(() => {
    auction.status = 'waiting';
    auction.currentTeamId = null;
    auction.highBid = 0;
    auction.highBidderId = null;
    auction.highBidderName = '';
    auction.bidHistory = [];
    io.emit('state:sync', getFullState());
  }, 3000);
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // --- Auth ---
  socket.on('auth', (name, callback) => {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return callback({ error: 'Name is required' });
    }
    const trimmed = name.trim();
    let user = db.prepare('SELECT * FROM users WHERE name = ?').get(trimmed);
    if (!user) {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(id, trimmed);
      user = { id, name: trimmed };
    }
    connectedUsers.set(socket.id, { id: user.id, name: user.name });
    io.emit('users:online', Array.from(connectedUsers.values()));
    callback({ user, state: getFullState() });
  });

  // --- Nominate a team for auction ---
  socket.on('nominate', ({ teamId, startingBid }) => {
    if (auction.status === 'active' || auction.status === 'paused') {
      return socket.emit('error:message', 'An auction is already in progress');
    }
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
    if (!team || team.status === 'sold') {
      return socket.emit('error:message', 'Team not available');
    }
    const start = Math.max(1, Number(startingBid) || 1);

    db.prepare('UPDATE teams SET status = ? WHERE id = ?').run('active', teamId);

    auction.status = 'active';
    auction.currentTeamId = teamId;
    auction.highBid = 0;
    auction.highBidderId = null;
    auction.highBidderName = '';
    auction.bidHistory = [];

    io.emit('auction:start', {
      team: { ...team, status: 'active' },
      startingBid: start
    });
    startTimer();
  });

  // --- Place a bid ---
  socket.on('bid', ({ amount }) => {
    if (auction.status !== 'active') {
      return socket.emit('error:message', 'No active auction');
    }
    const user = connectedUsers.get(socket.id);
    if (!user) return socket.emit('error:message', 'Not authenticated');

    const bidAmount = Number(amount);
    if (isNaN(bidAmount) || bidAmount <= auction.highBid) {
      return socket.emit('error:message', `Bid must be greater than $${auction.highBid}`);
    }

    // Record bid
    db.prepare('INSERT INTO bids (team_id, user_id, amount) VALUES (?, ?, ?)')
      .run(auction.currentTeamId, user.id, bidAmount);

    auction.highBid = bidAmount;
    auction.highBidderId = user.id;
    auction.highBidderName = user.name;
    auction.bidHistory.unshift({ userName: user.name, amount: bidAmount, time: Date.now() });

    io.emit('auction:bid', {
      userName: user.name,
      userId: user.id,
      amount: bidAmount,
      bidHistory: auction.bidHistory
    });

    // Reset timer
    startTimer();
  });

  // --- Admin: Pause ---
  socket.on('pause', () => {
    if (auction.status !== 'active') return;
    auction.status = 'paused';
    stopTimer();
    io.emit('auction:paused', auction.timerSeconds);
  });

  // --- Admin: Resume ---
  socket.on('resume', () => {
    if (auction.status !== 'paused') return;
    auction.status = 'active';
    startTimer();
    io.emit('auction:resumed');
  });

  // --- Admin: Skip / Cancel ---
  socket.on('skip', () => {
    if (auction.status !== 'active' && auction.status !== 'paused') return;
    stopTimer();
    db.prepare('UPDATE teams SET status = ? WHERE id = ?').run('available', auction.currentTeamId);
    // Delete bids for this round
    db.prepare('DELETE FROM bids WHERE team_id = ? AND id NOT IN (SELECT id FROM bids WHERE team_id = ? ORDER BY id DESC LIMIT 0)')
      .run(auction.currentTeamId, auction.currentTeamId);

    auction.status = 'waiting';
    auction.currentTeamId = null;
    auction.highBid = 0;
    auction.highBidderId = null;
    auction.highBidderName = '';
    auction.bidHistory = [];
    io.emit('auction:cancelled', { reason: 'Cancelled by admin' });
    io.emit('state:sync', getFullState());
  });

  // --- Admin: Update team ---
  socket.on('update-team', ({ id, name, seed, region }, callback) => {
    db.prepare('UPDATE teams SET name = ?, seed = ?, region = ? WHERE id = ?')
      .run(name, seed, region, id);
    io.emit('state:sync', getFullState());
    if (callback) callback({ success: true });
  });

  // --- Admin: Reset all ---
  socket.on('reset-all', () => {
    stopTimer();
    db.prepare('UPDATE teams SET status = ?, owner_id = NULL, winning_bid = 0').run('available');
    db.prepare('DELETE FROM bids');
    auction = {
      status: 'waiting',
      currentTeamId: null,
      highBid: 0,
      highBidderId: null,
      highBidderName: '',
      timerSeconds: 0,
      bidIncrement: 1,
      timerDuration: 15,
      bidHistory: []
    };
    io.emit('state:sync', getFullState());
  });

  // --- Admin: Update settings ---
  socket.on('update-settings', ({ bidIncrement, timerDuration }) => {
    if (bidIncrement) auction.bidIncrement = Number(bidIncrement);
    if (timerDuration) auction.timerDuration = Number(timerDuration);
    io.emit('settings:update', { bidIncrement: auction.bidIncrement, timerDuration: auction.timerDuration });
  });

  // --- Admin: Bulk import teams ---
  socket.on('import-teams', (teamsData, callback) => {
    try {
      // Reset teams
      db.prepare('DELETE FROM bids');
      db.prepare('DELETE FROM teams');

      const insert = db.prepare('INSERT INTO teams (name, seed, region) VALUES (?, ?, ?)');
      const tx = db.transaction(() => {
        for (const t of teamsData) {
          insert.run(t.name, t.seed, t.region);
        }
      });
      tx();

      auction = {
        status: 'waiting', currentTeamId: null, highBid: 0,
        highBidderId: null, highBidderName: '', timerSeconds: 0,
        bidIncrement: auction.bidIncrement, timerDuration: auction.timerDuration,
        bidHistory: []
      };
      io.emit('state:sync', getFullState());
      if (callback) callback({ success: true, count: teamsData.length });
    } catch (e) {
      if (callback) callback({ error: e.message });
    }
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('users:online', Array.from(connectedUsers.values()));
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ---------------------------------------------------------------------------
// REST endpoints (for initial page load / fallback)
// ---------------------------------------------------------------------------
app.get('/api/state', (req, res) => res.json(getFullState()));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Calcutta Auction running at http://localhost:${PORT}\n`);
});
