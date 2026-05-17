import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import * as net from "net";
import pLimit from "p-limit";
import UserAgent from "user-agents";
import * as readline from "readline";

puppeteer.use(StealthPlugin());

// ════════════════════════════════════════════════════════
//  CONFIGURATION  (override with environment variables)
// ════════════════════════════════════════════════════════
const LINKS_FILE = process.env.LINKS_FILE || "links.txt";
const TOR_PROXY = process.env.TOR_PROXY || "socks5://127.0.0.1:9050";
const TOR_CONTROL_PORT = parseInt(process.env.TOR_CONTROL_PORT || "9051");
const CONCURRENT_AGENTS = parseInt(process.env.CONCURRENT_AGENTS || "5");
const VISIT_DURATION_MS = parseInt(process.env.VISIT_DURATION_MS || "10000");
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

// Safety: Pause for PAUSE_DURATION_MS after every PAUSE_EVERY_N links
const PAUSE_EVERY_N = parseInt(process.env.PAUSE_EVERY_N || "50");


// ════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════
let completedVisits = 0;
let failedVisits = 0;
let totalLinks = 0;
let sessionStart = Date.now();

const ORIGINAL_LINK_FILES = [
    "links_3eb8462740.txt",
    "links_8bb22ea789.txt",
    "links.txt",
    "links_41a24fa1af.txt",
    "links_275e6dccce.txt",
    "links_a7d02c1618.txt",
    "links_b75016373b.txt",
    "links_ba1a8dd79e.txt",
];

const ACCOUNT_MAPPING: Record<string, string> = {
    ba1a8dd79e: "butler.ruby@proton.me",
    "41a24fa1af": "kirta3@proton.me",
    "8bb22ea789": "daribha1211@proton.me",
    "275e6dccce": "thelady34@proton.me",
    "3eb8462740": "cactuslasagna@outlook.com",
    a7d02c1618: "spaghettimirage@hotmail.com",
    b75016373b: "rubberduckpilot@proton.me",
};

interface FileState {
    cursor: number;
    successes: number;
}

const STATE_FILE = "state.json";

let state: Record<string, FileState> = {};
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch (e) {
        console.log(`\x1b[31m[ERROR] Failed to parse state file: ${e}\x1b[0m`);
    }
}

function promptForFile(): Promise<string> {
    return new Promise((resolve) => {
        // Check for environment variable first
        const envSelected = process.env.SELECTED_ACCOUNT;
        if (envSelected && ORIGINAL_LINK_FILES.includes(envSelected)) {
            console.log(
                `\x1b[32m[INFO] Using account from environment: ${envSelected}\x1b[0m`,
            );
            return resolve(envSelected);
        }

        const randomIndex = Math.floor(
            Math.random() * ORIGINAL_LINK_FILES.length,
        );
        const selectedFile = ORIGINAL_LINK_FILES[randomIndex];
        console.log(
            `\x1b[32m[INFO] Randomly selected file: ${selectedFile}\x1b[0m`,
        );
        resolve(selectedFile);
    });
}

// ════════════════════════════════════════════════════════
//  LOGGING HELPERS
// ════════════════════════════════════════════════════════
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const WHITE = "\x1b[37m";

function timestamp() {
    return `${DIM}${new Date().toLocaleTimeString()}${RESET}`;
}

function divider(char = "─", len = 60) {
    return `${DIM}${"".padEnd(len, char)}${RESET}`;
}

function logRotate(agentId: number, url: string) {
    console.log(
        `${timestamp()} ${CYAN}${BOLD}[A${agentId}]${RESET} ${YELLOW}⟳  ROTATING IP${RESET}  ${DIM}${url.substring(0, 55)}...${RESET}`,
    );
}

function logVisiting(agentId: number, ua: string) {
    console.log(
        `${timestamp()} ${CYAN}${BOLD}[A${agentId}]${RESET} ${BLUE}⤷  VISITING${RESET}    ${DIM}${ua.substring(0, 50)}...${RESET}`,
    );
}

function logSuccess(agentId: number) {
    const pct = Math.round((completedVisits / totalLinks) * 100);
    const bar = `[${"█".repeat(Math.floor(pct / 5))}${"░".repeat(20 - Math.floor(pct / 5))}]`;
    console.log(
        `${timestamp()} ${CYAN}${BOLD}[A${agentId}]${RESET} ${GREEN}✔  SUCCESS${RESET}     ${GREEN}${bar} ${pct}%${RESET}  ${DIM}(${completedVisits}/${totalLinks})${RESET}`,
    );
}

function logError(agentId: number, msg: string) {
    console.log(
        `${timestamp()} ${CYAN}${BOLD}[A${agentId}]${RESET} ${RED}✘  ERROR${RESET}       ${RED}${msg.substring(0, 50)}${RESET}`,
    );
}

