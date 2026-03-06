const WebSocket = require('ws');

const fetch = global.fetch || require('node-fetch');

const { MongoClient } = require('mongodb');

const geoip = require('geoip-lite');

const ADMIN_SECRET = process.env.ADMIN_SECRET;
const MONGO_URI = process.env.MONGO_URI;

let usersCollection;


MongoClient.connect(MONGO_URI).then(client => {
  usersCollection = client.db('arattai').collection('users');
  usersCollection.createIndex({ userName: 1 }, { unique: true });
  console.log('✅ MongoDB connected');

  initializeDefaultGroup();
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

const clients = new Map();
const fullNames = new Map();
const callTypes = new Map();
const callState = new Map();
const userCountries = new Map();
const callDisabledUsers = new Set();
let globalCallDisabled = false;

const groupsCollection = () => usersCollection?.db.collection('groups');
const userGroups = new Map();

function displayName(connStr) {
  const parsed = parseConnectionString(connStr);
  const effectiveUsername = parsed.username || connStr;
  const fn = fullNames.get(connStr);

  if (fn && fn !== connStr) {
    return `${fn} (${effectiveUsername})`;
  }
  return effectiveUsername;
}

console.log(`Chat Server started on port ${PORT}`);
console.log(`Waiting for connections...\n`);


function parseConnectionString(connStr) {
  if (!connStr) return { username: null, group: 'Public' };

  const parts = connStr.split('#private-grp#');
  if (parts.length === 2) {
    return { username: parts[0], group: parts[1] };
  }
  return { username: connStr, group: 'Public' };
}


function getEffectiveUsername(connStr) {
  return parseConnectionString(connStr).username;
}

async function canCommunicate(senderConnStr, receiverConnStr) {
  const sender = parseConnectionString(senderConnStr);
  const receiver = parseConnectionString(receiverConnStr);

  if (sender.group === receiver.group) return true;

  if (sender.group === 'Public' || receiver.group === 'Public') return true;

  return false;
}


async function getGroupMembers(groupName) {
  if (groupName === 'Public') {
    return Array.from(clients.keys());
  }

  const groups = groupsCollection();
  if (!groups) return [];

  const group = await groups.findOne({
    groupName,
    status: 'active'
  });

  if (!group) return [];

  return Array.from(clients.keys()).filter(connStr => {
    const parsed = parseConnectionString(connStr);
    return group.members.includes(parsed.username);
  });
}


wss.on('connection', (ws, req) => {
  let username = null;
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress?.replace('::ffff:', '') ||
    null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'auth': {
          const uName = (data.username || '').trim();
          const fullName = (data.fullName || '').trim();
          const groupName = data.groupName || 'Public';

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

          const connectionStr = groupName === 'Public'
            ? uName
            : `${uName}#private-grp#${groupName}`;

          if (clients.has(connectionStr)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Already connected' }));
            return;
          }

          if (!fullName) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Full name is required' }));
            return;
          }


          if (groupName !== 'Public') {
            const groups = groupsCollection();
            if (groups) {
              const group = await groups.findOne({
                groupName,
                status: 'active',
                members: uName
              });

              if (!group) {
                ws.send(JSON.stringify({
                  type: 'auth_error',
                  message: 'Not a member of this group'
                }));
                return;
              }
            }
          }

          username = connectionStr;
          const effectiveUsername = uName;

          const locData = await (async () => {
            const isPrivate = !ip || ip === '::1' || ip === '127.0.0.1' ||
              ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.');
            if (isPrivate) return { city: 'Local', latitude: null, longitude: null, country_code: null };

            try {
              const res = await fetch(`https://ipwho.is/${ip}`, { signal: AbortSignal.timeout(4000) });
              const d = await res.json();
              if (d.success && d.city) {
                return { city: d.city, latitude: d.latitude, longitude: d.longitude, country_code: d.country_code };
              }
            } catch (e) { console.warn('ipwho.is failed:', e.message); }

            try {
              const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,lat,lon,countryCode`, { signal: AbortSignal.timeout(4000) });
              const d = await res.json();
              if (d.status === 'success' && d.city) {
                return { city: d.city, latitude: d.lat, longitude: d.lon, country_code: d.countryCode };
              }
            } catch (e) { console.warn('ip-api.com failed:', e.message); }

            try {
              const res = await fetch(`https://ipapi.co/${ip}/json/`, { signal: AbortSignal.timeout(4000) });
              const d = await res.json();
              if (d.city && !d.error) {
                return { city: d.city, latitude: d.latitude, longitude: d.longitude, country_code: d.country_code };
              }
            } catch (e) { console.warn('ipapi.co failed:', e.message); }

            try {
              const geo = geoip.lookup(ip);
              if (geo && geo.city) {
                return { city: geo.city, latitude: geo.ll?.[0] || null, longitude: geo.ll?.[1] || null, country_code: geo.country };
              }
            } catch (e) { console.warn('geoip-lite failed:', e.message); }

            return { city: null, latitude: null, longitude: null, country_code: null };
          })();

          userCountries.set(effectiveUsername, locData.country_code);
          userGroups.set(effectiveUsername, groupName);

          if (usersCollection) {
            const now = new Date();
            await usersCollection.updateOne(
              { userName: effectiveUsername },
              {
                $set: {
                  fullName,
                  userName: effectiveUsername,
                  currentGroup: groupName,
                  location: {
                    city: locData.city,
                    latitude: locData.latitude,
                    longitude: locData.longitude
                  },
                  ipAddress: ip,
                  status: 'active',
                  lastSeen: now
                },
                $addToSet: { groups: groupName },
                $setOnInsert: { createdAt: now }
              },
              { upsert: true }
            );
          }

          clients.set(username, ws);
          fullNames.set(username, fullName);
          callState.set(username, 'idle');

          console.log(`✅ ${fullName} (${effectiveUsername}) joined [${groupName}] | Total: ${clients.size}`);

          ws.send(JSON.stringify({
            type: 'auth_success',
            isAdmin: false,
            groupName: groupName,
            country: locData.country_code,
            callDisabled: callDisabledUsers.has(effectiveUsername) || globalCallDisabled
          }));

          const groupMembers = await getGroupMembers(groupName);
          broadcastToGroup(
            { type: 'user_joined', username: displayName(username) },
            groupMembers,
            username
          );

          if (adminClients.size > 0) {
            const allUsers = await getAllUsersForAdmin();
            broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          }
          break;
        }

        case 'message': {
          const senderGroup = parseConnectionString(username).group;
          const groupMembers = await getGroupMembers(senderGroup);

          await broadcastToGroup({
            type: 'message',
            sender: displayName(username),
            content: data.content,
            group: senderGroup
          }, groupMembers, username);
          break;
        }

        case 'private_message': {
          const receiverUsername = data.receiver;

          let receiverConnStr = null;
          for (const [connStr, ws] of clients.entries()) {
            if (getEffectiveUsername(connStr) === receiverUsername) {
              receiverConnStr = connStr;
              break;
            }
          }

          if (!receiverConnStr) {
            ws.send(JSON.stringify({
              type: 'auth_error',
              message: 'User not found'
            }));
            return;
          }

          const allowed = await canCommunicate(username, receiverConnStr);
          if (!allowed) {
            ws.send(JSON.stringify({
              type: 'auth_error',
              message: 'Cannot message users outside your group'
            }));
            return;
          }

          const receiverWs = clients.get(receiverConnStr);
          if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
            receiverWs.send(JSON.stringify({
              type: 'private_message',
              sender: displayName(username),
              content: data.content
            }));
          }
          break;
        }

        case 'list_users': {
          const currentUserGroup = parseConnectionString(username).group;

          const users = Array.from(clients.keys())
            .map(connStr => {
              const parsed = parseConnectionString(connStr);
              const effectiveUsername = parsed.username || connStr;

              return {
                connStr,
                name: effectiveUsername,
                fullName: fullNames.get(connStr) || effectiveUsername,
                displayName: displayName(connStr),
                callState: callState.get(connStr) || 'idle',
                callDisabled: callDisabledUsers.has(effectiveUsername) || globalCallDisabled,
                group: parsed.group
              };
            })
            .filter(user => {
              if (currentUserGroup === 'Public') return true;
              return user.group === currentUserGroup || user.group === 'Public';
            })
            .map(({ connStr, ...rest }) => rest);

          ws.send(JSON.stringify({ type: 'user_list', users }));
          break;

        }

        case 'enable_private': {
          let receiverConnStr = null;
          for (const [connStr, ws] of clients.entries()) {
            if (getEffectiveUsername(connStr) === data.receiver) {
              receiverConnStr = connStr;
              break;
            }
          }

          if (receiverConnStr) {
            const allowed = await canCommunicate(username, receiverConnStr);
            if (!allowed) {
              ws.send(JSON.stringify({
                type: 'auth_error',
                message: 'Cannot chat with users outside your group'
              }));
              return;
            }

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
        }

        case 'enable_group':
          ws.send(JSON.stringify({ type: 'group_enabled' }));
          break;

        case 'admin_disable_call_user': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }
          const target = data.target;
          callDisabledUsers.add(target);

          const targetWs = clients.get(target);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'call_permission_changed',
              callDisabled: true
            }));
          }

          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'admin_enable_call_user': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }
          const target = data.target;
          callDisabledUsers.delete(target);

          const targetWs = clients.get(target);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'call_permission_changed',
              callDisabled: globalCallDisabled
            }));
          }

          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'admin_disable_call_global': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }
          globalCallDisabled = true;

          clients.forEach((clientWs, user) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'call_permission_changed',
                callDisabled: true
              }));
            }
          });

          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'admin_enable_call_global': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }
          globalCallDisabled = false;
          callDisabledUsers.clear();

          clients.forEach((clientWs, user) => {
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: 'call_permission_changed',
                callDisabled: false
              }));
            }
          });

          const allUsers = await getAllUsersForAdmin();
          broadcastToAdmins({ type: 'admin_user_list', users: allUsers });
          break;
        }

        case 'call_request': {
          const target = data.to;

          if (callDisabledUsers.has(username) || callDisabledUsers.has(target) || globalCallDisabled) {
            ws.send(JSON.stringify({ type: 'call_disabled' }));
            return;
          }

          if (callState.get(username) !== 'idle' || callState.get(target) !== 'idle') {
            ws.send(JSON.stringify({ type: 'call_failed', reason: 'busy' }));
            return;
          }

          const callerCountry = userCountries.get(username);
          const targetCountry = userCountries.get(target);

          if (callerCountry && targetCountry && callerCountry !== targetCountry) {
            ws.send(JSON.stringify({ type: 'call_rejected', reason: 'DIFFERENT_COUNTRY' }));
            return;
          }

          const callerGroup = parseConnectionString(username).group;
          const targetConnStr = Array.from(clients.keys()).find(
            connStr => getEffectiveUsername(connStr) === target
          );

          if (targetConnStr) {
            const targetGroup = parseConnectionString(targetConnStr).group;

            if (callerGroup !== 'Public' && targetGroup !== 'Public' && callerGroup !== targetGroup) {
              ws.send(JSON.stringify({
                type: 'call_rejected',
                reason: 'DIFFERENT_GROUP',
                message: 'Cannot call users outside your group'
              }));
              return;
            }
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
          clients.get(data.to)?.send(JSON.stringify({ type: 'call_accepted', from: username }));
          break;
        }

        case 'call_rejected': {
          callState.set(username, 'idle');
          callState.set(data.to, 'idle');
          clearTimeout(callTimeouts.get(username));
          clearTimeout(callTimeouts.get(data.to));
          callTimeouts.delete(username);
          callTimeouts.delete(data.to);
          clients.get(data.to)?.send(JSON.stringify({ type: 'call_rejected', from: username }));
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
          clients.get(data.to)?.send(JSON.stringify({ type: 'call_ended', from: username }));
          break;
        }

        case 'webrtc_offer':
          clients.get(data.to)?.send(JSON.stringify({ type: 'webrtc_offer', offer: data.offer, from: username }));
          break;

        case 'webrtc_answer':
          clients.get(data.to)?.send(JSON.stringify({ type: 'webrtc_answer', answer: data.answer, from: username }));
          break;

        case 'webrtc_ice_candidate':
          clients.get(data.to)?.send(JSON.stringify({ type: 'webrtc_ice_candidate', candidate: data.candidate, from: username }));
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
            fullNames.delete(target);
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
            broadcast({ type: 'file_chunk_start', sender: displayName(username), fileName: data.fileName, fileSize: data.fileSize, totalChunks: data.totalChunks }, username);
          } else {
            const chunkStartWs = clients.get(data.receiver);
            if (chunkStartWs?.readyState === WebSocket.OPEN) {
              chunkStartWs.send(JSON.stringify({ type: 'file_chunk_start', sender: displayName(username), fileName: data.fileName, fileSize: data.fileSize, totalChunks: data.totalChunks }));
            }
          }
          break;

        case 'file_chunk':
          if (data.receiver === 'GROUP') {
            broadcast({ type: 'file_chunk', sender: displayName(username), chunkIndex: data.chunkIndex, chunkData: data.chunkData }, username);
          } else {
            const chunkWs = clients.get(data.receiver);
            if (chunkWs?.readyState === WebSocket.OPEN) {
              chunkWs.send(JSON.stringify({ type: 'file_chunk', sender: displayName(username), chunkIndex: data.chunkIndex, chunkData: data.chunkData }));
            }
          }
          break;

        case 'file_chunk_end':
          if (data.receiver === 'GROUP') {
            broadcast({ type: 'file_chunk_end', sender: displayName(username), fileName: data.fileName }, username);
          } else {
            const chunkEndWs = clients.get(data.receiver);
            if (chunkEndWs?.readyState === WebSocket.OPEN) {
              chunkEndWs.send(JSON.stringify({ type: 'file_chunk_end', sender: displayName(username), fileName: data.fileName }));
            }
          }
          break;

        case 'file_transfer_cancel':
          if (data.receiver === 'GROUP') {
            broadcast({ type: 'file_transfer_cancel', sender: displayName(username) }, username);
          } else {
            const cancelTarget = data.receiver || data.to;
            const cancelWs = clients.get(cancelTarget);
            if (cancelWs?.readyState === WebSocket.OPEN) {
              cancelWs.send(JSON.stringify({ type: 'file_transfer_cancel', sender: displayName(username) }));
            }
          }
          break;

        case 'admin_create_group': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }

          const { groupName, members } = data;

          if (!groupName || groupName.trim() === '') {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Group name is required'
            }));
            return;
          }

          const groups = groupsCollection();
          if (!groups) {
            ws.send(JSON.stringify({ type: 'error', message: 'Database error' }));
            return;
          }

          const existing = await groups.findOne({ groupName: groupName.trim() });
          if (existing) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Group already exists'
            }));
            return;
          }

          const newGroup = {
            groupId: `grp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            groupName: groupName.trim(),
            groupType: 'PRIVATE',
            createdBy: 'Admin',
            createdAt: new Date(),
            members: members || [],
            isDefault: false,
            status: 'active'
          };

          await groups.insertOne(newGroup);

          if (members && members.length > 0) {
            await usersCollection.updateMany(
              { userName: { $in: members } },
              { $addToSet: { groups: groupName.trim() } }
            );
          }

          ws.send(JSON.stringify({
            type: 'group_created',
            group: newGroup
          }));

          const allGroups = await groups.find({ status: 'active' }).toArray();
          ws.send(JSON.stringify({
            type: 'admin_group_list',
            groups: allGroups
          }));

          break;
        }

        case 'admin_delete_group': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }

          const { groupName } = data;
          const groups = groupsCollection();

          if (!groups) {
            ws.send(JSON.stringify({ type: 'error', message: 'Database error' }));
            return;
          }

          const group = await groups.findOne({ groupName });

          if (!group) {
            ws.send(JSON.stringify({ type: 'error', message: 'Group not found' }));
            return;
          }

          if (group.isDefault) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Cannot delete default group'
            }));
            return;
          }

          await groups.updateOne(
            { groupName },
            { $set: { status: 'deleted', deletedAt: new Date() } }
          );

          await usersCollection.updateMany(
            { groups: groupName },
            { $pull: { groups: groupName } }
          );

          clients.forEach((client, connStr) => {
            const parsed = parseConnectionString(connStr);
            if (parsed.group === groupName) {
              client.send(JSON.stringify({
                type: 'group_deleted',
                message: 'Your group has been deleted'
              }));
              client.close();
            }
          });

          ws.send(JSON.stringify({ type: 'group_deleted_success' }));

          const allGroups = await groups.find({ status: 'active' }).toArray();
          ws.send(JSON.stringify({
            type: 'admin_group_list',
            groups: allGroups
          }));

          break;
        }

        case 'admin_list_groups': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }

          const groups = groupsCollection();
          if (!groups) {
            ws.send(JSON.stringify({ type: 'error', message: 'Database error' }));
            return;
          }

          const allGroups = await groups.find({ status: 'active' }).toArray();
          ws.send(JSON.stringify({
            type: 'admin_group_list',
            groups: allGroups
          }));

          break;
        }

        case 'admin_add_user_to_group': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }

          const { groupName, userName } = data;
          const groups = groupsCollection();

          if (!groups) {
            ws.send(JSON.stringify({ type: 'error', message: 'Database error' }));
            return;
          }

          await groups.updateOne(
            { groupName, status: 'active' },
            { $addToSet: { members: userName } }
          );

          const effectiveUsername = parseConnectionString(username).username;

          await usersCollection.updateOne(
            { userName: effectiveUsername },
            { $set: { status: 'inactive', lastSeen: new Date() } }
          );

          ws.send(JSON.stringify({ type: 'user_added_to_group' }));

          break;
        }

        case 'admin_remove_user_from_group': {
          if (!adminClients.has(ws)) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Unauthorized' }));
            return;
          }

          const { groupName, userName } = data;
          const groups = groupsCollection();

          if (!groups) {
            ws.send(JSON.stringify({ type: 'error', message: 'Database error' }));
            return;
          }

          const group = await groups.findOne({ groupName });
          if (group && group.isDefault) {
            ws.send(JSON.stringify({
              type: 'error',
              message: 'Cannot remove from default group'
            }));
            return;
          }

          await groups.updateOne(
            { groupName, status: 'active' },
            { $pull: { members: userName } }
          );

          await usersCollection.updateOne(
            { userName },
            { $pull: { groups: groupName } }
          );


          clients.forEach((client, connStr) => {
            const parsed = parseConnectionString(connStr);
            if (parsed.username === userName && parsed.group === groupName) {
              client.send(JSON.stringify({
                type: 'removed_from_group',
                message: 'You have been removed from this group'
              }));
              client.close();
            }
          });

          ws.send(JSON.stringify({ type: 'user_removed_from_group' }));

          break;
        }
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

    const parsed = parseConnectionString(username);
    const effectiveUsername = parsed.username || username;
    const userGroup = parsed.group;

    clearTimeout(callTimeouts.get(username));
    callTimeouts.delete(username);
    const dn = displayName(username);

    clients.delete(username);
    fullNames.delete(username);
    callTypes.delete(username);
    userCountries.delete(effectiveUsername);
    userGroups.delete(effectiveUsername);
    callState.delete(username);
    console.log(`👋 ${username} left | Remaining: ${clients.size}`);

    if (usersCollection) {
      await usersCollection.updateOne(
        { userName: effectiveUsername },
        { $set: { status: 'inactive', lastSeen: new Date() } }
      );
    }

    const groupMembers = await getGroupMembers(userGroup);
    await broadcastToGroup(
      { type: 'user_left', username: dn },
      groupMembers,
      username
    );


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
  const users = await usersCollection.find({}).sort({ status: 1, lastSeen: -1 }).toArray();
  return users.map(u => ({
    ...u,
    _id: u._id?.toString(),
    location: u.location || { city: null, latitude: null, longitude: null },
    callDisabled: callDisabledUsers.has(u.userName) || globalCallDisabled
  }));
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

async function broadcastToGroup(data, groupMembers, excludeUsername = null) {
  const message = JSON.stringify(data);
  groupMembers.forEach(connStr => {
    if (connStr !== excludeUsername) {
      const client = clients.get(connStr);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });
}

async function initializeDefaultGroup() {
  if (!usersCollection) return;

  const groupsCollection = usersCollection.db.collection('groups');

  const publicGroup = await groupsCollection.findOne({ groupName: 'Public' });

  if (!publicGroup) {
    await groupsCollection.insertOne({
      groupId: 'grp_public_default',
      groupName: 'Public',
      groupType: 'PUBLIC',
      createdBy: 'System',
      createdAt: new Date(),
      members: [],
      isDefault: true,
      status: 'active'
    });
    console.log('✅ Default Public group created');
  }
}

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

console.log('Server ready!\n');
