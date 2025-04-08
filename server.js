const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

app.use(express.json());
app.use(express.static('public')); // Serve public folder
const server = http.createServer(app);
const io = new Server(server);

// Load players.json at startup
let playersData = JSON.parse(fs.readFileSync('players.json', 'utf-8')).players;
const matchesFile = path.join(__dirname, 'matches.json');
const usersFile = path.join(__dirname, 'users.json');
// Read existing matches
// Track assigned player IDs to avoid duplicates
let assignedPlayerIds = new Set();
if (fs.existsSync('users.json')) {
  const users = JSON.parse(fs.readFileSync('users.json'));
  users.forEach(user => {
    Object.values(user.players).flat().forEach(player => {
      assignedPlayerIds.add(player.id);
    });
  });
}

// Helper to get lowest-rated unassigned players
function getLowestRatedPlayers(position, count = 1) {
  const players = playersData[position];
  if (!players || players.length === 0) return [];

  const unassigned = players.filter(p => !assignedPlayerIds.has(p.id));

  const sorted = [...unassigned].sort((a, b) => a.rating - b.rating);

  const selectedPlayers = count === 1 ? [sorted[0]] : sorted.slice(0, count);

  selectedPlayers.forEach(p => assignedPlayerIds.add(p.id));

  return count === 1 ? selectedPlayers[0] : selectedPlayers;
}
let waitingUsers = [];
let matches = [];

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('joinQueue', (username) => {
        waitingUsers.push({ username, socketId: socket.id });

        if (waitingUsers.length >= 2) {
            const [player1, player2] = waitingUsers.splice(0, 2);
            const matchId = `${player1.username}_${player2.username}`;
            const matchLink = `/matchx?id=${matchId}`;

            matches.push({ matchId, link: matchLink });

            io.to(player1.socketId).emit('matchFound', { link: matchLink });
            io.to(player2.socketId).emit('matchFound', { link: matchLink });
        }
    });

    socket.on('disconnect', () => {
        waitingUsers = waitingUsers.filter(user => user.socketId !== socket.id);
        console.log('User disconnected:', socket.id);
    });
});

// Register endpoint
app.post('/register', (req, res) => {
  const { teamName, playerName, password } = req.body;

  if (!teamName || !playerName || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let users = [];
  if (fs.existsSync('users.json')) {
    users = JSON.parse(fs.readFileSync('users.json'));

    if (users.find(u => u.playerName === playerName)) {
      return res.status(400).json({ error: 'Player name already taken' });
    }
  }

  const assignedPlayers = {
    cf: getLowestRatedPlayers('cf'),
    rwf: getLowestRatedPlayers('rwf'),
    lwf: getLowestRatedPlayers('lwf'),
    mf: getLowestRatedPlayers('mf', 3),
    df: getLowestRatedPlayers('df', 4),
    gk: getLowestRatedPlayers('gk'),
    subs: getLowestRatedPlayers('subs', 3),
  };

  const userData = {
    teamName,
    playerName,
    password, // You should hash this in production!
    players: assignedPlayers,
    coins: 500
  };

  users.push(userData);
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));

  res.json({ message: 'Team created successfully!', players: assignedPlayers, coins: 500 });
});

