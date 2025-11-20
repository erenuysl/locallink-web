import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import SimplePeer from 'simple-peer';
import streamSaver from 'streamsaver';
import { Radar, Send, Download, File as FileIcon, CheckCircle, AlertCircle, Smartphone, HardDrive, Folder, Layers, Clock, Activity, Zap, Wifi } from 'lucide-react';
import { Buffer } from 'buffer';
import { motion, AnimatePresence } from 'framer-motion';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- CRITICAL POLYFILLS FOR SIMPLE-PEER ---
if (typeof window !== "undefined") {
  window.Buffer = Buffer;
  window.process = {
    env: { DEBUG: undefined },
    version: '',
    nextTick: (cb) => setTimeout(cb, 0)
  };
  window.global = window;
}

// --- UTILS ---
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

// Get correct backend endpoint (works with IP addresses for mobile)
const getBackendEndpoint = () => {
  const host = window.location.hostname;
  return `http://${host}:3001`;
};

// English Name Generator
const generateName = () => {
  const adjectives = ['Cosmic', 'Silent', 'Rapid', 'Brave', 'Calm', 'Neon', 'Cyber', 'Happy', 'Clever', 'Swift', 'Red', 'Green', 'Blue', 'Golden', 'Silver'];
  const animals = ['Panda', 'Eagle', 'Tiger', 'Lion', 'Cat', 'Dog', 'Owl', 'Fox', 'Wolf', 'Bear', 'Hawk', 'Dolphin', 'Falcon', 'Raven', 'Dragon'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj} ${animal} ${num}`;
};

// --- TOAST COMPONENT ---
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  const bgColors = {
    success: 'bg-green-600',
    error: 'bg-red-600',
    info: 'bg-blue-600'
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 50, scale: 0.3 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.2 } }}
      className={cn("fixed bottom-8 right-8 px-6 py-4 rounded-xl shadow-2xl flex items-center gap-3 text-white font-medium z-50", bgColors[type] || bgColors.info)}
    >
      {type === 'success' && <CheckCircle size={20} />}
      {type === 'error' && <AlertCircle size={20} />}
      {type === 'info' && <Radar size={20} />}
      {message}
    </motion.div>
  );
};

// --- MAIN APP ---
const App = () => {
  const [socket, setSocket] = useState(null);
  const [myId, setMyId] = useState('');
  const [myName, setMyName] = useState('');
  const [users, setUsers] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');

  const [peer, setPeer] = useState(null); // Kept for re-render trigger
  const [connected, setConnected] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [batchStatus, setBatchStatus] = useState('idle'); // idle, connecting, transferring, completed

  const [toasts, setToasts] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);

  // Incoming transfer request
  const [incomingRequest, setIncomingRequest] = useState(null);

  const [stats, setStats] = useState({
    totalFiles: 0,
    processedFiles: 0,
    totalBytes: 0,
    processedBytes: 0,
    speed: '0 MB/s',
    eta: '--:--',
    currentFile: 'Waiting...'
  });

  const fileInputRef = useRef(null);
  const rootDirHandleRef = useRef(null);
  const selectedUserRef = useRef(null);
  const peerRef = useRef(null); // CRITICAL: Use ref instead of state for immediate updates
  const selectedFilesRef = useRef([]); // CRITICAL: For immediate access in event handlers
  const usersRef = useRef([]); // CRITICAL: For immediate access in event handlers
  const lastBytesRef = useRef(0);
  const lastTimeRef = useRef(0);
  const connectionTimeoutRef = useRef(null);

  const CHUNK_SIZE = 64 * 1024;
  const BUFFER_THRESHOLD = 1024 * 1024;
  const BACKEND_URL = getBackendEndpoint();

  // --- HELPERS ---
  const addToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // --- INITIALIZATION ---
  useEffect(() => {
    let storedName = localStorage.getItem('locallink_name');
    if (!storedName) {
      storedName = generateName();
      localStorage.setItem('locallink_name', storedName);
    }
    setMyName(storedName);

    // Check WebRTC support
    if (!window.RTCPeerConnection) {
      console.error('❌ WebRTC not supported');
      addToast('WebRTC not supported. Use HTTPS or modern browser.', 'error');
      setConnectionStatus('WebRTC Not Supported');
      return;
    }

    console.log(`🔗 Connecting to backend: ${BACKEND_URL}`);

    const newSocket = io(BACKEND_URL, {
      transports: ['websocket'], // Force websocket for better mobile compatibility
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });

    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('✅ Socket Connected');
      setConnectionStatus('Connected');
      addToast('Connected to server', 'success');
      // CRITICAL: Emit join with name
      newSocket.emit('join', { name: storedName });
    });

    newSocket.on('connect_error', (error) => {
      console.error('❌ Socket connection error:', error);
      setConnectionStatus('Connection Failed');
      addToast('Cannot connect to server', 'error');
    });

    newSocket.on('me', (data) => {
      setMyId(data.id);
      console.log('👤 My ID:', data.id);
    });

    newSocket.on('users', (userList) => {
      const others = userList.filter(u => u.id !== newSocket.id);
      setUsers(others);
      usersRef.current = others; // Keep ref in sync
      console.log('📋 Users updated:', others.length, 'online');
    });

    // BATCH REQUEST - Incoming transfer request
    newSocket.on('batch-request', (data) => {
      console.log('📨 TRANSFER İSTEĞİ ALINDI:', data);
      addToast(`Transfer request from ${data.fromName}`, 'info');
      setIncomingRequest({
        from: data.from,
        fromName: data.fromName,
        fileCount: data.fileCount,
        totalSize: data.totalSize,
        totalBytes: data.totalBytes
      });
    });

    // BATCH ANSWER - Response to our request
    newSocket.on('batch-answer', (data) => {
      console.log('📬 Transfer cevabı alındı:', data.accepted ? 'KABUL' : 'RED');
      if (data.accepted) {
        addToast('Transfer accepted! Connecting...', 'success');

        // CRITICAL: Set connecting status immediately
        setBatchStatus('connecting');
        setConnectionStatus('Connecting to peer...');

        console.log('📦 Selected files count:', selectedFilesRef.current.length);
        console.log('👥 Users count:', usersRef.current.length);
        console.log('🔍 About to call createSenderPeer...');

        // Create sender peer
        if (selectedFilesRef.current.length > 0) {
          const targetUser = usersRef.current.find(u => u.id === data.from);
          console.log('🎯 Target user found:', targetUser?.name);
          if (targetUser) {
            console.log('✅ Calling createSenderPeer NOW!');
            createSenderPeer(targetUser, selectedFilesRef.current);
            console.log('✅ createSenderPeer called!');
          } else {
            console.error('❌ Target user not found!');
            addToast('Target user not found', 'error');
            setBatchStatus('idle');
          }
        } else {
          console.error('❌ No files selected!');
          addToast('No files selected', 'error');
          setBatchStatus('idle');
        }
      } else {
        addToast('Transfer declined', 'error');
        setSelectedFiles([]);
        setBatchStatus('idle');
      }
    });

    newSocket.on('signal', (data) => {
      console.log('📥 Signal received from:', data.from);
      console.log('📥 Signal type:', data.signal?.type);
      console.log('📥 Current peer exists:', !!peerRef.current);

      if (peerRef.current) {
        console.log('🔗 Signaling existing peer with:', data.signal?.type);
        try {
          peerRef.current.signal(data.signal);
          addToast(`Received: ${data.signal?.type || 'signal'}`, 'info');
        } catch (err) {
          console.error('❌ Error signaling peer:', err);
          addToast('Signal error: ' + err.message, 'error');
        }
      } else {
        console.log('🆕 Creating receiver peer');
        createReceiverPeer(data.from, data.signal, newSocket);
      }
    });

    return () => {
      newSocket.disconnect();
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, []);

  // --- HANDLE BATCH ACCEPT ---
  const handleBatchAccept = () => {
    if (!incomingRequest || !socket) return;

    console.log('✅ Transfer kabul edildi');
    addToast('Accepting transfer...', 'success');

    // CRITICAL: Set connecting status immediately
    setBatchStatus('connecting');
    setConnectionStatus('Connecting to peer...');

    // CRITICAL: Create receiver peer BEFORE sending answer
    console.log('🟢 Creating receiver peer for:', incomingRequest.fromName);
    createReceiverPeer(incomingRequest.from, null, socket);

    // Then send answer
    socket.emit('batch-answer', {
      to: incomingRequest.from,
      accepted: true
    });

    setIncomingRequest(null);
  };

  // --- HANDLE BATCH DECLINE ---
  const handleBatchDecline = () => {
    if (!incomingRequest || !socket) return;

    console.log('❌ Transfer reddedildi');

    socket.emit('batch-answer', {
      to: incomingRequest.from,
      accepted: false
    });

    setIncomingRequest(null);
    addToast('Transfer declined', 'info');
  };

  // --- CREATE SENDER PEER ---
  const createSenderPeer = (targetUser, files) => {
    console.log('🚀 createSenderPeer ENTERED');
    console.log('   socket exists:', !!socket);
    console.log('   myId:', myId);
    console.log('   targetUser:', targetUser?.name);
    console.log('   files count:', files?.length);

    if (!socket) {
      console.error('❌ Socket is NULL/UNDEFINED! Cannot create peer!');
      addToast('Socket not connected', 'error');
      return;
    }

    console.log('🔵 Creating SENDER peer to:', targetUser.name);
    setConnectionStatus('Creating P2P connection...');
    setBatchStatus('connecting');

    // Clear any existing timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }

    // AGGRESSIVE CONNECTION CONFIG
    const newPeer = new SimplePeer({
      initiator: true,
      trickle: true, // Changed to true for better mobile compatibility
      allowHalfOpen: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }, // Backup STUN
          { urls: 'stun:stun.services.mozilla.com' }
        ]
      }
    });

    // Set connection timeout (10 seconds)
    connectionTimeoutRef.current = setTimeout(() => {
      if (!connected) {
        console.error('⏰ Connection timeout!');
        addToast('Connection timeout. Please try again.', 'error');
        setConnectionStatus('Timeout');
        setBatchStatus('idle');
        if (newPeer) {
          newPeer.destroy();
        }
      }
    }, 10000);

    newPeer.on('signal', (signal) => {
      console.log('⚡ SENDER: Signal generated', signal.type);
      console.log('Signal data:', JSON.stringify(signal).substring(0, 100));
      addToast(`Signal: ${signal.type}`, 'info');
      socket.emit('signal', { to: targetUser.id, signal, from: myId });
    });

    newPeer.on('icecandidate', (candidate) => {
      console.log('🧊 SENDER: ICE Candidate:', candidate);
    });

    newPeer.on('iceStateChange', (state) => {
      console.log('🧊 SENDER: ICE State Change:', state);
      addToast(`ICE State: ${state}`, 'info');
    });

    newPeer.on('connect', () => {
      console.log('✅ SENDER: P2P CONNECTED!');

      // Clear timeout
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }

      setConnected(true);
      setConnectionStatus('Connected');
      setBatchStatus('transferring');
      addToast('P2P CONNECTED! 🚀', 'success');

      // Start sending files
      if (files && files.length > 0) {
        sendFiles(newPeer, files);
      }
    });

    newPeer.on('error', (err) => {
      console.error('❌ SENDER Error:', err);
      addToast('Connection failed: ' + err.message, 'error');
      setConnectionStatus('Failed');
      setBatchStatus('idle');

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
    });

    newPeer.on('close', () => {
      console.log('🔌 SENDER: Connection closed');
      setConnected(false);
      setConnectionStatus('Disconnected');
      setTransferring(false);
      setBatchStatus('idle');
    });

    peerRef.current = newPeer;
    setPeer(newPeer); // Trigger re-render
  };

  // --- CREATE RECEIVER PEER ---
  const createReceiverPeer = (fromId, signal, socketInstance) => {
    console.log('🟢 Creating RECEIVER peer from:', fromId);
    setConnectionStatus('Creating P2P connection...');
    setBatchStatus('connecting');

    // Clear any existing timeout
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
    }

    // AGGRESSIVE CONNECTION CONFIG
    const newPeer = new SimplePeer({
      initiator: false,
      trickle: true, // Changed to true for better mobile compatibility
      allowHalfOpen: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:global.stun.twilio.com:3478' }, // Backup STUN
          { urls: 'stun:stun.services.mozilla.com' }
        ]
      }
    });

    // Set connection timeout (10 seconds)
    connectionTimeoutRef.current = setTimeout(() => {
      if (!connected) {
        console.error('⏰ Connection timeout!');
        addToast('Connection timeout. Please try again.', 'error');
        setConnectionStatus('Timeout');
        setBatchStatus('idle');
        if (newPeer) {
          newPeer.destroy();
        }
      }
    }, 10000);

    newPeer.on('signal', (sig) => {
      console.log('⚡ RECEIVER: Signal generated', sig.type);
      console.log('Signal data:', JSON.stringify(sig).substring(0, 100));
      addToast(`Signal: ${sig.type}`, 'info');
      socketInstance.emit('signal', { to: fromId, signal: sig, from: myId });
    });

    newPeer.on('connect', () => {
      console.log('✅ RECEIVER: P2P CONNECTED!');

      // Clear timeout
      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }

      setConnected(true);
      setConnectionStatus('Connected');
      setBatchStatus('transferring');
      addToast('P2P CONNECTED! 🚀', 'success');
      setupReceiverEvents(newPeer);
    });

    newPeer.on('error', (err) => {
      console.error('❌ RECEIVER Error:', err);
      addToast('Connection failed: ' + err.message, 'error');
      setConnectionStatus('Failed');
      setBatchStatus('idle');

      if (connectionTimeoutRef.current) {
        clearTimeout(connectionTimeoutRef.current);
      }
    });

    newPeer.on('close', () => {
      console.log('🔌 RECEIVER: Connection closed');
      setConnected(false);
      setConnectionStatus('Disconnected');
      setBatchStatus('idle');
    });

    peerRef.current = newPeer;
    setPeer(newPeer); // Trigger re-render

    // Only signal if we have an initial signal (from old flow)
    if (signal) {
      console.log('🔗 Signaling receiver peer with initial signal');
      newPeer.signal(signal);
    } else {
      console.log('⏳ Waiting for sender signal...');
    }
  };

  // --- SEND FILES ---
  const sendFiles = async (peerConnection, files) => {
    setTransferring(true);
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    lastTimeRef.current = Date.now();
    lastBytesRef.current = 0;

    setStats({
      totalFiles: files.length,
      processedFiles: 0,
      totalBytes,
      processedBytes: 0,
      speed: '0 MB/s',
      eta: '--:--',
      currentFile: files[0]?.name || 'Starting...'
    });

    let sentBytesTotal = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      try {
        // Send header
        const header = JSON.stringify({
          type: 'file-header',
          name: file.name,
          size: file.size,
          path: file.webkitRelativePath || file.name
        });
        peerConnection.send(header);
        await new Promise(r => setTimeout(r, 20));

        // Send chunks
        let offset = 0;
        while (offset < file.size) {
          const chunk = file.slice(offset, offset + CHUNK_SIZE);
          const buffer = await chunk.arrayBuffer();

          // Backpressure
          if (peerConnection._channel && peerConnection._channel.bufferedAmount > BUFFER_THRESHOLD) {
            await new Promise(resolve => {
              const check = () => {
                if (peerConnection._channel.bufferedAmount < BUFFER_THRESHOLD) resolve();
                else setTimeout(check, 5);
              };
              check();
            });
          }

          peerConnection.send(Buffer.from(buffer));
          offset += buffer.byteLength;
          sentBytesTotal += buffer.byteLength;

          // Update stats
          updateStats(totalBytes, sentBytesTotal, file.name, files.length, i);
        }

        // Send EOF
        await new Promise(r => setTimeout(r, 10));
        peerConnection.send(JSON.stringify({ type: 'file-end' }));

      } catch (err) {
        console.error(`Error sending ${file.name}:`, err);
        addToast(`Failed to send ${file.name}`, 'error');
      }
    }

    setTransferring(false);
    setStats(prev => ({ ...prev, processedFiles: files.length, currentFile: 'Completed!' }));
    addToast('All files sent!', 'success');
    setSelectedFiles([]);
  };

  // --- UPDATE STATS ---
  const updateStats = (totalBytes, processedBytes, currentFile, totalFiles, processedFiles) => {
    const now = Date.now();
    const timeDiff = (now - lastTimeRef.current) / 1000;

    if (timeDiff === 0) return;

    if (timeDiff >= 1 || processedBytes === totalBytes) {
      const bytesDiff = processedBytes - lastBytesRef.current;
      const speedBytesPerSec = timeDiff > 0 ? bytesDiff / timeDiff : 0;
      const speedMB = (speedBytesPerSec / 1024 / 1024).toFixed(1);

      const remainingBytes = totalBytes - processedBytes;
      const etaSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;

      setStats({
        totalFiles,
        processedFiles,
        totalBytes,
        processedBytes,
        speed: `${speedMB} MB/s`,
        eta: formatTime(etaSeconds),
        currentFile
      });

      lastTimeRef.current = now;
      lastBytesRef.current = processedBytes;
    } else {
      setStats(prev => ({
        ...prev,
        processedFiles,
        processedBytes,
        currentFile
      }));
    }
  };

  // --- SETUP RECEIVER EVENTS ---
  const setupReceiverEvents = (peerConnection) => {
    let currentFileMeta = null;
    let fileHandle = null;
    let writable = null;
    let chunks = [];
    let isFileSystemAPI = false;
    let receivedBytes = 0;

    peerConnection.on('data', async (data) => {
      let isControl = false;
      let msg = null;

      try {
        if (data.byteLength < 1000) {
          const text = data.toString();
          if (text.startsWith('{')) {
            msg = JSON.parse(text);
            isControl = true;
          }
        }
      } catch (e) { }

      if (isControl) {
        if (msg.type === 'file-header') {
          console.log(`📥 Receiving: ${msg.name}`);
          currentFileMeta = msg;
          receivedBytes = 0;

          // For iOS/mobile, skip FileSystem API and use Blob
          const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
          isFileSystemAPI = false;

          if (!isIOS) {
            if (streamSaver.supported) {
              try {
                const fileStream = streamSaver.createWriteStream(msg.name, { size: msg.size });
                writable = fileStream.getWriter();
              } catch (err) {
                console.log('StreamSaver failed, using Blob fallback');
                chunks = [];
              }
            } else {
              chunks = [];
            }
          } else {
            chunks = [];
          }

          return;
        }

        if (msg.type === 'file-end') {
          console.log(`✅ File received: ${currentFileMeta.name}`);

          if (writable) {
            await writable.close();
            writable = null;
          } else {
            const blob = new Blob(chunks);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = currentFileMeta.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            chunks = [];
          }

          addToast(`Received: ${currentFileMeta.name}`, 'success');
          currentFileMeta = null;
          return;
        }
      }

      // Binary Data
      if (currentFileMeta) {
        if (writable) {
          await writable.write(data);
        } else {
          chunks.push(data);
        }
        receivedBytes += data.length;
      }
    });
  };

  // --- HANDLE FILE SELECT ---
  const handleFileSelect = async (e) => {
    try {
      // STEP 1: Function started
      console.log('📁 [STEP 1] File selection started');
      addToast('File selection started...', 'info');

      // STEP 2: Get files from input
      console.log('📁 [STEP 2] Getting files from input');
      const files = Array.from(e.target.files);

      if (!files.length) {
        console.log('⚠️ [STEP 2] No files selected');
        addToast('No files selected', 'error');
        return;
      }

      console.log(`📊 [STEP 3] ${files.length} files selected`);
      addToast(`${files.length} files selected`, 'info');

      // STEP 4: Process each file
      console.log('📁 [STEP 4] Processing files...');
      for (let i = 0; i < files.length; i++) {
        console.log(`   Processing file ${i + 1}/${files.length}: ${files[i].name}`);
      }

      // STEP 5: Check if user is selected
      if (!selectedUserRef.current) {
        console.log('⚠️ [STEP 5] No user selected');
        addToast('No user selected', 'error');
        e.target.value = '';
        return;
      }

      const targetUser = selectedUserRef.current;
      console.log(`📁 [STEP 5] Target user: ${targetUser.name} (${targetUser.id})`);

      setSelectedFiles(files);
      selectedFilesRef.current = files; // Keep ref in sync

      // STEP 6: Calculate total size
      console.log('💾 [STEP 6] Calculating total size...');
      addToast('Calculating size...', 'info');

      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

      console.log(`📦 [STEP 7] Total size: ${formatBytes(totalBytes)} (${totalBytes} bytes)`);
      addToast(`Total: ${formatBytes(totalBytes)}`, 'info');

      // STEP 8: Check socket connection
      if (!socket) {
        console.log('❌ [STEP 8] Socket not connected!');
        addToast('Not connected to server', 'error');
        e.target.value = '';
        return;
      }

      console.log('✅ [STEP 8] Socket is connected');

      // STEP 9: Prepare request data
      console.log('📤 [STEP 9] Preparing request data...');
      const requestData = {
        to: targetUser.id,
        from: myId,
        fileCount: files.length,
        totalSize: formatBytes(totalBytes),
        totalBytes: totalBytes
      };

      console.log('📤 [STEP 9] Request data:', JSON.stringify(requestData));

      // STEP 10: Send request to server
      console.log('📤 [STEP 10] Sending request to server...');
      addToast('Sending request to server...', 'info');

      socket.emit('batch-request', requestData);

      console.log('✅ [STEP 11] Request sent successfully! Waiting for response...');
      addToast(`Request sent to ${targetUser.name}`, 'success');

      selectedUserRef.current = null;

    } catch (error) {
      console.error('❌ ERROR in handleFileSelect:', error);
      console.error('Error stack:', error.stack);
      addToast('Error: ' + error.message, 'error');
    } finally {
      e.target.value = '';
    }
  };

  // --- HANDLE DRAG & DROP ---
  const handleDrop = async (e, user) => {
    e.preventDefault();
    console.log('📁 Dosya sürüklendi');

    const items = Array.from(e.dataTransfer.items);
    const files = [];

    for (const item of items) {
      if (item.kind === 'file') {
        files.push(item.getAsFile());
      }
    }

    if (files.length > 0) {
      selectedUserRef.current = user;
      setSelectedFiles(files);

      const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

      console.log(`📦 ${files.length} dosya, ${formatBytes(totalBytes)}`);
      addToast(`Sending request to ${user.name}...`, 'info');

      socket.emit('batch-request', {
        to: user.id,
        from: myId,
        fileCount: files.length,
        totalSize: formatBytes(totalBytes),
        totalBytes: totalBytes
      });
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans p-4 md:p-8 selection:bg-blue-500/30">
      <AnimatePresence>
        {toasts.map(toast => (
          <Toast key={toast.id} {...toast} onClose={() => removeToast(toast.id)} />
        ))}
      </AnimatePresence>

      {/* Transfer Request Modal */}
      <AnimatePresence>
        {incomingRequest && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-slate-800 p-8 rounded-3xl border border-slate-700 max-w-md w-full shadow-2xl"
            >
              <div className="flex items-center gap-4 mb-6 text-blue-400">
                <Layers size={40} />
                <div>
                  <h3 className="text-2xl font-bold text-white">Transfer Request</h3>
                  <p className="text-slate-400 text-sm">From {incomingRequest.fromName}</p>
                </div>
              </div>

              <div className="bg-slate-900/50 p-6 rounded-2xl mb-8 border border-slate-700/50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-slate-400">File Count</span>
                  <span className="text-xl font-bold text-white">{incomingRequest.fileCount}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-400">Total Size</span>
                  <span className="text-xl font-bold text-white">{incomingRequest.totalSize}</span>
                </div>
              </div>

              <div className="flex gap-4">
                <button
                  onClick={handleBatchDecline}
                  className="flex-1 py-4 rounded-xl bg-slate-700 hover:bg-slate-600 transition-colors font-bold text-slate-200"
                >
                  Decline
                </button>
                <button
                  onClick={handleBatchAccept}
                  className="flex-1 py-4 rounded-xl bg-blue-600 hover:bg-blue-500 transition-colors font-bold text-white shadow-lg shadow-blue-600/20"
                >
                  Accept
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-center mb-10 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Radar className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">LocalLink</h1>
            <span className="text-xs text-slate-500 font-mono tracking-wider uppercase">P2P File Transfer</span>
          </div>
        </div>
        <div className="flex items-center gap-4 bg-slate-800/50 p-2 pr-6 rounded-full border border-slate-700/50 backdrop-blur-sm">
          <div className="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center text-blue-400">
            <Smartphone size={20} />
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-slate-400 uppercase font-bold">Your Device</span>
            <span className="text-blue-400 font-semibold truncate max-w-[150px]">{myName || 'Loading...'}</span>
          </div>
        </div>
      </header>

      {/* Connection Status */}
      <div className="max-w-7xl mx-auto mb-6">
        <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 backdrop-blur-xl flex items-center gap-3">
          <Wifi className={cn("w-5 h-5", connectionStatus === 'Connected' ? 'text-green-500' : connectionStatus.includes('Failed') || connectionStatus.includes('Not Supported') ? 'text-red-500' : 'text-blue-500')} />
          <span className="text-sm font-medium text-slate-300">{connectionStatus}</span>
          <span className="text-xs text-slate-500 ml-auto font-mono hidden md:block">{BACKEND_URL}</span>
        </div>
      </div>

      {/* Main Grid */}
      <main className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-7xl mx-auto">

        {/* Users */}
        <div className="lg:col-span-2 bg-slate-800/40 rounded-3xl p-8 border border-slate-700/50 backdrop-blur-xl shadow-xl">
          <h2 className="text-xl font-semibold mb-8 flex items-center gap-3 text-slate-200">
            <Radar className="w-5 h-5 text-blue-500" />
            Nearby Devices ({users.length})
          </h2>

          {users.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-80 text-slate-500">
              <div className="relative w-32 h-32 mb-6">
                <div className="absolute inset-0 border-4 border-blue-500/20 rounded-full animate-ping"></div>
                <div className="absolute inset-0 border-4 border-t-blue-500 rounded-full animate-spin"></div>
              </div>
              <p className="text-lg font-medium">Scanning network...</p>
              <p className="text-sm mt-2">Make sure other devices are on the same WiFi</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
              {users.map(user => (
                <div
                  key={user.id}
                  onClick={() => {
                    selectedUserRef.current = user;
                    fileInputRef.current?.click();
                  }}
                  onDrop={(e) => handleDrop(e, user)}
                  onDragOver={(e) => e.preventDefault()}
                  className="aspect-square rounded-2xl border-2 border-slate-700 hover:border-blue-500 hover:bg-blue-500/10 transition-all cursor-pointer flex flex-col items-center justify-center gap-4 group bg-slate-800/50"
                >
                  <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                    <span className="text-2xl font-bold text-white">{user.name.charAt(0)}</span>
                  </div>
                  <div className="text-center px-2 w-full">
                    <div className="font-bold text-slate-200 truncate max-w-[100px] mx-auto" title={user.name}>{user.name}</div>
                    <div className="text-xs text-slate-500 mt-1 group-hover:text-blue-400">Click to Send</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Dashboard */}
        <div className="bg-slate-800/40 rounded-3xl p-8 border border-slate-700/50 backdrop-blur-xl shadow-xl flex flex-col h-[600px] lg:h-auto">
          <h2 className="text-xl font-semibold mb-8 flex items-center gap-3 text-slate-200">
            <Activity className="w-5 h-5 text-green-500" />
            Transfer Dashboard
          </h2>

          <div className="flex-1 flex flex-col gap-6">
            {batchStatus !== 'idle' ? (
              <div className="bg-slate-900/80 p-6 rounded-2xl border border-blue-500/30 shadow-lg shadow-blue-900/20 flex-1 flex flex-col justify-center">

                <div className="text-center mb-8">
                  <h3 className="text-2xl font-bold text-white mb-2">
                    {batchStatus === 'connecting' ? 'Connecting to Peer...' : transferring ? 'Transferring Files...' : 'Connected'}
                  </h3>
                  <p className="text-blue-400 font-mono truncate px-4" title={stats.currentFile}>
                    {batchStatus === 'connecting' ? 'Establishing P2P connection...' : stats.currentFile}
                  </p>
                </div>

                {transferring && (
                  <>
                    <div className="mb-2 flex justify-between text-sm font-medium text-slate-400">
                      <span>Progress</span>
                      <span>{Math.round((stats.processedBytes / (stats.totalBytes || 1)) * 100)}%</span>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-6 overflow-hidden shadow-inner mb-8 relative">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${(stats.processedBytes / (stats.totalBytes || 1)) * 100}%` }}
                        className="h-full bg-gradient-to-r from-blue-500 to-indigo-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-800/50 p-4 rounded-xl flex flex-col items-center">
                        <Zap className="text-yellow-400 mb-2" size={20} />
                        <div className="text-slate-400 text-xs uppercase tracking-wider">Speed</div>
                        <div className="text-lg font-bold text-white">{stats.speed}</div>
                      </div>
                      <div className="bg-slate-800/50 p-4 rounded-xl flex flex-col items-center">
                        <Clock className="text-blue-400 mb-2" size={20} />
                        <div className="text-slate-400 text-xs uppercase tracking-wider">ETA</div>
                        <div className="text-lg font-bold text-white">{stats.eta}</div>
                      </div>
                      <div className="bg-slate-800/50 p-4 rounded-xl flex flex-col items-center">
                        <Layers className="text-purple-400 mb-2" size={20} />
                        <div className="text-slate-400 text-xs uppercase tracking-wider">Files</div>
                        <div className="text-lg font-bold text-white">{stats.processedFiles} / {stats.totalFiles}</div>
                      </div>
                      <div className="bg-slate-800/50 p-4 rounded-xl flex flex-col items-center">
                        <HardDrive className="text-green-400 mb-2" size={20} />
                        <div className="text-slate-400 text-xs uppercase tracking-wider">Size</div>
                        <div className="text-sm font-bold text-white truncate w-full text-center" title={`${formatBytes(stats.processedBytes)} / ${formatBytes(stats.totalBytes)}`}>
                          {formatBytes(stats.processedBytes)} / {formatBytes(stats.totalBytes)}
                        </div>
                      </div>
                    </div>
                  </>
                )}

              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 opacity-50 border-2 border-dashed border-slate-700 rounded-2xl">
                <Layers size={64} className="mb-4" />
                <p className="text-lg">Ready for Transfer</p>
                <p className="text-sm">Select a device to start</p>
              </div>
            )}
          </div>

          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="hidden"
            multiple
            webkitdirectory=""
            directory=""
          />
        </div>
      </main>
    </div>
  );
};

export default App;
