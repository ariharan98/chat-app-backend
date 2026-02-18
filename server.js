const WebSocket = require('ws');

const fetch = global.fetch || require('node-fetch');

const { MongoClient } = require('mongodb');

const ADMIN_SECRET = process.env.ADMIN_SECRET ;
const MONGO_URI = process.env.MONGO_URI ;

let usersCollection;


MongoClient.connect(MONGO_URI).then(client => {
  usersCollection = client.db('arattai').collection('users');
  usersCollection.createIndex({ userName: 1 }, { unique: true });
  console.log('✅ MongoDB connected');
}).catch(err => console.error('❌ MongoDB failed:', err.message));


const PORT = process.env.PORT || 65535;

const CALL_TIMEOUT_MS = 60000;

const callTimeouts = new Map();
const adminClients = new Set();

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: 50 * 1024 * 1024,
  perMessageDeflate: false
});

async function detectCountryFromIP(ip) {
  try {
    const res = await fetch(`https://ipwho.is/${ip}`);
    const data = await res.json();

    if (data.success) {
      return data.country_code;
    }
  } catch (e) {
    console.error('Country detection failed:', e.message);
  }
  return null;
}


const clients = new Map();
const callTypes = new Map();
const callState = new Map();
const userCountries = new Map();

console.log(`Chat Server started on port ${PORT}`);
console.log(`Waiting for connections...\n`);