app.post('/login', (req, res) => {
  const { playerName, password } = req.body;

  if (!playerName || !password) {
    return res.status(400).json({ error: 'Player name and password are required' });
  }

  // Check if users.json exists
  if (!fs.existsSync('users.json')) {
    return res.status(404).json({ error: 'Users data not found' });
  }

  // Read the users data
  const users = JSON.parse(fs.readFileSync('users.json'));

  // Find the user by player name
  const user = users.find(u => u.playerName === playerName);

  // If user not found
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Check if the password matches
  if (user.password !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  // Return user data (excluding password for security)
  const { password: _, ...userData } = user;

  res.json({
    message: 'Login successful',
    user: userData
  });
});

// Fetch user team endpoint
app.get('/team/:playerName', (req, res) => {
  const { playerName } = req.params;

  if (!fs.existsSync('users.json')) {
    return res.status(404).json({ error: 'No users found' });
  }

  const users = JSON.parse(fs.readFileSync('users.json'));
  const user = users.find(u => u.playerName === playerName);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json({
    teamName: user.teamName,
    playerName: user.playerName,
    players: user.players,
    coins: user.coins
  });
});

// Fetch player by ID
app.get('/player/:id', (req, res) => {
  const playerId = parseInt(req.params.id);

  let foundPlayer = null;

  for (const position in playersData) {
    const player = playersData[position].find(p => p.id === playerId);
    if (player) {
      foundPlayer = player;
      break;
    }
  }

  if (!foundPlayer) {
    return res.status(404).json({ error: 'Player not found' });
  }

  res.json({
    id: foundPlayer.id,
    name: foundPlayer.name,
    rating: foundPlayer.rating
  });
});

// Helper: Get player position from players.json by ID
function getPlayerRealPosition(playerId) {
  for (const position in playersData) {
    const player = playersData[position].find(p => p.id === playerId);
    if (player) {
      return position;
    }
  }
  return null;
}

// Substitute endpoint with real position checking
app.post('/substitute', (req, res) => {
  const { playerName, outPlayerId, inPlayerId } = req.body;

  if (!playerName || outPlayerId === undefined || inPlayerId === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!fs.existsSync('users.json')) {
    return res.status(404).json({ error: 'No users found' });
  }

  const users = JSON.parse(fs.readFileSync('users.json'));
  const userIndex = users.findIndex(u => u.playerName === playerName);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = users[userIndex];
  let outPlayerPos = null;
  let outPlayerData = null;
  let inPlayerPos = null;
  let inPlayerData = null;

  // Step 1: Find both players in user's team
  for (const position in user.players) {
    const playersInPosition = Array.isArray(user.players[position]) ? user.players[position] : [user.players[position]];

    playersInPosition.forEach(player => {
      if (player.id === outPlayerId) {
        outPlayerPos = position;
        outPlayerData = player;
      }
      if (player.id === inPlayerId) {
        inPlayerPos = position;
        inPlayerData = player;
      }
    });
  }

  if (!outPlayerData || !inPlayerData) {
    return res.status(404).json({ error: 'Both players must be in your team to substitute' });
  }

  // Step 2: Get real positions from players.json
  const realOutPosition = getPlayerRealPosition(outPlayerId);
  const realInPosition = getPlayerRealPosition(inPlayerId);

  if (!realOutPosition || !realInPosition) {
    return res.status(404).json({ error: 'Player not found in players database' });
  }

  // Step 3: Allow substitution only if real positions match
  if (realOutPosition !== realInPosition) {
    return res.status(400).json({ error: `Invalid substitution: ${realOutPosition.toUpperCase()} can only be swapped with ${realOutPosition.toUpperCase()}` });
  }

  // Step 4: Perform the substitution in user data
  const swapPlayers = (positionKey) => {
    if (Array.isArray(user.players[positionKey])) {
      user.players[positionKey] = user.players[positionKey].map(player => {
        if (player.id === outPlayerId) return inPlayerData;
        if (player.id === inPlayerId) return outPlayerData;
        return player;
      });
    } else {
      if (user.players[positionKey].id === outPlayerId) user.players[positionKey] = inPlayerData;
      else if (user.players[positionKey].id === inPlayerId) user.players[positionKey] = outPlayerData;
    }
  };

  // Swap positions in user.players
  swapPlayers(outPlayerPos);
  if (outPlayerPos !== inPlayerPos) {
    swapPlayers(inPlayerPos);
  }

  // Save changes
  users[userIndex] = user;
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));

  res.json({ message: 'Substitution completed successfully', players: user.players });
});

