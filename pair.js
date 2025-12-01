const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { MongoClient } = require('mongodb'); // MongoDB Driver

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('baileys');

//  URL එකට ඔයාගේ MongoDB connection string එක දාන්න
const MONGO_URL = "mongodb+srv://<username>:<password>@cluster0.mongodb.net/?retryWrites=true&w=majority"; 
const mongoClient = new MongoClient(MONGO_URL);
let db;

async function connectToMongo() {
    try {
        await mongoClient.connect();
        db = mongoClient.db("whatsapp_bot_db"); // Database Name
        console.log("✅ MongoDB Connected Successfully!");
        
        
        setTimeout(autoReconnectFromDB, 5000);
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
    }
}
connectToMongo();

// ============================================
// ⚙️ CONFIGURATIONS
// ============================================

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['❗', '🧚‍♂️', '🪄', '💓', '🎈', '♻️', '👻', '🥺', '🚀', '🔥'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/F2zLgJ1loae8WraMn2jdUd?mode=hqrc',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://iili.io/fosRHbe.md.png',
    NEWSLETTER_JID: '120363402466616623@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,    
    OWNER_NUMBER: '94751645330',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbBnQJYJJhzOvWQDwC0u'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// ============================================
// 🛠️ HELPER FUNCTIONS
// ============================================

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function restoreSessionFromDB(number, sessionPath) {
    try {
        if (!db) return false;
        const result = await db.collection('sessions').findOne({ id: number });
        if (result && result.creds) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(result.creds, null, 2));
            return true;
        }
        return false;
    } catch (error) {
        console.error("Error restoring session:", error);
        return false;
    }
}

// 2. Session එක Mongo වලට
async function saveSessionToDB(number, sessionPath) {
    try {
        if (!db) return;
        const credsPath = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
            const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            await db.collection('sessions').updateOne(
                { id: number },
                { $set: { creds: creds, updatedAt: new Date() } },
                { upsert: true }
            );
        }
    } catch (error) {
        console.error("Error saving session to DB:", error);
    }
}

// 3. User Config එක DB එකෙන් ගන්න
async function loadUserConfig(number) {
    try {
        if (!db) return { ...config };
        const result = await db.collection('user_configs').findOne({ id: number });
        return result && result.config ? result.config : { ...config };
    } catch (error) {
        return { ...config };
    }
}

// 4. Config Update කරන්න
async function updateUserConfig(number, newConfig) {
    if (!db) return;
    await db.collection('user_configs').updateOne(
        { id: number },
        { $set: { config: newConfig } },
        { upsert: true }
    );
}


async function addActiveNumber(number) {
    if (!db) return;
    await db.collection('active_numbers').updateOne(
        { id: number },
        { $set: { status: 'active', connectedAt: new Date() } },
        { upsert: true }
    );
}


async function deleteDataFromDB(number) {
    if (!db) return;
    await db.collection('sessions').deleteOne({ id: number });
    await db.collection('active_numbers').deleteOne({ id: number });
    await db.collection('user_configs').deleteOne({ id: number });
}


async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { status: 'failed', error: 'Invalid group invite link' };
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            return response?.gid ? { status: 'success', gid: response.gid } : { status: 'failed' };
        } catch (error) {
            retries--;
            await delay(2000);
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number) {
    const admins = loadAdmins();
    for (const admin of admins) {
        try {
            await socket.sendMessage(`${admin}@s.whatsapp.net`, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage('Bot Connected', `Number: ${number}`, 'Powered By Riko')
            });
        } catch (e) {}
    }
}

// ... (Other helper functions like sendOTP, updateAboutStatus, etc. remain the same)
// I am keeping the logic concise to fit. Use your previous helper functions here.
async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    await socket.sendMessage(userJid, { text: `Your OTP: ${otp}` });
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;
        try {
            const emojis = ['♻️', '🪄', '❗', '🧚‍♂️'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;
            if (messageId) {
                await socket.newsletterReactMessage(config.NEWSLETTER_JID, messageId.toString(), randomEmoji);
            }
        } catch (error) {}
    });
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        let command = null;
        let sender = msg.key.remoteJid;

        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(config.PREFIX)) {
                const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
            }
        }

        if (!command) return;

        try {
            switch (command) {
                case 'alive':
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage('Alive 🧚‍♂️', `Bot Active on ${number}`, 'Riko Mini Bot')
                    });
                    break;

                case 'deleteme':
                    // Local Files Delete
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
                    
                    // MongoDB Delete
                    await deleteDataFromDB(number.replace(/[^0-9]/g, ''));

                    // Socket Close
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, { text: "✅ Session Deleted from Server & Database." });
                    break;
                
                // Add other cases (song, video, etc.) here...
            }
        } catch (e) { console.error(e); }
    });
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, reconnecting...`);
            await delay(5000);
            activeSockets.delete(number.replace(/[^0-9]/g, ''));
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        }
    });
}



async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    // 1. Try to restore from DB
    await restoreSessionFromDB(sanitizedNumber, sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Setup Handlers
        setupCommandHandlers(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);

        // Pairing Code Logic
        if (!socket.authState.creds.registered) {
            let retries = 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000);
                }
            }
            if (!res.headersSent) res.send({ code });
        }

        // Save Creds to DB on Update
        socket.ev.on('creds.update', async () => {
            await saveCreds();
            await saveSessionToDB(sanitizedNumber, sessionPath); // 🔥 Save to MongoDB
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    
                    // Config Load
                    const userConfig = await loadUserConfig(sanitizedNumber);
                    
                    activeSockets.set(sanitizedNumber, socket);
                    await addActiveNumber(sanitizedNumber); // 🔥 Add to DB Active List

                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage('Connected', `✅ Number: ${sanitizedNumber}`, 'Powered By Riko')
                    });

                    // Newsletter Follow
                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                    } catch (e) {}

                } catch (error) {
                    console.error('Connection post-processing error:', error);
                }
            }
        });

    } catch (error) {
        console.error('Pairing error:', error);
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}



router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({ status: 'already_connected' });
    }
    await EmpirePair(number, res);
});

// Auto Reconnect All from DB
router.get('/connect-all', async (req, res) => {
    try {
        if(!db) return res.status(500).send({error: "DB not connected"});
        const docs = await db.collection('active_numbers').find({}).toArray();
        const numbers = docs.map(d => d.id);

        if (numbers.length === 0) return res.status(404).send({ error: 'No numbers found' });

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }
        res.status(200).send({ status: 'success', connections: results });
    } catch (error) {
        res.status(500).send({ error: 'Failed' });
    }
});

// Auto Reconnect Logic (Runs on Start)
async function autoReconnectFromDB() {
    if(!db) return;
    try {
        const docs = await db.collection('active_numbers').find({}).toArray();
        for (const doc of docs) {
            if (!activeSockets.has(doc.id)) {
                console.log(`🔁 Reconnecting ${doc.id} from DB...`);
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(doc.id, mockRes);
                await delay(2000);
            }
        }
    } catch (e) { console.error("Auto Reconnect Error:", e); }
}

module.exports = router;