wss.on('connection', (ws, req) => {
  let username = null;
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket.remoteAddress;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'auth': {
          const uName = (data.username || '').trim();
          const fullName = (data.fullName || '').trim();

          if (!uName) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Username is required' }));
            return;
          }

          if (checkAdminCredentials(uName)) {
            username = uName;
            adminClients.add(ws);
            const allUsers = await getAllUsersForAdmin();
            ws.send(JSON.stringify({ type: 'auth_success', isAdmin: true }));
            ws.send(JSON.stringify({ type: 'admin_user_list', users: allUsers }));
            console.log(`🔑 Admin connected`);
            return;
          }


          if (clients.has(uName)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Username already taken' }));
            return;
          }

          if (!fullName) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Full name is required' }));
            return;
          }

          username = uName;


          const locData = await (async () => {
            try {
              const res = await fetch(`https://ipwho.is/${ip}`);
              const d = await res.json();
              if (d.success) return { city: d.city, latitude: d.latitude, longitude: d.longitude, country_code: d.country_code };
            } catch (e) { }
            return { city: null, latitude: null, longitude: null, country_code: null };
          })();

          userCountries.set(username, locData.country_code);

          if (usersCollection) {
            const now = new Date();
            await usersCollection.updateOne(
              { userName: uName },
              { $set: { fullName, userName: uName, location: { city: locData.city, latitude: locData.latitude, longitude: locData.longitude }, ipAddress: ip, status: 'active', lastSeen: now }, $setOnInsert: { createdAt: now } },
              { upsert: true }
            );
          }

          clients.set(username, ws);
          callState.set(username, 'idle');
          console.log(`✅ ${fullName} (${username}) joined | Total: ${clients.size}`);

          ws.send(JSON.stringify({ type: 'auth_success', isAdmin: false, country: locData.country_code }));
          broadcast({ type: 'user_joined', username }, username);

          if (adminClients.size > 0) {
            const allUsers = await getAllUsersForAdmin();
            broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          }
          break;
        }

        case 'message':
          broadcast({
            type: 'message',
            sender: username,
            content: data.content
          }, username);
          break;

        case 'private_message':
          const receiverWs = clients.get(data.receiver);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
              type: 'private_message',
              sender: username,
              content: data.content
            }));
          }
          break;

        case 'list_users':
          const users = Array.from(clients.keys()).map(name => ({
            name,
            callState: callState.get(name) || 'idle'
          }));

          ws.send(JSON.stringify({
            type: 'user_list',
            users
          }));
          break;

        case 'enable_private':
          if (clients.has(data.receiver)) {
            ws.send(JSON.stringify({
              type: 'private_enabled',
              receiver: data.receiver
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'auth_error',
              message: `User ${data.receiver} not found`
            }));
          }
          break;

        case 'enable_group':
          ws.send(JSON.stringify({ type: 'group_enabled' }));
          break;
        case 'call_request': {
          const target = data.to;

          if (
            callState.get(username) !== 'idle' ||
            callState.get(target) !== 'idle'
          ) {
            ws.send(JSON.stringify({
              type: 'call_failed',
              reason: 'busy'
            }));
            return;
          }

          const callerCountry = userCountries.get(username);
          const targetCountry = userCountries.get(target);

          if (
            callerCountry &&
            targetCountry &&
            callerCountry !== targetCountry
          ) {
            ws.send(JSON.stringify({
              type: 'call_rejected',
              reason: 'DIFFERENT_COUNTRY'
            }));
            return;
          }

          callTypes.set(username, data.callType || 'audio');
          callTypes.set(target, data.callType || 'audio');

          callState.set(username, 'ringing');
          callState.set(target, 'ringing');

          const timeout = setTimeout(() => {
            if (callState.get(username) === 'ringing') {
              callState.set(username, 'idle');
              callState.set(target, 'idle');

              clients.get(username)?.send(JSON.stringify({ type: 'call_timeout' }));
              clients.get(target)?.send(JSON.stringify({ type: 'call_timeout' }));
            }
          }, CALL_TIMEOUT_MS);

          callTimeouts.set(username, timeout);
          callTimeouts.set(target, timeout);

          clients.get(target)?.send(JSON.stringify({
            type: 'call_request',
            from: username,
            callType: data.callType || 'audio'
          }));
          break;
        }

        case 'call_accepted': {
          callState.set(username, 'active');
          callState.set(data.to, 'active');

          clearTimeout(callTimeouts.get(username));
          clearTimeout(callTimeouts.get(data.to));
          callTimeouts.delete(username);
          callTimeouts.delete(data.to);

          callTypes.delete(username);
          callTypes.delete(data.to);

          clients.get(data.to)?.send(JSON.stringify({
            type: 'call_accepted',
            from: username
          }));
          break;
        }

        case 'call_rejected': {
          callState.set(username, 'idle');
          callState.set(data.to, 'idle');

          clearTimeout(callTimeouts.get(username));
          clearTimeout(callTimeouts.get(data.to));
          callTimeouts.delete(username);
          callTimeouts.delete(data.to);

          clients.get(data.to)?.send(JSON.stringify({
            type: 'call_rejected',
            from: username
          }));
          break;
        }

        case 'call_ended': {
          callState.set(username, 'idle');
          callState.set(data.to, 'idle');

          clearTimeout(callTimeouts.get(username));
          clearTimeout(callTimeouts.get(data.to));
          callTimeouts.delete(username);
          callTimeouts.delete(data.to);

          callTypes.delete(username);
          callTypes.delete(data.to);

          clients.get(data.to)?.send(JSON.stringify({
            type: 'call_ended',
            from: username
          }));
          break;
        }

        case 'webrtc_offer':
          clients.get(data.to)?.send(JSON.stringify({
            type: 'webrtc_offer',
            offer: data.offer,
            from: username
          }));
          break;

        case 'webrtc_answer':
          clients.get(data.to)?.send(JSON.stringify({
            type: 'webrtc_answer',
            answer: data.answer,
            from: username
          }));
          break;

        case 'webrtc_ice_candidate':
          clients.get(data.to)?.send(JSON.stringify({
            type: 'webrtc_ice_candidate',
            candidate: data.candidate,
            from: username
          }));
          break;
        case 'admin_get_users': {
          if (!adminClients.has(ws)) { ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' })); return; }
          const allUsers = await getAllUsersForAdmin();
          ws.send(JSON.stringify({ type: 'admin_user_list', users: allUsers }));
          break;
        }

        case 'admin_delete': {
          if (!adminClients.has(ws)) { ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' })); return; }
          const target = data.target;
          if (clients.has(target)) {
            clients.get(target)?.send(JSON.stringify({ type: 'auth_error', message: 'Removed by admin' }));
            clients.get(target)?.close();
            clients.delete(target);
            callState.delete(target);
            userCountries.delete(target);
            clearTimeout(callTimeouts.get(target));
            callTimeouts.delete(target);
            broadcast({ type: 'user_left', username: target });
          }
          if (usersCollection) await usersCollection.deleteOne({ userName: target });
          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'admin_delete_inactive': {
          if (!adminClients.has(ws)) { ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' })); return; }
          if (usersCollection) await usersCollection.deleteMany({ status: 'inactive' });
          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'file_chunk_start':
          if (data.receiver === 'GROUP') {
            broadcast({
              type: 'file_chunk_start',
              sender: username,
              fileName: data.fileName,
              fileSize: data.fileSize,
              totalChunks: data.totalChunks
            }, username);
          } else {
            const chunkStartWs = clients.get(data.receiver);
            if (chunkStartWs && chunkStartWs.readyState === WebSocket.OPEN) {
              chunkStartWs.send(JSON.stringify({
                type: 'file_chunk_start',
                sender: username,
                fileName: data.fileName,
                fileSize: data.fileSize,
                totalChunks: data.totalChunks
              }));
            }
          }
          break;

        case 'file_chunk':
          if (data.receiver === 'GROUP') {
            broadcast({
              type: 'file_chunk',
              sender: username,
              chunkIndex: data.chunkIndex,
              chunkData: data.chunkData
            }, username);
          } else {
            const chunkWs = clients.get(data.receiver);
            if (chunkWs && chunkWs.readyState === WebSocket.OPEN) {
              chunkWs.send(JSON.stringify({
                type: 'file_chunk',
                sender: username,
                chunkIndex: data.chunkIndex,
                chunkData: data.chunkData
              }));
            }
          }
          break;

        case 'file_chunk_end':
          if (data.receiver === 'GROUP') {
            broadcast({
              type: 'file_chunk_end',
              sender: username,
              fileName: data.fileName
            }, username);
          } else {
            const chunkEndWs = clients.get(data.receiver);
            if (chunkEndWs && chunkEndWs.readyState === WebSocket.OPEN) {
              chunkEndWs.send(JSON.stringify({
                type: 'file_chunk_end',
                sender: username,
                fileName: data.fileName
              }));
            }
          }
          break;

        case 'file_transfer_cancel':
          if (data.receiver === 'GROUP') {
            broadcast({
              type: 'file_transfer_cancel',
              sender: username
            }, username);
          } else {
            const cancelWs = clients.get(data.receiver);
            if (cancelWs && cancelWs.readyState === WebSocket.OPEN) {
              cancelWs.send(JSON.stringify({
                type: 'file_transfer_cancel',
                sender: username
              }));
            }
          }
          break;

      }
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  });

  ws.on('close', async () => {
    if (!username) return;

    if (adminClients.has(ws)) {
      adminClients.delete(ws);
      console.log('🔑 Admin disconnected');
      return;
    }

    clearTimeout(callTimeouts.get(username));
    callTimeouts.delete(username);
    clients.delete(username);
    callTypes.delete(username);
    userCountries.delete(username);
    callState.delete(username);
    console.log(`👋 ${username} left | Remaining: ${clients.size}`);

    if (usersCollection) {
      await usersCollection.updateOne(
        { userName: username },
        { $set: { status: 'inactive', lastSeen: new Date() } }
      );
    }

    broadcast({ type: 'user_left', username });

    if (adminClients.size > 0) {
      const allUsers = await getAllUsersForAdmin();
      broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

function checkAdminCredentials(username) {
  const parts = username.split('@');
  if (parts.length !== 3) return false;
  if (parts[0] !== 'admin') return false;
  if (parts[1] !== '*') return false;
  return parts[2] === ADMIN_SECRET;
}

async function getAllUsersForAdmin() {
  if (!usersCollection) return [];
  return usersCollection.find({})
    .sort({ status: 1, lastSeen: -1 })
    .toArray();
}

function broadcastToAdmins(data) {
  const message = JSON.stringify(data);
  adminClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
}

function broadcast(data, excludeUsername = null) {
  const message = JSON.stringify(data);
  clients.forEach((client, user) => {
    if (user !== excludeUsername && client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


console.log('Server ready!\n');