// Add new player to subs endpoint
app.post('/add-sub', (req, res) => {
  const { playerName, newPlayerId, amount } = req.body;

  if (!playerName || newPlayerId === undefined || amount === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!fs.existsSync('users.json')) {
    return res.status(404).json({ error: 'No users found' });
  }

  const users = JSON.parse(fs.readFileSync('users.json'));
  const userIndex = users.findIndex(u => u.playerName === playerName);

  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = users[userIndex];

  // Check if user has enough coins
  if (user.coins < amount) {
    return res.status(400).json({ error: 'Not enough coins' });
  }

  // Step 1: Find the player in players.json
  let foundPlayer = null;
  for (const position in playersData) {
    const player = playersData[position].find(p => p.id === newPlayerId);
    if (player) {
      foundPlayer = player;
      break;
    }
  }

  if (!foundPlayer) {
    return res.status(404).json({ error: 'Player not found in database' });
  }

  // Step 2: Check if player is already assigned
  if (assignedPlayerIds.has(foundPlayer.id)) {
    return res.status(400).json({ error: 'Player is already assigned to a team' });
  }

  // Step 3: Add to user's subs
  if (!Array.isArray(user.players.subs)) {
    user.players.subs = [];
  }

  user.players.subs.push(foundPlayer);

  // Step 4: Deduct coins and mark player as assigned
  user.coins -= amount;
  assignedPlayerIds.add(foundPlayer.id);

  // Step 5: Save updated data
  users[userIndex] = user;
  fs.writeFileSync('users.json', JSON.stringify(users, null, 2));

  res.json({
    message: 'Player added to substitutes and coins deducted successfully!',
    player: foundPlayer,
    remainingCoins: user.coins
  });
});

// Add to waiting list endpoint
app.post('/add-to-waiting', (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required' });
  }

  // Verify user exists
  if (!fs.existsSync('users.json')) {
    return res.status(404).json({ error: 'Users data not found' });
  }

  const users = JSON.parse(fs.readFileSync('users.json'));
  const userExists = users.some(u => u.playerName === username);
  
  if (!userExists) {
    return res.status(404).json({ error: 'User not found' });
  }

  // Read and update waiting list
  fs.readFile(waitingFile, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to read waiting list' });
    }

    let waitingList = JSON.parse(data);
    
    // Prevent duplicate entries
    if (waitingList.includes(username)) {
      return res.json({ message: 'User already in waiting list', waiting: true });
    }

    // Add the user to the waiting list
    waitingList.push(username);

    // If there are at least 2 players, match them
    if (waitingList.length >= 2) {
      const shuffled = [...waitingList].sort(() => 0.5 - Math.random());
      const matchedPlayers = shuffled.slice(0, 2);
      
      // Remove matched players from waiting list
      waitingList = waitingList.filter(player => !matchedPlayers.includes(player));

      // Save updated waiting list
      fs.writeFile(waitingFile, JSON.stringify(waitingList), (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to update waiting list' });
        }

        return res.json({ matched: matchedPlayers });
      });
    } else {
      // Save updated waiting list
      fs.writeFile(waitingFile, JSON.stringify(waitingList), (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to update waiting list' });
        }

        return res.json({ waiting: true });
      });
    }
  });
});

// Utility to get random int in range
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper to extract players by role from your JSON format
function extractPlayersByPosition(team, positions) {
  const players = [];

  positions.forEach(pos => {
    switch (pos) {
      case 'CF':
      case 'ST':
        if (team.players.cf) players.push({ ...team.players.cf, position: 'CF' });
        break;
      case 'RWF':
      case 'RW':
        if (team.players.rwf) players.push({ ...team.players.rwf, position: 'RW' });
        break;
      case 'LWF':
      case 'LW':
        if (team.players.lwf) players.push({ ...team.players.lwf, position: 'LW' });
        break;
      case 'MF':
      case 'CM':
      case 'CDM':
      case 'CAM':
      case 'LM':
      case 'RM':
        if (Array.isArray(team.players.mf)) {
          team.players.mf.forEach(mf => players.push({ ...mf, position: 'MF' }));
        }
        break;
      case 'DF':
      case 'CB':
      case 'LB':
      case 'RB':
      case 'LWB':
      case 'RWB':
        if (Array.isArray(team.players.df)) {
          team.players.df.forEach(df => players.push({ ...df, position: 'DF' }));
        }
        break;
      case 'GK':
        if (team.players.gk) players.push({ ...team.players.gk, position: 'GK' });
        break;
    }
  });

  return players;
}

