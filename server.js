const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.FRONTEND_URL || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // Allow server-to-server/no-origin requests and local development.
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("CORS origin not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname)));

const pendingVerifications = new Map();
const requestLog = new Map();

function rateLimit(key, limit = 12, windowMs = 60_000) {
    const now = Date.now();
    const item = requestLog.get(key) || { count: 0, reset: now + windowMs };

    if (now > item.reset) {
        item.count = 0;
        item.reset = now + windowMs;
    }

    item.count++;
    requestLog.set(key, item);
    return item.count <= limit;
}

function cleanUsername(value) {
    return typeof value === "string" ? value.trim().slice(0, 20) : "";
}

function generateVerificationCode() {
    // Letters-only tokens are much less likely to be filtered by Roblox
    // than long numeric strings.
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    let code = "";
    for (let i = 0; i < 9; i++) {
        code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return code;
}

async function robloxRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...(options.headers || {})
        }
    });

    let data = null;
    try {
        data = await response.json();
    } catch (_) {}

    if (!response.ok) {
        const error = new Error(`Roblox API returned ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
    }

    return data;
}

async function getRobloxAvatar(userId) {
    try {
        const data = await robloxRequest(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=150x150&format=Png&isCircular=true`
        );
        return data?.data?.[0]?.imageUrl || "";
    } catch (_) {
        return "";
    }
}

// Find a Roblox account from its exact username.
app.post("/api/roblox/user", async (req, res) => {
    const ip = req.ip || "unknown";
    if (!rateLimit(`lookup:${ip}`, 20, 60_000)) {
        return res.status(429).json({ error: "Too many requests. Please wait a minute." });
    }

    const username = cleanUsername(req.body?.username);
    if (!username || username.length < 3) {
        return res.status(400).json({ error: "Enter a valid Roblox username." });
    }

    try {
        const data = await robloxRequest("https://users.roblox.com/v1/usernames/users", {
            method: "POST",
            body: JSON.stringify({
                usernames: [username],
                excludeBannedUsers: false
            })
        });

        const user = data?.data?.[0];
        if (!user) {
            return res.status(404).json({ error: "Roblox user not found." });
        }

        const avatarUrl = await getRobloxAvatar(user.id);

        return res.json({
            user: {
                id: user.id,
                name: user.name,
                displayName: user.displayName,
                avatarUrl
            }
        });
    } catch (error) {
        console.error("Roblox lookup error:", error);
        return res.status(502).json({ error: "Could not reach Roblox right now. Try again." });
    }
});

// Create a short-lived verification challenge.
app.post("/api/roblox/start-verification", async (req, res) => {
    const ip = req.ip || "unknown";
    if (!rateLimit(`start:${ip}`, 10, 60_000)) {
        return res.status(429).json({ error: "Too many verification attempts. Please wait." });
    }

    const userId = Number(req.body?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: "Invalid Roblox account." });
    }

    const code = generateVerificationCode();
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 10 * 60 * 1000;

    // Remove older challenges for this account.
    for (const [key, value] of pendingVerifications) {
        if (value.userId === userId) pendingVerifications.delete(key);
    }

    pendingVerifications.set(token, {
        userId,
        code,
        expiresAt,
        attempts: 0,
        ip
    });

    return res.json({ token, code, expiresAt });
});

// Verify the code against the public Roblox profile description.
app.post("/api/roblox/verify", async (req, res) => {
    const ip = req.ip || "unknown";
    if (!rateLimit(`verify:${ip}`, 15, 60_000)) {
        return res.status(429).json({ error: "Too many verification attempts. Please wait." });
    }

    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

    const challenge = pendingVerifications.get(token);
    if (!challenge) {
        return res.status(400).json({ error: "Verification session is invalid or expired." });
    }

    if (Date.now() > challenge.expiresAt) {
        pendingVerifications.delete(token);
        return res.status(400).json({ error: "This verification code has expired. Start again." });
    }

    challenge.attempts++;
    if (challenge.attempts > 8) {
        pendingVerifications.delete(token);
        return res.status(429).json({ error: "Too many incorrect attempts. Start again." });
    }

    if (!/^[A-Z]{9}$/.test(code) || code !== challenge.code) {
        return res.status(400).json({ error: "Incorrect verification code. Enter the 9 letters exactly as shown." });
    }

    try {
        // The public user profile endpoint is used only to read public profile data.
        const profile = await robloxRequest(
            `https://users.roblox.com/v1/users/${encodeURIComponent(challenge.userId)}`
        );

        const description = String(profile?.description || "");
        if (!description.includes(challenge.code)) {
            return res.status(400).json({
                error: "The code was not found in this Roblox profile's About / Description."
            });
        }

        // One-time use: delete the challenge before returning success.
        pendingVerifications.delete(token);

        return res.json({
            success: true,
            user: {
                id: profile.id,
                name: profile.name,
                displayName: profile.displayName
            }
        });
    } catch (error) {
        console.error("Roblox verification error:", error);
        return res.status(502).json({ error: "Could not check the Roblox profile right now. Try again." });
    }
});

// Clean expired challenges periodically.
setInterval(() => {
    const now = Date.now();
    for (const [token, challenge] of pendingVerifications) {
        if (now > challenge.expiresAt) pendingVerifications.delete(token);
    }
}, 60_000).unref();

app.listen(PORT, () => {
    console.log(`BloxWin running at http://localhost:${PORT}`);
});
