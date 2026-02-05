const WebSocket = require('ws');

const PORT = process.env.PORT || 65535;

const wss = new WebSocket.Server({
  port: PORT,
  maxPayload: 50 * 1024 * 1024,
  perMessageDeflate: false
});

const clients = new Map();

console.log(`Chat Server started on port ${PORT}`);
console.log(`Waiting for connections...\n`);

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (message) => {
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

          clients.set(username, ws);
          console.log(`${username} joined (Total users: ${clients.size})`);

          ws.send(JSON.stringify({ type: 'auth_success' }));

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
          const userList = Array.from(clients.keys());
          ws.send(JSON.stringify({
            type: 'user_list',
            users: userList
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

        case 'call_request':
          const callReceiver = clients.get(data.to);
          if (callReceiver && callReceiver.readyState === WebSocket.OPEN) {
            callReceiver.send(JSON.stringify({
              type: 'call_request',
              from: data.from
            }));
          }
          break;

        case 'call_accepted':
          const caller = clients.get(data.to);
          if (caller && caller.readyState === WebSocket.OPEN) {
            caller.send(JSON.stringify({
              type: 'call_accepted',
              from: data.from
            }));
          }
          break;

        case 'call_rejected':
          const rejectedCaller = clients.get(data.to);
          if (rejectedCaller && rejectedCaller.readyState === WebSocket.OPEN) {
            rejectedCaller.send(JSON.stringify({
              type: 'call_rejected',
              from: data.from
            }));
          }
          break;

        case 'call_ended':
          const endReceiver = clients.get(data.to);
          if (endReceiver && endReceiver.readyState === WebSocket.OPEN) {
            endReceiver.send(JSON.stringify({
              type: 'call_ended',
              from: data.from
            }));
          }
          break;

        case 'webrtc_offer':
          const offerReceiver = clients.get(data.to);
          if (offerReceiver && offerReceiver.readyState === WebSocket.OPEN) {
            offerReceiver.send(JSON.stringify({
              type: 'webrtc_offer',
              offer: data.offer,
              from: data.from
            }));
          }
          break;

        case 'webrtc_answer':
          const answerReceiver = clients.get(data.to);
          if (answerReceiver && answerReceiver.readyState === WebSocket.OPEN) {
            answerReceiver.send(JSON.stringify({
              type: 'webrtc_answer',
              answer: data.answer,
              from: data.from
            }));
          }
          break;

        case 'webrtc_ice_candidate':
          const candidateReceiver = clients.get(data.to);
          if (candidateReceiver && candidateReceiver.readyState === WebSocket.OPEN) {
            candidateReceiver.send(JSON.stringify({
              type: 'webrtc_ice_candidate',
              candidate: data.candidate,
              from: data.from
            }));
          }
          break;

        case 'file':
          console.log(`${username} sent file: ${data.fileName} (${formatFileSize(data.fileSize)})`);

          const fileMessage = {
            type: 'file',
            sender: username,
            fileName: data.fileName,
            fileData: data.fileData,
            fileSize: data.fileSize
          };

          if (data.receiver === 'GROUP') {
            broadcast(fileMessage, username);
          } else {
            const targetWs = clients.get(data.receiver);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify(fileMessage));
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
      clients.delete(username);
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
    console.log('erver closed');
    process.exit(0);
  });
});


console.log('Server ready!\n');