// Simulate goals function
function simulateGoals(attackingTeam, defendingTeam) {
  const attackers = extractPlayersByPosition(attackingTeam, ['CF', 'ST', 'RW', 'RWF', 'LW', 'LWF']);
  const midfielders = extractPlayersByPosition(attackingTeam, ['MF', 'CM', 'CDM', 'CAM', 'LM', 'RM']);
  const defenders = extractPlayersByPosition(defendingTeam, ['DF', 'CB', 'LB', 'RB', 'LWB', 'RWB']);
  const goalkeepers = extractPlayersByPosition(defendingTeam, ['GK']);
  const goalkeeper = goalkeepers.length > 0 ? goalkeepers[0] : null;

  const attackRating = attackers.reduce((sum, p) => sum + p.rating, 0) / (attackers.length || 1);
  const midfieldRating = midfielders.reduce((sum, p) => sum + p.rating, 0) / (midfielders.length || 1);
  const defenseRating = defenders.reduce((sum, p) => sum + p.rating, 0) / (defenders.length || 1);
  const goalkeeperRating = goalkeeper ? goalkeeper.rating : 50; // assume weak GK if none

  const chanceFactor = ((attackRating * 0.6 + midfieldRating * 0.4) - (defenseRating * 0.6 + goalkeeperRating * 0.4)) / 100;
  const totalShots = Math.max(randomInt(5, 12) + Math.floor(chanceFactor * 10), 2);
  const totalGoals = Math.max(Math.floor(totalShots * (0.1 + chanceFactor + Math.random() * 0.15)), 0);

  const goals = [];

  for (let i = 0; i < totalGoals; i++) {
    const scorer = attackers[randomInt(0, attackers.length - 1)];
    const assist = midfielders.length > 0 ? midfielders[randomInt(0, midfielders.length - 1)] : null;
    const minute = randomInt(1, 90);

    goals.push({
      scorer: scorer.name,
      assist: assist ? assist.name : null,
      minute,
      position: scorer.position
    });
  }

  return {
    totalGoals,
    totalShots,
    goals
  };
}

// Store matches in memory (or use a database in production)
const activeMatches = new Map();