function logCycleHeader(cycle: number) {
    const elapsed = ((Date.now() - sessionStart) / 60000).toFixed(1);
    console.log(`\n${divider("═")}`);
    console.log(
        `  ${MAGENTA}${BOLD}🔄  CYCLE #${cycle}${RESET}${MAGENTA}   │   🕐 Session: ${elapsed}m   │   📋 Links: ${totalLinks}${RESET}`,
    );
    console.log(`${divider("═")}\n`);
}

function logCycleFooter(cycle: number) {
    const elapsed = ((Date.now() - sessionStart) / 60000).toFixed(1);
    console.log(`\n${divider()}`);
    console.log(
        `  ${GREEN}${BOLD}✅ CYCLE #${cycle} COMPLETE${RESET}   ${GREEN}${completedVisits} OK${RESET}  ${RED}${failedVisits} ERR${RESET}  ${DIM}${elapsed}m elapsed${RESET}`,
    );
    console.log(`${divider()}\n`);
}



function logStats() {
    const elapsed = ((Date.now() - sessionStart) / 60000).toFixed(1);
    const rate = (completedVisits / parseFloat(elapsed) || 0).toFixed(1);
    console.log(`${divider()}`);
    console.log(`  ${BOLD}${WHITE}📊  SESSION STATS${RESET}`);
    console.log(
        `  ${GREEN}✔ Successful: ${completedVisits}${RESET}  ${RED}✘ Failed: ${failedVisits}${RESET}  ${CYAN}⚡ Rate: ${rate}/min${RESET}  ${DIM}⏱ ${elapsed}m${RESET}`,
    );
    console.log(`${divider()}\n`);
}

// ════════════════════════════════════════════════════════
//  TOR SESSION ROTATION
// ════════════════════════════════════════════════════════
async function renewTorSession(): Promise<void> {
    return new Promise((resolve) => {
        const socket = net.connect(TOR_CONTROL_PORT, "127.0.0.1", () => {
            socket.write('AUTHENTICATE ""\r\n');
            socket.write("SIGNAL NEWNYM\r\n");
            socket.write("QUIT\r\n");
        });
        socket.setTimeout(5000);
        socket.on("data", () => { });
        socket.on("error", () => {
            socket.destroy();
            resolve();
        });
        socket.on("timeout", () => {
            socket.destroy();
            resolve();
        });
        socket.on("end", () => resolve());
    });
}

// ════════════════════════════════════════════════════════
//  VISIT A SINGLE LINK
// ════════════════════════════════════════════════════════
async function visitLink(url: string, agentId: number) {
    const userAgent = new UserAgent();
    const profile = {
        ua: userAgent.toString(),
        platform: userAgent.data.platform || "Win32",
        viewport: {
            width: userAgent.data.viewportWidth || 1366,
            height: userAgent.data.viewportHeight || 768,
        },
    };

    await renewTorSession();
    await new Promise((r) => setTimeout(r, 5000));

    // logRotate(agentId, url);

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            executablePath: CHROME_PATH,
            args: [
                `--proxy-server=${TOR_PROXY}`,
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote",
                "--single-process",
                `--user-agent=${profile.ua}`,
            ],
        });

        const page = await browser.newPage();

        await page.setUserAgent(profile.ua);
        await page.setViewport(profile.viewport);
        await page.evaluateOnNewDocument((p) => {
            Object.defineProperty(navigator, "platform", { get: () => p });
            Object.defineProperty(navigator, "webdriver", { get: () => false });
        }, profile.platform);

        // logVisiting(agentId, profile.ua);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });

        // Human-like scroll interaction
        await page.evaluate(async () => {
            window.scrollBy(0, 300 + Math.random() * 400);
            await new Promise((r) =>
                setTimeout(r, 1500 + Math.random() * 2000),
            );
            window.scrollBy(0, 300 + Math.random() * 400);
        });

        const jitter = Math.floor(Math.random() * 10000) - 5000;
        const actualDuration = Math.max(5000, VISIT_DURATION_MS + jitter);
        await new Promise((r) => setTimeout(r, actualDuration));

        completedVisits++;
        // logSuccess(agentId);
    } catch (err: any) {
        failedVisits++;
        logError(agentId, err.message || "Unknown error");
    } finally {
        if (browser) {
            try {
                await Promise.race([
                    browser.close(),
                    new Promise((r) => setTimeout(r, 10000)),
                ]);
            } catch (e) { }
        }
    }
}

