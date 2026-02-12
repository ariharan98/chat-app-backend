const WebSocket = require('ws');

const fetch = global.fetch || require('node-fetch');

const PORT = process.env.PORT || 65535;

const CALL_TIMEOUT_MS = 60000;

const callTimeouts = new Map();

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
        case 'auth':
          username = data.username;

          if (clients.has(username)) {
            ws.send(JSON.stringify({
              type: 'auth_error',
              message: 'Username already taken'
            }));
            ws.close();
            return;
          }

          const country = await detectCountryFromIP(ip);
          userCountries.set(username, country);

          clients.set(username, ws);
          callState.set(username, 'idle');
          console.log(`${username} joined (Total users: ${clients.size})`);

          ws.send(JSON.stringify({
            type: 'auth_success',
            country
          }));


          broadcast({
            type: 'user_joined',
            username: username
          }, username);
          break;

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

      }
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  });

  ws.on('close', () => {
    if (username) {

      clearTimeout(callTimeouts.get(username));
      callTimeouts.delete(username);
      clients.delete(username);
      callTypes.delete(username);
      userCountries.delete(username);
      callState.delete(username);
      console.log(`${username} left (Remaining: ${clients.size})`);
      broadcast({ type: 'user_left', username: username });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

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