// Generate unique match ID
function generateMatchId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Updated match endpoint
app.post('/match', (req, res) => {
  const { player1, player2 } = req.body;

  if (!player1 || !player2) {
    return res.status(400).json({ error: 'Both player names are required' });
  }

  fs.readFile(usersFile, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Failed to read users data' });

    const users = JSON.parse(data);
    const team1 = users.find(u => u.playerName === player1);
    const team2 = users.find(u => u.playerName === player2);

    if (!team1 || !team2) return res.status(404).json({ error: 'One or both users not found' });

    const matchId = generateMatchId();

    const team1Goals = simulateGoals(team1, team2);
    const team2Goals = simulateGoals(team2, team1);

    const scoreDiff = team1Goals.totalGoals - team2Goals.totalGoals;
    let winner = null;
    let coinReward = 0;

    if (team1Goals.totalGoals > team2Goals.totalGoals) {
      winner = team1.playerName;
      coinReward = 500 + Math.min(scoreDiff, 5) * 100;
    } else if (team2Goals.totalGoals > team1Goals.totalGoals) {
      winner = team2.playerName;
      coinReward = 500 + Math.min(scoreDiff, 5) * 100;
    } else {
      coinReward = 250;
    }

    const updatedUsers = users.map(user => {
      if (user.playerName === winner) {
        return { ...user, coins: (user.coins || 0) + coinReward };
      } else if (team1Goals.totalGoals === team2Goals.totalGoals &&
        (user.playerName === player1 || user.playerName === player2)) {
        return { ...user, coins: (user.coins || 0) + coinReward };
      }
      return user;
    });

    fs.writeFile(usersFile, JSON.stringify(updatedUsers), (err) => {
      if (err) return res.status(500).json({ error: 'Failed to update users data' });

      // Combine and sort goals by minute
      const allGoals = [
        ...team1Goals.goals.map(g => ({ ...g, team: team1.teamName || team1.playerName })),
        ...team2Goals.goals.map(g => ({ ...g, team: team2.teamName || team2.playerName }))
      ].sort((a, b) => a.minute - b.minute);

      // Count goals per player for top scorer
      const scorerMap = {};
      allGoals.forEach(goal => {
        if (!scorerMap[goal.scorer]) scorerMap[goal.scorer] = 0;
        scorerMap[goal.scorer]++;
      });

      const topScorerGoals = Math.max(...Object.values(scorerMap), 0);
      const topScorers = Object.keys(scorerMap).filter(scorer => scorerMap[scorer] === topScorerGoals);

      const team1Possession = Math.floor(Math.random() * 20) + 40;
      const team2Possession = 100 - team1Possession;

      const matchResult = {
        matchId,
        winner,
        stats: {
          team1Goals: team1Goals.totalGoals,
          team2Goals: team2Goals.totalGoals,
          team1Shots: team1Goals.totalShots,
          team2Shots: team2Goals.totalShots,
          team1Possession,
          team2Possession,
          team1Corners: Math.floor(team1Goals.totalGoals * 1.5) + randomInt(1, 3),
          team2Corners: Math.floor(team2Goals.totalGoals * 1.5) + randomInt(1, 3),
          team1Fouls: randomInt(5, 15),
          team2Fouls: randomInt(5, 15),
          coinReward
        },
        goals: allGoals.map(goal => ({
          minute: goal.minute,
          scorer: goal.scorer,
          assist: goal.assist,
          team: goal.team,
          position: goal.position
        })),
        topScorers: topScorers.map(name => ({
          name,
          goals: topScorerGoals
        }))
      };

      // Store match in memory
      activeMatches.set(matchId, matchResult);

      // Save match to matches.json
      const matchesFile = path.join(__dirname, 'matches.json');
      
      fs.readFile(matchesFile, 'utf8', (err, data) => {
        let matches = {};
        if (!err && data) {
          try {
            matches = JSON.parse(data);
          } catch (parseError) {
            console.error('Error parsing matches.json:', parseError);
          }
        }
        
        matches[matchId] = matchResult;
        
        fs.writeFile(matchesFile, JSON.stringify(matches), (err) => {
          if (err) {
            console.error('Failed to save match to matches.json:', err);
            // Still return the match result even if saving fails
            return res.json(matchResult);
          }
          return res.json(matchResult);
        });
      });
    });
  });
});

// New endpoint to get match result by ID
app.get('/match-result', (req, res) => {
  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Match ID is required' });
  }

  // Check active memory first
  const match = activeMatches.get(id);
  if (match) {
    return res.json(match);
  }

  // Fallback: check saved matches.json
  const matchesFile = path.join(__dirname, 'matches.json');
  
  fs.readFile(matchesFile, 'utf8', (err, data) => {
    if (err) {
      // If file doesn't exist, return not found
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'Match not found' });
      }
      console.error('Error reading matches.json:', err);
      return res.status(500).json({ error: 'Failed to read saved matches' });
    }

    try {
      const matches = data ? JSON.parse(data) : {};
      const savedMatch = matches[id];

      if (!savedMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      return res.json(savedMatch);
    } catch (parseError) {
      console.error('Error parsing matches.json:', parseError);
      return res.status(500).json({ error: 'Failed to parse saved matches' });
    }
  });
});

