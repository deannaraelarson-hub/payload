// index.js - The Bridge
const { app, desktopCapturer, screen } = require('electron');
const path = require('path');

// Ensure we have a display context even in headless mode
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

let localStream = null;

async function init() {
    await app.whenReady();
    
    // --- SCREEN CAPTURE LOGIC ---
    try {
        const sources = await desktopCapturer.getSources({ 
            types: ['screen', 'window'],
            thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources.length === 0) throw new Error("No display found");
        
        // Get the first screen source
        const source = sources.find(s => s.name.includes('Screen')) || sources[0];
        
        // Create a MediaStream from the source using the built-in API
        // This makes 'navigator.mediaDevices' work naturally
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id,
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080
                }
            }
        });
        
        console.log("[ELECTRON] Screen capture active");
    } catch (err) {
        console.error("[ELECTRON] Capture failed:", err.message);
    }

    // Load your actual payload logic
    // We expose 'localStream' and 'desktopCapturer' to the global scope so payload.js can use them
    global.electronLocalStream = localStream;
    global.desktopCapturer = desktopCapturer;
    
    // Start your main payload logic
    require('./payload.js');
}

init().catch(console.error);
