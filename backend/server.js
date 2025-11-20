const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Single lobby - everyone in one room
const users = new Map();
const MAIN_LOBBY = 'main-lobby';

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // Automatically join main lobby
  socket.join(MAIN_LOBBY);

  // 1. JOIN - User joins and gets their ID
  socket.on('join', (data) => {
    const userName = data.name || `User-${socket.id.slice(0, 4)}`;
    users.set(socket.id, { id: socket.id, name: userName });

    console.log(`👤 ${userName} joined main lobby (ID: ${socket.id})`);

    // Send user their own ID
    socket.emit('me', { id: socket.id });

    // Broadcast updated user list to everyone in lobby
    broadcastUsers();
  });

  // 2. SIGNAL - Relay WebRTC signals between peers
  socket.on('signal', (data) => {
    const { to, signal, from } = data;
    const fromUser = users.get(from);
    const toUser = users.get(to);

    console.log(`📡 Relaying signal: ${fromUser?.name || from} → ${toUser?.name || to}`);

    // Forward signal to target user
    io.to(to).emit('signal', {
      signal: signal,
      from: from
    });
  });

  // 3. BATCH-REQUEST - Transfer request (for debugging)
  socket.on('batch-request', (data) => {
    const fromUser = users.get(data.from);
    const toUser = users.get(data.to);
    console.log(`📨 TRANSFER İSTEĞİ GELDİ: ${fromUser?.name || data.from} -> ${toUser?.name || data.to}`);
    console.log(`   📦 Dosya sayısı: ${data.fileCount}, Boyut: ${data.totalSize}`);

    // Forward request to target user
    io.to(data.to).emit('batch-request', {
      from: data.from,
      fromName: fromUser?.name || 'Unknown',
      fileCount: data.fileCount,
      totalSize: data.totalSize,
      totalBytes: data.totalBytes
    });
  });

  // 4. BATCH-ANSWER - Transfer response
  socket.on('batch-answer', (data) => {
    const fromUser = users.get(socket.id);
    const toUser = users.get(data.to);
    console.log(`📬 Transfer ${data.accepted ? 'KABUL EDİLDİ' : 'REDDEDİLDİ'}: ${fromUser?.name} -> ${toUser?.name}`);

    // Forward answer to requester
    io.to(data.to).emit('batch-answer', {
      from: socket.id,
      accepted: data.accepted
    });
  });

  // 5. DISCONNECT - Remove user from pool
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`❌ ${user.name} disconnected`);
      users.delete(socket.id);
      broadcastUsers();
    }
  });
});

// Helper: Broadcast current user list to all users in lobby
function broadcastUsers() {
  const userList = Array.from(users.values());
  io.to(MAIN_LOBBY).emit('users', userList);
  console.log(`📢 Broadcasting ${userList.length} users to main lobby`);
}

const PORT = process.env.PORT || 3001;

// CRITICAL: Listen on 0.0.0.0 to accept connections from network (mobile devices)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LocalLink Server running on port ${PORT}`);
  console.log(`📱 Access from mobile: http://[YOUR-COMPUTER-IP]:${PORT}`);
  console.log(`💻 Access from desktop: http://localhost:${PORT}`);
  console.log(`🌍 Listening on all network interfaces (0.0.0.0)`);
});