// Updated check-match endpoint
app.get('/check-match', (req, res) => {
  const waitingFile = path.join(__dirname, 'waiting.json');
  
  fs.readFile(waitingFile, 'utf8', (err, data) => {
    if (err && err.code !== 'ENOENT') {
      return res.status(500).json({ error: 'Failed to read waiting list' });
    }

    let waitingList = data ? JSON.parse(data) : [];
    
    if (waitingList.length >= 2) {
      const shuffled = [...waitingList].sort(() => 0.5 - Math.random());
      const matchedPlayers = shuffled.slice(0, 2);
      
      // Remove matched players from waiting list
      waitingList = waitingList.filter(player => !matchedPlayers.includes(player));
      
      // Save updated waiting list
      fs.writeFile(waitingFile, JSON.stringify(waitingList), (err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to update waiting list' });
        }
        
        return res.json({ 
          matched: matchedPlayers,
          matchId: generateMatchId() // Send match ID immediately
        });
      });
    } else {
      return res.json({ waiting: true });
    }
  });
});

// Serve match.html
// in app.js or wherever your server is defined
app.get('/matchx', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'matchx.html'));
});

const waitFile = './wait.json';

// Helper to read and write JSON
function readWaitList() {
  return JSON.parse(fs.readFileSync(waitFile, 'utf-8'));
}

function writeWaitList(data) {
  fs.writeFileSync(waitFile, JSON.stringify(data, null, 2));
}

// Route to add user
app.get('/wait/add', (req, res) => {
  const username = req.query.q;

  if (!username) {
    return res.status(400).json({ error: 'Username (q) is required' });
  }

  const data = readWaitList();

  if (data.waiting.includes(username)) {
    return res.status(400).json({ error: 'User already in waiting list' });
  }

  data.waiting.push(username);
  writeWaitList(data);

  res.json({ message: 'User added to waiting list', waiting: data.waiting });
});

// Route to remove user
app.get('/wait/remove', (req, res) => {
  const username = req.query.q;

  if (!username) {
    return res.status(400).json({ error: 'Username (q) is required' });
  }

  const data = readWaitList();

  if (!data.waiting.includes(username)) {
    return res.status(400).json({ error: 'User not found in waiting list' });
  }

  data.waiting = data.waiting.filter(user => user !== username);
  writeWaitList(data);

  res.json({ message: 'User removed from waiting list', waiting: data.waiting });
});

// Route to list users
app.get('/wait/list', (req, res) => {
  const data = readWaitList();
  res.json({ waiting: data.waiting });
});

// Other endpoints (get-waiting-list, check-match, remove-from-waiting) remain the same
// ... [include the other endpoints from your original code]

const filePath = path.join(__dirname, 'links.json');

let links = [];
if (fs.existsSync(filePath)) {
    try {
        links = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        links = [];
    }
}

function saveLinks() {
    fs.writeFileSync(filePath, JSON.stringify(links, null, 2));
}

function removeOldLinks() {
    const oneMinuteAgo = new Date(Date.now() - 60000);
    links = links.filter(link => new Date(link.addedAt) > oneMinuteAgo);
    saveLinks();
}

setInterval(removeOldLinks, 30000);

app.get('/add', (req, res) => {
    const { link, q } = req.query;
    if (!link) return res.status(400).send('Missing link');
    links = links.filter(item => item.q !== q);
    links.push({ link, q, addedAt: new Date().toISOString() });
    saveLinks();
    res.json({ message: 'Link saved' });
});

// Sample backend data store
// Example: [{ q: 'user1_user2', link: '...', joined: ['user1'] }]

// /check-link?q=user1_user2&player=user1
// Sample backend data store
 // Example: [{ q: 'user1_user2', link: '...', joined: ['user1'] }]