// ════════════════════════════════════════════════════════
//  MAIN LOOP
// ════════════════════════════════════════════════════════
async function main() {
    // Load all links
    const allLinks: Record<string, string[]> = {};
    for (const file of ORIGINAL_LINK_FILES) {
        if (fs.existsSync(file)) {
            allLinks[file] = fs
                .readFileSync(file, "utf-8")
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l.startsWith("http"));
            console.log(
                `\x1b[32m[INFO] Loaded ${allLinks[file].length} links from ${file}\x1b[0m`,
            );
        } else {
            console.log(`\x1b[33m[WARN] File not found: ${file}\x1b[0m`);
        }
    }

    const fileList = Object.keys(allLinks);
    if (fileList.length === 0) {
        console.log(`\x1b[31m[ERROR] No link files found!\x1b[0m`);
        return;
    }

    sessionStart = Date.now();

    console.log(`\n${divider("═")}`);
    console.log(
        `  ${MAGENTA}${BOLD}🤖  TOR TRAFFIC BOT  — STARTING UP (Interleaved Mode)${RESET}`,
    );
    console.log(
        `  ${DIM}Agents: ${CONCURRENT_AGENTS}  │  Pause every: ${PAUSE_EVERY_N} links  │  Pause: Disabled${RESET}`,
    );
    console.log(`  ${DIM}Files loaded: ${fileList.length}${RESET}`);
    console.log(`${divider("═")}\n`);

    let fileIndex = 0;
    while (true) {
        const selectedFile = fileList[fileIndex];
        const links = allLinks[selectedFile];

        let cursor = state[selectedFile]?.cursor || 0;
        let successes = state[selectedFile]?.successes || 0;

        // Take at most 500 links
        const chunkSize = 500;
        const batch = links.slice(
            cursor,
            Math.min(cursor + chunkSize, links.length),
        );

        if (batch.length === 0) {
            console.log(
                `\n${GREEN}${BOLD}🎉 Reached end of file ${selectedFile}. Resetting cursor...${RESET}\n`,
            );
            cursor = 0;
            state[selectedFile] = { cursor, successes };
            fs.writeFileSync(
                STATE_FILE,
                JSON.stringify(state, null, 2),
                "utf-8",
            );
            continue; // Pick another file immediately
        }

        totalLinks = batch.length;
        completedVisits = 0;
        failedVisits = 0;

        console.log(`\n${divider("═")}`);
        console.log(
            `  ${MAGENTA}${BOLD}🔄  PROCESSING FILE: ${selectedFile}${RESET}`,
        );
        console.log(
            `  ${DIM}Processing links ${cursor + 1}–${cursor + batch.length} of ${links.length}${RESET}`,
        );
        console.log(
            `  ${DIM}Total Successes for this file: ${successes}${RESET}`,
        );
        console.log(`${divider("═")}\n`);

        const limit = pLimit(CONCURRENT_AGENTS);

        // Process the batch in sub-batches of PAUSE_EVERY_N
        for (let j = 0; j < batch.length; j += PAUSE_EVERY_N) {
            const subBatch = batch.slice(j, j + PAUSE_EVERY_N);
            const batchNum = Math.floor(j / PAUSE_EVERY_N) + 1;
            const totalBatches = Math.ceil(batch.length / PAUSE_EVERY_N);

            console.log(
                `\n  ${BOLD}${BLUE}📦 Sub-Batch ${batchNum}/${totalBatches}${RESET}  ${DIM}(links ${cursor + j + 1}–${cursor + j + subBatch.length})${RESET}`,
            );
            console.log(`  ${divider("─", 50)}`);

            const tasks = subBatch.map((link, idx) => {
                const globalIdx = j + idx;
                return limit(async () => {
                    await Promise.race([
                        visitLink(link, (globalIdx % CONCURRENT_AGENTS) + 1),
                        new Promise((r) => setTimeout(r, 180000)), // 3min hard timeout
                    ]);
                });
            });

            await Promise.all(tasks);
        }

        // Update cursor and successes
        cursor += batch.length;
        successes += completedVisits;

        state[selectedFile] = { cursor, successes };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");

        logStats();

        // Check if we reached the end after this batch
        if (cursor >= links.length) {
            console.log(
                `\n${GREEN}${BOLD}🎉 Reached end of file ${selectedFile}. Resetting cursor...${RESET}\n`,
            );
            cursor = 0;
            state[selectedFile] = { cursor, successes };
            fs.writeFileSync(
                STATE_FILE,
                JSON.stringify(state, null, 2),
                "utf-8",
            );
        }

        console.log(`${YELLOW}${BOLD}⟳  Switching to next file...${RESET}\n`);
        fileIndex = (fileIndex + 1) % fileList.length;
        await new Promise((r) => setTimeout(r, 5000));
    }
}
main().catch(console.error);
