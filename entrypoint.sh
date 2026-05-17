#!/bin/bash
set -e

# Clear Tor cache to avoid "Disk quota exceeded" on start
echo "[start.sh] Cleaning up Tor data directory..."
rm -rf /tmp/tor
mkdir -p /tmp/tor

# Start Tor with the project torrc (DataDirectory is set in torrc)
echo "[start.sh] Starting Tor..."
tor -f "$(pwd)/torrc" &
TOR_PID=$!

# Wait for Tor SOCKS proxy to be ready (port 9050)
echo "[start.sh] Waiting for Tor to bootstrap..."
for i in $(seq 1 30); do
    if bash -c "echo > /dev/tcp/127.0.0.1/9050" 2>/dev/null; then
        echo "[start.sh] Tor SOCKS proxy is up on port 9050."
        break
    fi
    echo "[start.sh] Attempt $i/30 - waiting..."
    sleep 2
done

# Export Chromium path for Puppeteer
export PUPPETEER_EXECUTABLE_PATH=$(which chromium)
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

echo "[start.sh] Using Chromium at: $PUPPETEER_EXECUTABLE_PATH"
echo "[start.sh] Starting bot..."

# Run the bot
npm start

# Cleanup on exit
echo "[start.sh] Stopping Tor and cleaning up files..."
kill $TOR_PID 2>/dev/null || true
rm -rf /tmp/tor