// /check-link?q=user1_user2&player=user1
app.get('/check-link', (req, res) => {
  const { q, player } = req.query;
  const match = links.find(item => item.q === q);

  if (!match) return res.json({ exists: false });

  // Track who joined
  if (!match.joined) match.joined = [];
  if (!match.joined.includes(player)) match.joined.push(player);

  // If both players have joined, schedule link removal
  if (match.joined.length >= 2 && !match.cleanupScheduled) {
    match.cleanupScheduled = true; // prevent multiple timeouts
    setTimeout(() => {
      const index = links.findIndex(item => item.q === q);
      if (index !== -1) links.splice(index, 1); // Remove the link
    }, 50000); // 50 seconds
  }

  res.json({ exists: true });
});

const PROGRESS_PATH = 'progress.json';
const USERS_PATH = 'users.json';

app.post('/playMatch', (req, res) => {
  const { playerName } = req.body;

  const users = JSON.parse(fs.readFileSync(USERS_PATH));
  const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH));

  const userIndex = users.findIndex(u => u.playerName === playerName);
  if (userIndex === -1) return res.status(404).json({ error: 'User not found' });

  const user = users[userIndex];

  if (!progress[playerName]) {
    progress[playerName] = {
      wins: 0,
      draws: 0,
      losses: 0,
      eventCompleted: false
    };
  }

  const aiTeam = generateAITeam();
  const userRating = calculateTeamRating(user.players);
  const aiRating = calculateTeamRating(aiTeam);

  const matchData = simulateMatchDetailed(user.players, aiTeam);
  const result = matchData.result;

  if (result === 'win') {
    progress[playerName].wins += 1;
    user.coins += 0;
  } else if (result === 'draw') {
    progress[playerName].draws += 1;
    user.coins += 0;
  } else {
    progress[playerName].losses += 1;
  }

  if (!progress[playerName].eventCompleted && progress[playerName].wins >= 3) {
    progress[playerName].eventCompleted = true;
    user.coins += 400;
    matchData.eventReward = true;
  } else {
    matchData.eventReward = false;
  }

  users[userIndex] = user;

  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));

  res.json({
    ...matchData,
    userRating,
    aiRating,
    coins: user.coins,
    progress: progress[playerName]
  });
});

function generateAITeam() {
  const names = ['Phantom', 'Shadow', 'Talon', 'Blitz', 'Storm', 'Zephyr', 'Fury', 'Ghost', 'Hawk', 'Viper'];
  const randName = () => names[Math.floor(Math.random() * names.length)] + ' #' + Math.floor(Math.random() * 90 + 10);
  const rand = () => Math.floor(Math.random() * 11) + 75;

  return {
    cf: { id: 1000, name: randName(), rating: rand() },
    rwf: { id: 1001, name: randName(), rating: rand() },
    lwf: { id: 1002, name: randName(), rating: rand() },
    mf: [
      { id: 1003, name: randName(), rating: rand() },
      { id: 1004, name: randName(), rating: rand() },
      { id: 1005, name: randName(), rating: rand() }
    ],
    df: [
      { id: 1006, name: randName(), rating: rand() },
      { id: 1007, name: randName(), rating: rand() },
      { id: 1008, name: randName(), rating: rand() },
      { id: 1009, name: randName(), rating: rand() }
    ],
    gk: { id: 1010, name: randName(), rating: rand() }
  };
}

function calculateTeamRating(players) {
  let total = 0, count = 0;
  for (const pos in players) {
    const pList = Array.isArray(players[pos]) ? players[pos] : [players[pos]];
    pList.forEach(p => {
      total += p.rating;
      count++;
    });
  }
  return Math.round(total / count);
}

