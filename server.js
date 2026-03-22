const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ===== GAME STATE =====
const rooms = new Map(); // roomCode -> gameState
const clients = new Map(); // ws -> { roomCode, playerId }

// Player colors
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];
const WIN_SCORE = 30;

// ===== HELPERS =====
function genCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  const d = [];
  for (let i = 1; i <= 84; i++) d.push(i);
  return shuffle(d);
}

// Send to one client
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// Broadcast to all clients in a room
function broadcast(roomCode, type, data) {
  wss.clients.forEach(ws => {
    const info = clients.get(ws);
    if (info && info.roomCode === roomCode) {
      send(ws, type, data);
    }
  });
}

// Build the state each player sees (hides other players' hands)
function playerView(room, playerId) {
  return {
    phase: room.phase,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      color: COLORS[i],
      isHost: p.isHost,
      handSize: p.hand.length,
      // Only send this player's own hand
      hand: p.id === playerId ? p.hand : undefined,
    })),
    deckSize: room.deck.length,
    storytellerIdx: room.storytellerIdx,
    clue: room.clue,
    turnNumber: room.turnNumber,
    // Table cards: only show card IDs when appropriate
    playedCards: room.phase === 'vote' || room.phase === 'reveal'
      ? room.playedCards.map(pc => ({
          cardId: pc.cardId,
          playerId: room.phase === 'reveal' ? pc.playerId : undefined,
        }))
      : room.playedCards.map(() => ({ hidden: true })),
    playedCount: room.playedCards.length,
    totalNeeded: room.players.length,
    // Who has played (without revealing which card)
    hasPlayed: room.playedCards.map(pc => pc.playerId),
    // Votes: only reveal during 'reveal' phase
    votes: room.phase === 'reveal' ? room.votes : undefined,
    myVote: room.votes[playerId],
    votesIn: Object.keys(room.votes).length,
    roundResults: room.phase === 'reveal' ? room.roundResults : undefined,
    storytellerCard: room.phase === 'reveal' ? room.storytellerCard : undefined,
  };
}

// Send updated state to all players in a room
function syncRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  wss.clients.forEach(ws => {
    const info = clients.get(ws);
    if (info && info.roomCode === roomCode) {
      send(ws, 'state', { state: playerView(room, info.playerId) });
    }
  });
}

// ===== SCORING =====
function calculateScores(room) {
  const stId = room.players[room.storytellerIdx].id;
  const stCardIdx = room.playedCards.findIndex(c => c.playerId === stId);
  const nonST = room.players.filter(p => p.id !== stId);

  const stVotes = Object.values(room.votes).filter(v => v === stCardIdx).length;
  const allGuessed = stVotes === nonST.length;
  const noneGuessed = stVotes === 0;
  const allOrNone = allGuessed || noneGuessed;

  const gains = {};
  room.players.forEach(p => { gains[p.id] = 0; });

  const correctGuessers = [];

  if (allOrNone) {
    // Storyteller 0, everyone else 2
    nonST.forEach(p => { gains[p.id] = 2; });
  } else {
    // Storyteller gets 3
    gains[stId] = 3;
    // Correct guessers get 3
    nonST.forEach(p => {
      if (room.votes[p.id] === stCardIdx) {
        gains[p.id] += 3;
        correctGuessers.push(p.name);
      }
    });
  }

  // Bonus: 1 point per vote received on your card (only if not allOrNone)
  if (!allOrNone) {
    nonST.forEach(p => {
      const myIdx = room.playedCards.findIndex(c => c.playerId === p.id);
      const votesOnMe = Object.values(room.votes).filter(v => v === myIdx).length;
      gains[p.id] += votesOnMe;
    });
  }

  // Apply scores
  room.players.forEach(p => { p.score += gains[p.id]; });

  room.roundResults = {
    allOrNone,
    correctGuessers,
    scores: room.players.map(p => ({
      name: p.name,
      gained: gains[p.id],
      total: p.score,
    })),
  };
}