function simulateMatchDetailed(userPlayers, aiPlayers) {
  function getOffensiveRating(players) {
    const offensivePositions = ['cf', 'rwf', 'lwf', 'mf'];
    let total = 0, count = 0;
    for (const pos of offensivePositions) {
      const pList = Array.isArray(players[pos]) ? players[pos] : [players[pos]];
      pList.forEach(p => {
        total += p.rating;
        count++;
      });
    }
    return total / count;
  }

  function getDefensiveRating(players) {
    const defList = Array.isArray(players.df) ? players.df : [players.df];
    const gk = players.gk;
    const all = [...defList, gk];
    const total = all.reduce((sum, p) => sum + p.rating, 0);
    return total / all.length;
  }

  function calculateGoals(attack, defense) {
    const base = 1.2;
    const diff = attack - defense;
    const multiplier = 1 + (diff / 50);
    const randomness = Math.random() * 1.5;
    return Math.max(0, Math.round(base * multiplier + randomness));
  }

  const userAttack = getOffensiveRating(userPlayers);
  const userDefense = getDefensiveRating(userPlayers);
  const aiAttack = getOffensiveRating(aiPlayers);
  const aiDefense = getDefensiveRating(aiPlayers);

  const userGoals = calculateGoals(userAttack, aiDefense);
  const aiGoals = calculateGoals(aiAttack, userDefense);

  const result = userGoals > aiGoals ? 'win' : userGoals < aiGoals ? 'loss' : 'draw';

  const allUserPlayers = Object.values(userPlayers).flat().flat();
  const allAIPlayers = Object.values(aiPlayers).flat().flat();

  const randomScorers = (players, goalCount) => {
    const scorers = [];
    for (let i = 0; i < goalCount; i++) {
      const p = players[Math.floor(Math.random() * players.length)];
      scorers.push({ name: p.name, minute: Math.floor(Math.random() * 90) + 1 });
    }
    return scorers.sort((a, b) => a.minute - b.minute);
  };

  const userScorers = randomScorers(allUserPlayers, userGoals);
  const aiScorers = randomScorers(allAIPlayers, aiGoals);

  const matchLog = [
    ...userScorers.map(g => `${g.minute}' - ${g.name} (You)`),
    ...aiScorers.map(g => `${g.minute}' - ${g.name} (AI)`)
  ].sort((a, b) => parseInt(a) - parseInt(b));

  return {
    result,
    score: `${userGoals} - ${aiGoals}`,
    userScorers,
    aiScorers,
    matchLog
  };
}

const rawData = fs.readFileSync('./players.json', 'utf-8');
const playerData = JSON.parse(rawData).players; // Access the inner 'players' object

// Endpoint to get player position by ID
app.get('/seek', (req, res) => {
    const playerId = parseInt(req.query.q); // e.g., ?q=34

    if (!playerId) {
        return res.status(400).json({ 
            success: false,
            error: 'Missing player ID (use ?q=ID)' 
        });
    }

    let playerPosition = null;
    let playerDetails = null;

    // Search for the player in all positions
    for (const [position, players] of Object.entries(playerData)) {
        const player = players.find(p => p.id === playerId);
        if (player) {
            playerPosition = position;
            playerDetails = {
                id: player.id,
                name: player.name,
                rating: player.rating
            };
            break;
        }
    }

    if (playerPosition) {
        res.json({
            success: true,
            position: playerPosition,
            player: playerDetails
        });
    } else {
        res.status(404).json({ 
            success: false,
            error: 'Player not found' 
        });
    }
});

app.get('/remove-link', (req, res) => {
    const { q } = req.query;
    const len = links.length;
    links = links.filter(l => l.q !== q);
    saveLinks();
    res.json({ removed: links.length < len });
});

app.get('/matches', (req, res) => {
  const filePath = path.join(__dirname, 'matches.json');

  fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
          console.error('Error reading matches.json:', err);
          return res.status(500).json({ error: 'Could not read matches.json' });
      }

      try {
          const jsonData = JSON.parse(data);
          res.json(jsonData);
      } catch (parseError) {
          console.error('Error parsing matches.json:', parseError);
          res.status(500).json({ error: 'Invalid JSON in matches.json' });
      }
  });
});

app.get('/links', (req, res) => res.json(links));

// Start server
const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Route for the register page
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/lobby', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/matchmake', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'matchmake.html'));
});

// Route for the lobby page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

app.listen(7860, '0.0.0.0', () => console.log('Server running on port 7860'));