// ===== MESSAGE HANDLER =====
function handleMessage(ws, msg) {
  let data;
  try { data = JSON.parse(msg); } catch { return; }

  const { type } = data;

  // --- CREATE ROOM ---
  if (type === 'create') {
    const { name } = data;
    if (!name) return send(ws, 'error', { message: 'Name required' });

    const roomCode = genCode();
    const playerId = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);

    const room = {
      phase: 'lobby',
      players: [{ id: playerId, name, score: 0, hand: [], isHost: true }],
      deck: makeDeck(),
      storytellerIdx: 0,
      clue: '',
      storytellerCard: null,
      playedCards: [],
      votes: {},
      roundResults: null,
      turnNumber: 0,
    };

    rooms.set(roomCode, room);
    clients.set(ws, { roomCode, playerId });

    send(ws, 'joined', { roomCode, playerId });
    syncRoom(roomCode);
    return;
  }

  // --- JOIN ROOM ---
  if (type === 'join') {
    const { name, roomCode } = data;
    if (!name || !roomCode) return send(ws, 'error', { message: 'Name and room code required' });

    const room = rooms.get(roomCode.toUpperCase());
    if (!room) return send(ws, 'error', { message: 'Room not found' });
    if (room.phase !== 'lobby') return send(ws, 'error', { message: 'Game already started' });
    if (room.players.length >= 6) return send(ws, 'error', { message: 'Room is full (6 max)' });
    if (room.players.find(p => p.name === name)) return send(ws, 'error', { message: 'Name already taken' });

    const playerId = 'p_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4);
    room.players.push({ id: playerId, name, score: 0, hand: [], isHost: false });
    clients.set(ws, { roomCode: roomCode.toUpperCase(), playerId });

    send(ws, 'joined', { roomCode: roomCode.toUpperCase(), playerId });
    syncRoom(roomCode.toUpperCase());
    return;
  }

  // All remaining actions require being in a room
  const info = clients.get(ws);
  if (!info) return send(ws, 'error', { message: 'Not in a room' });
  const { roomCode, playerId } = info;
  const room = rooms.get(roomCode);
  if (!room) return;
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  // --- START GAME ---
  if (type === 'start') {
    if (!player.isHost) return send(ws, 'error', { message: 'Only host can start' });
    if (room.players.length < 3) return send(ws, 'error', { message: 'Need 3+ players' });
    if (room.phase !== 'lobby') return;

    // Deal 6 cards
    room.players.forEach(p => {
      p.hand = [];
      for (let i = 0; i < 6; i++) {
        if (room.deck.length) p.hand.push(room.deck.pop());
      }
    });

    room.phase = 'clue';
    room.storytellerIdx = 0;
    room.turnNumber = 1;
    room.clue = '';
    room.storytellerCard = null;
    room.playedCards = [];
    room.votes = {};
    room.roundResults = null;

    syncRoom(roomCode);
    return;
  }

  // --- SUBMIT CLUE (storyteller) ---
  if (type === 'clue') {
    if (room.phase !== 'clue') return;
    const st = room.players[room.storytellerIdx];
    if (st.id !== playerId) return send(ws, 'error', { message: 'Not the storyteller' });

    const { cardId, clue } = data;
    if (!clue || !cardId) return send(ws, 'error', { message: 'Card and clue required' });
    if (!player.hand.includes(cardId)) return send(ws, 'error', { message: 'Card not in hand' });

    room.clue = clue;
    room.storytellerCard = cardId;
    room.playedCards = [{ playerId, cardId }];
    player.hand = player.hand.filter(c => c !== cardId);

    room.phase = 'play';
    syncRoom(roomCode);
    return;
  }

  // --- PLAY CARD (non-storyteller) ---
  if (type === 'play') {
    if (room.phase !== 'play') return;
    const st = room.players[room.storytellerIdx];
    if (st.id === playerId) return;
    if (room.playedCards.some(c => c.playerId === playerId)) return;

    const { cardId } = data;
    if (!player.hand.includes(cardId)) return send(ws, 'error', { message: 'Card not in hand' });

    room.playedCards.push({ playerId, cardId });
    player.hand = player.hand.filter(c => c !== cardId);

    // All played? Move to vote
    if (room.playedCards.length === room.players.length) {
      room.playedCards = shuffle(room.playedCards);
      room.phase = 'vote';
    }

    syncRoom(roomCode);
    return;
  }

  // --- VOTE ---
  if (type === 'vote') {
    if (room.phase !== 'vote') return;
    const st = room.players[room.storytellerIdx];
    if (st.id === playerId) return; // storyteller can't vote
    if (room.votes[playerId] !== undefined) return; // already voted

    const { cardIndex } = data;
    if (cardIndex < 0 || cardIndex >= room.playedCards.length) return;
    // Can't vote for own card
    if (room.playedCards[cardIndex].playerId === playerId) {
      return send(ws, 'error', { message: "Can't vote for your own card" });
    }

    room.votes[playerId] = cardIndex;

    // All voted?
    const nonST = room.players.filter(p => p.id !== st.id);
    if (nonST.every(p => room.votes[p.id] !== undefined)) {
      calculateScores(room);
      room.phase = 'reveal';
    }

    syncRoom(roomCode);
    return;
  }

  // --- NEXT ROUND ---
  if (type === 'nextRound') {
    if (room.phase !== 'reveal') return;
    const st = room.players[room.storytellerIdx];
    if (st.id !== playerId) return;

    // Check game over
    const winner = room.players.find(p => p.score >= WIN_SCORE);
    if (winner || room.deck.length < room.players.length) {
      room.phase = 'gameover';
      syncRoom(roomCode);
      return;
    }

    // Deal 1 card to each
    room.players.forEach(p => {
      if (room.deck.length) p.hand.push(room.deck.pop());
    });

    // Next storyteller
    room.storytellerIdx = (room.storytellerIdx + 1) % room.players.length;
    room.turnNumber++;
    room.clue = '';
    room.storytellerCard = null;
    room.playedCards = [];
    room.votes = {};
    room.roundResults = null;
    room.phase = 'clue';

    syncRoom(roomCode);
    return;
  }
}

// ===== WEBSOCKET CONNECTIONS =====
wss.on('connection', (ws) => {
  console.log('Client connected. Total:', wss.clients.size);

  ws.on('message', (msg) => handleMessage(ws, msg.toString()));

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      console.log(`Player disconnected from room ${info.roomCode}`);
      // Don't remove from game — they can reconnect
      // (In production you'd add reconnection logic)
    }
    clients.delete(ws);
    console.log('Client disconnected. Total:', wss.clients.size);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ===== CLEANUP stale rooms every 30 minutes =====
setInterval(() => {
  const now = Date.now();
  // Simple cleanup: remove rooms with no connected clients
  for (const [code, room] of rooms) {
    let hasClient = false;
    wss.clients.forEach(ws => {
      const info = clients.get(ws);
      if (info && info.roomCode === code) hasClient = true;
    });
    if (!hasClient) {
      rooms.delete(code);
      console.log(`Cleaned up stale room: ${code}`);
    }
  }
}, 30 * 60 * 1000);

// ===== START =====
server.listen(PORT, () => {
  console.log(`Dixit server running on http://localhost:${PORT}`);
});
