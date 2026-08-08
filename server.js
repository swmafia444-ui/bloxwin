const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const ADMIN_USERS = [
    "dedokxxreal",
    "emoxdrill"
].map(v => v.toLowerCase());

const DATA_FILE = path.join(__dirname, "bloxwin-data.json");

const allowedOrigins = (process.env.FRONTEND_URL || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

/*
|--------------------------------------------------------------------------
| MIDDLEWARE
|--------------------------------------------------------------------------
*/

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);

        if (allowedOrigins.length === 0) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("CORS origin not allowed"));
    },

    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Session-Token"
    ]
}));

app.use(express.json({
    limit: "50kb"
}));

app.use(express.static(__dirname));

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
|
| Basit JSON database.
| Sunucu ilk açıldığında otomatik oluşturulur.
|
*/

function createEmptyDatabase() {
    return {
        users: {},
        mutedUsers: [],
        bannedUsers: [],
        sessions: {}
    };
}

function loadDatabase() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            const empty = createEmptyDatabase();
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(empty, null, 2),
                "utf8"
            );
            return empty;
        }

        const raw = fs.readFileSync(DATA_FILE, "utf8");

        if (!raw.trim()) {
            return createEmptyDatabase();
        }

        const parsed = JSON.parse(raw);

        return {
            users: parsed.users || {},
            mutedUsers: Array.isArray(parsed.mutedUsers)
                ? parsed.mutedUsers
                : [],
            bannedUsers: Array.isArray(parsed.bannedUsers)
                ? parsed.bannedUsers
                : [],
            sessions: parsed.sessions || {}
        };
    } catch (error) {
        console.error("Database load error:", error);

        const empty = createEmptyDatabase();

        try {
            fs.writeFileSync(
                DATA_FILE,
                JSON.stringify(empty, null, 2),
                "utf8"
            );
        } catch (_) {}

        return empty;
    }
}

let db = loadDatabase();

function saveDatabase() {
    try {
        const tempFile = DATA_FILE + ".tmp";

        fs.writeFileSync(
            tempFile,
            JSON.stringify(db, null, 2),
            "utf8"
        );

        fs.renameSync(tempFile, DATA_FILE);

        return true;
    } catch (error) {
        console.error("Database save error:", error);
        return false;
    }
}

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function normalize(value) {
    return String(value || "")
        .trim()
        .toLowerCase();
}

function cleanUsername(value) {
    if (typeof value !== "string") return "";

    return value
        .trim()
        .slice(0, 20);
}

function cleanPetName(value) {
    if (typeof value !== "string") return "";

    return value
        .trim()
        .slice(0, 100);
}

function cleanImageUrl(value) {
    if (typeof value !== "string") return "";

    const url = value.trim().slice(0, 1000);

    if (!/^https?:\/\//i.test(url)) {
        return "";
    }

    return url;
}

function isAdmin(username) {
    return ADMIN_USERS.includes(
        normalize(username)
    );
}

function isMuted(username) {
    return db.mutedUsers.includes(
        normalize(username)
    );
}

function isBanned(username) {
    return db.bannedUsers.includes(
        normalize(username)
    );
}

function ensureUser(username, robloxId = null) {
    const clean = cleanUsername(username);

    if (!clean) return null;

    const key = normalize(clean);

    if (!db.users[key]) {
        db.users[key] = {
            username: clean,
            robloxId: robloxId || null,
            inventory: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    } else {
        if (robloxId) {
            db.users[key].robloxId = robloxId;
        }

        db.users[key].username = clean;
        db.users[key].updatedAt = Date.now();
    }

    return db.users[key];
}

function getUser(username) {
    return db.users[normalize(username)] || null;
}

function generatePetId() {
    return crypto.randomBytes(12).toString("hex");
}

function generateSessionToken() {
    return crypto.randomBytes(48).toString("hex");
}

/*
|--------------------------------------------------------------------------
| RATE LIMIT
|--------------------------------------------------------------------------
*/

const requestLog = new Map();

function rateLimit(key, limit = 12, windowMs = 60_000) {
    const now = Date.now();

    const item = requestLog.get(key) || {
        count: 0,
        reset: now + windowMs
    };

    if (now > item.reset) {
        item.count = 0;
        item.reset = now + windowMs;
    }

    item.count++;

    requestLog.set(key, item);

    return item.count <= limit;
}

/*
|--------------------------------------------------------------------------
| SESSION
|--------------------------------------------------------------------------
*/

function getSessionToken(req) {
    const headerToken =
        req.headers["x-session-token"];

    if (typeof headerToken === "string" && headerToken.trim()) {
        return headerToken.trim();
    }

    const auth =
        req.headers.authorization;

    if (
        typeof auth === "string" &&
        auth.startsWith("Bearer ")
    ) {
        return auth.slice(7).trim();
    }

    return "";
}

function getSession(req) {
    const token = getSessionToken(req);

    if (!token) return null;

    const session = db.sessions[token];

    if (!session) return null;

    if (Date.now() > session.expiresAt) {
        delete db.sessions[token];
        saveDatabase();
        return null;
    }

    return {
        token,
        ...session
    };
}

function requireLogin(req, res, next) {
    const session = getSession(req);

    if (!session) {
        return res.status(401).json({
            error: "You are not logged in."
        });
    }

    req.session = session;

    next();
}

function requireAdmin(req, res, next) {
    const session = getSession(req);

    if (!session) {
        return res.status(401).json({
            error: "You are not logged in."
        });
    }

    if (!isAdmin(session.username)) {
        return res.status(403).json({
            error: "Access denied."
        });
    }

    req.session = session;

    next();
}

/*
|--------------------------------------------------------------------------
| ROBLOX API
|--------------------------------------------------------------------------
*/

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
        const error = new Error(
            `Roblox API returned ${response.status}`
        );

        error.status = response.status;
        error.data = data;

        throw error;
    }

    return data;
}

async function getRobloxAvatar(userId) {
    try {
        const data = await robloxRequest(
            `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(
                userId
            )}&size=150x150&format=Png&isCircular=true`
        );

        return data?.data?.[0]?.imageUrl || "";
    } catch (_) {
        return "";
    }
}

/*
|--------------------------------------------------------------------------
| ROBLOX VERIFICATION
|--------------------------------------------------------------------------
*/

const pendingVerifications = new Map();

function generateVerificationCode() {
    const alphabet =
        "ABCDEFGHJKLMNPQRSTUVWXYZ";

    let code = "";

    for (let i = 0; i < 9; i++) {
        code += alphabet[
            crypto.randomInt(
                0,
                alphabet.length
            )
        ];
    }

    return code;
}

/*
|--------------------------------------------------------------------------
| FIND ROBLOX USER
|--------------------------------------------------------------------------
*/

app.post(
    "/api/roblox/user",
    async (req, res) => {

        const ip = req.ip || "unknown";

        if (!rateLimit(
            `lookup:${ip}`,
            20,
            60_000
        )) {
            return res.status(429).json({
                error:
                    "Too many requests. Please wait a minute."
            });
        }

        const username =
            cleanUsername(
                req.body?.username
            );

        if (!username || username.length < 3) {
            return res.status(400).json({
                error:
                    "Enter a valid Roblox username."
            });
        }

        try {
            const data =
                await robloxRequest(
                    "https://users.roblox.com/v1/usernames/users",
                    {
                        method: "POST",

                        body: JSON.stringify({
                            usernames: [username],
                            excludeBannedUsers: false
                        })
                    }
                );

            const user =
                data?.data?.[0];

            if (!user) {
                return res.status(404).json({
                    error:
                        "Roblox user not found."
                });
            }

            const avatarUrl =
                await getRobloxAvatar(
                    user.id
                );

            return res.json({
                user: {
                    id: user.id,
                    name: user.name,
                    displayName:
                        user.displayName,
                    avatarUrl
                }
            });

        } catch (error) {
            console.error(
                "Roblox lookup error:",
                error
            );

            return res.status(502).json({
                error:
                    "Could not reach Roblox right now. Try again."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| START VERIFICATION
|--------------------------------------------------------------------------
*/

app.post(
    "/api/roblox/start-verification",
    async (req, res) => {

        const ip = req.ip || "unknown";

        if (!rateLimit(
            `start:${ip}`,
            10,
            60_000
        )) {
            return res.status(429).json({
                error:
                    "Too many verification attempts. Please wait."
            });
        }

        const userId =
            Number(req.body?.userId);

        if (
            !Number.isSafeInteger(userId) ||
            userId <= 0
        ) {
            return res.status(400).json({
                error:
                    "Invalid Roblox account."
            });
        }

        const code =
            generateVerificationCode();

        const token =
            crypto.randomBytes(32).toString("hex");

        const expiresAt =
            Date.now() +
            10 * 60 * 1000;

        for (
            const [key, value]
            of pendingVerifications
        ) {
            if (value.userId === userId) {
                pendingVerifications.delete(key);
            }
        }

        pendingVerifications.set(
            token,
            {
                userId,
                code,
                expiresAt,
                attempts: 0,
                ip
            }
        );

        return res.json({
            token,
            code,
            expiresAt
        });
    }
);

/*
|--------------------------------------------------------------------------
| VERIFY ROBLOX ACCOUNT
|--------------------------------------------------------------------------
*/

app.post(
    "/api/roblox/verify",
    async (req, res) => {

        const ip = req.ip || "unknown";

        if (!rateLimit(
            `verify:${ip}`,
            15,
            60_000
        )) {
            return res.status(429).json({
                error:
                    "Too many verification attempts. Please wait."
            });
        }

        const token =
            typeof req.body?.token === "string"
                ? req.body.token
                : "";

        const code =
            typeof req.body?.code === "string"
                ? req.body.code.trim()
                : "";

        const challenge =
            pendingVerifications.get(token);

        if (!challenge) {
            return res.status(400).json({
                error:
                    "Verification session is invalid or expired."
            });
        }

        if (
            Date.now() >
            challenge.expiresAt
        ) {
            pendingVerifications.delete(token);

            return res.status(400).json({
                error:
                    "This verification code has expired. Start again."
            });
        }

        challenge.attempts++;

        if (challenge.attempts > 8) {
            pendingVerifications.delete(token);

            return res.status(429).json({
                error:
                    "Too many incorrect attempts. Start again."
            });
        }

        if (
            !/^[A-Z]{9}$/.test(code) ||
            code !== challenge.code
        ) {
            return res.status(400).json({
                error:
                    "Incorrect verification code. Enter the 9 letters exactly as shown."
            });
        }

        try {
            const profile =
                await robloxRequest(
                    `https://users.roblox.com/v1/users/${encodeURIComponent(
                        challenge.userId
                    )}`
                );

            const description =
                String(
                    profile?.description || ""
                );

            if (
                !description.includes(
                    challenge.code
                )
            ) {
                return res.status(400).json({
                    error:
                        "The code was not found in this Roblox profile's About / Description."
                });
            }

            pendingVerifications.delete(token);

            const username =
                cleanUsername(
                    profile.name
                );

            /*
             * Create / update server-side user.
             */
            ensureUser(
                username,
                profile.id
            );

            /*
             * Create login session.
             */
            const sessionToken =
                generateSessionToken();

            db.sessions[sessionToken] = {
                username,
                robloxId: profile.id,
                createdAt: Date.now(),
                expiresAt:
                    Date.now() +
                    30 * 24 * 60 * 60 * 1000
            };

            saveDatabase();

            return res.json({
                success: true,

                token: sessionToken,

                user: {
                    id: profile.id,
                    name: profile.name,
                    displayName:
                        profile.displayName
                }
            });

        } catch (error) {
            console.error(
                "Roblox verification error:",
                error
            );

            return res.status(502).json({
                error:
                    "Could not check the Roblox profile right now. Try again."
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| LOGOUT
|--------------------------------------------------------------------------
*/

app.post(
    "/api/logout",
    requireLogin,
    (req, res) => {

        delete db.sessions[
            req.session.token
        ];

        saveDatabase();

        return res.json({
            success: true
        });
    }
);

/*
|--------------------------------------------------------------------------
| CURRENT USER
|--------------------------------------------------------------------------
*/

app.get(
    "/api/me",
    requireLogin,
    (req, res) => {

        const user =
            getUser(
                req.session.username
            );

        if (!user) {
            return res.status(404).json({
                error:
                    "User not found."
            });
        }

        return res.json({
            user: {
                username:
                    user.username,

                robloxId:
                    user.robloxId,

                inventory:
                    user.inventory,

                muted:
                    isMuted(
                        user.username
                    ),

                banned:
                    isBanned(
                        user.username
                    ),

                admin:
                    isAdmin(
                        user.username
                    )
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| GET INVENTORY
|--------------------------------------------------------------------------
*/

app.get(
    "/api/inventory",
    requireLogin,
    (req, res) => {

        const user =
            getUser(
                req.session.username
            );

        if (!user) {
            return res.status(404).json({
                error:
                    "User not found."
            });
        }

        return res.json({
            username:
                user.username,

            inventory:
                user.inventory
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - LIST USERS
|--------------------------------------------------------------------------
*/

app.get(
    "/api/admin/users",
    requireAdmin,
    (req, res) => {

        const users =
            Object.values(
                db.users
            ).map(user => ({
                username:
                    user.username,

                robloxId:
                    user.robloxId,

                petCount:
                    user.inventory.length,

                muted:
                    isMuted(
                        user.username
                    ),

                banned:
                    isBanned(
                        user.username
                    ),

                admin:
                    isAdmin(
                        user.username
                    )
            }));

        /*
         * Also include configured admins
         * even if they have not created inventory yet.
         */

        for (
            const adminName
            of ADMIN_USERS
        ) {
            const exists =
                users.some(
                    user =>
                        normalize(
                            user.username
                        ) === adminName
                );

            if (!exists) {
                users.push({
                    username:
                        adminName,

                    robloxId:
                        null,

                    petCount: 0,

                    muted:
                        isMuted(
                            adminName
                        ),

                    banned:
                        isBanned(
                            adminName
                        ),

                    admin: true
                });
            }
        }

        return res.json({
            users
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - GET USER
|--------------------------------------------------------------------------
*/

app.get(
    "/api/admin/user/:username",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.params.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Invalid username."
            });
        }

        const user =
            getUser(username);

        if (!user) {
            return res.json({
                exists: false,

                user: {
                    username,
                    inventory: [],
                    muted:
                        isMuted(username),
                    banned:
                        isBanned(username),
                    admin:
                        isAdmin(username)
                }
            });
        }

        return res.json({
            exists: true,

            user: {
                username:
                    user.username,

                robloxId:
                    user.robloxId,

                inventory:
                    user.inventory,

                muted:
                    isMuted(
                        user.username
                    ),

                banned:
                    isBanned(
                        user.username
                    ),

                admin:
                    isAdmin(
                        user.username
                    )
            }
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - ADD PET
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/add-pet",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        const name =
            cleanPetName(
                req.body?.name
            );

        const icon =
            cleanImageUrl(
                req.body?.icon
            );

        const value =
            Number(
                req.body?.value
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Target username is required."
            });
        }

        if (!name) {
            return res.status(400).json({
                error:
                    "Pet name is required."
            });
        }

        if (!icon) {
            return res.status(400).json({
                error:
                    "A valid image URL is required."
            });
        }

        if (
            !Number.isFinite(value) ||
            value < 0
        ) {
            return res.status(400).json({
                error:
                    "Pet value is invalid."
            });
        }

        /*
         * Ensure target user exists.
         * This is the important part that fixes
         * "I can only give myself pets".
         */

        const user =
            ensureUser(username);

        const pet = {
            id:
                generatePetId(),

            name,

            icon,

            value,

            addedBy:
                req.session.username,

            addedAt:
                Date.now()
        };

        user.inventory.push(pet);

        user.updatedAt =
            Date.now();

        if (!saveDatabase()) {
            return res.status(500).json({
                error:
                    "Could not save inventory."
            });
        }

        return res.json({
            success: true,

            message:
                `Added ${name} to ${user.username}'s inventory.`,

            pet,

            inventory:
                user.inventory
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - REMOVE PET
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/remove-pet",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        const petName =
            cleanPetName(
                req.body?.petName
            );

        if (!username || !petName) {
            return res.status(400).json({
                error:
                    "Username and pet name are required."
            });
        }

        const user =
            getUser(username);

        if (!user) {
            return res.status(404).json({
                error:
                    "User does not exist."
            });
        }

        const index =
            user.inventory.findIndex(
                pet =>
                    normalize(
                        pet.name
                    ) === normalize(
                        petName
                    )
            );

        if (index === -1) {
            return res.status(404).json({
                error:
                    `Pet "${petName}" was not found in ${user.username}'s inventory.`
            });
        }

        const removed =
            user.inventory.splice(
                index,
                1
            )[0];

        user.updatedAt =
            Date.now();

        saveDatabase();

        return res.json({
            success: true,

            message:
                `Removed ${removed.name} from ${user.username}'s inventory.`,

            removed,

            inventory:
                user.inventory
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - MUTE
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/mute",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Username is required."
            });
        }

        const normalized =
            normalize(username);

        if (
            !db.mutedUsers.includes(
                normalized
            )
        ) {
            db.mutedUsers.push(
                normalized
            );
        }

        ensureUser(username);

        saveDatabase();

        return res.json({
            success: true,

            username,

            muted: true,

            message:
                `${username} has been muted.`
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - UNMUTE
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/unmute",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Username is required."
            });
        }

        const normalized =
            normalize(username);

        db.mutedUsers =
            db.mutedUsers.filter(
                user =>
                    user !== normalized
            );

        saveDatabase();

        return res.json({
            success: true,

            username,

            muted: false,

            message:
                `${username} has been unmuted.`
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - BAN
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/ban",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Username is required."
            });
        }

        /*
         * Do not allow admins to be banned.
         */

        if (isAdmin(username)) {
            return res.status(400).json({
                error:
                    "Administrators cannot be banned."
            });
        }

        const normalized =
            normalize(username);

        if (
            !db.bannedUsers.includes(
                normalized
            )
        ) {
            db.bannedUsers.push(
                normalized
            );
        }

        ensureUser(username);

        saveDatabase();

        return res.json({
            success: true,

            username,

            banned: true,

            message:
                `${username} has been banned.`
        });
    }
);

/*
|--------------------------------------------------------------------------
| ADMIN - UNBAN
|--------------------------------------------------------------------------
*/

app.post(
    "/api/admin/unban",
    requireAdmin,
    (req, res) => {

        const username =
            cleanUsername(
                req.body?.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Username is required."
            });
        }

        const normalized =
            normalize(username);

        db.bannedUsers =
            db.bannedUsers.filter(
                user =>
                    user !== normalized
            );

        saveDatabase();

        return res.json({
            success: true,

            username,

            banned: false,

            message:
                `${username} has been unbanned.`
        });
    }
);

/*
|--------------------------------------------------------------------------
| CHAT STATUS
|--------------------------------------------------------------------------
*/

app.get(
    "/api/chat/status/:username",
    (req, res) => {

        const username =
            cleanUsername(
                req.params.username
            );

        if (!username) {
            return res.status(400).json({
                error:
                    "Invalid username."
            });
        }

        return res.json({
            username,

            muted:
                isMuted(username),

            banned:
                isBanned(username)
        });
    }
);

/*
|--------------------------------------------------------------------------
| CHAT MESSAGE CHECK
|--------------------------------------------------------------------------
|
| Frontend mesaj göndermeden önce bunu çağırabilir.
|
*/

app.post(
    "/api/chat/check",
    requireLogin,
    (req, res) => {

        const username =
            req.session.username;

        return res.json({
            allowed:
                !isMuted(username) &&
                !isBanned(username),

            muted:
                isMuted(username),

            banned:
                isBanned(username)
        });
    }
);

/*
|--------------------------------------------------------------------------
| CLEANUP SESSIONS
|--------------------------------------------------------------------------
*/

setInterval(() => {

    const now =
        Date.now();

    let changed = false;

    for (
        const token
        of Object.keys(
            db.sessions
        )
    ) {
        if (
            now >
            db.sessions[token].expiresAt
        ) {
            delete db.sessions[token];
            changed = true;
        }
    }

    if (changed) {
        saveDatabase();
    }

}, 60_000).unref();

/*
|--------------------------------------------------------------------------
| CLEANUP VERIFICATION CHALLENGES
|--------------------------------------------------------------------------
*/

setInterval(() => {

    const now =
        Date.now();

    for (
        const [token, challenge]
        of pendingVerifications
    ) {
        if (
            now >
            challenge.expiresAt
        ) {
            pendingVerifications.delete(
                token
            );
        }
    }

}, 60_000).unref();

/*
|--------------------------------------------------------------------------
| ERROR HANDLER
|--------------------------------------------------------------------------
*/

app.use(
    (err, req, res, next) => {

        console.error(
            "Server error:",
            err
        );

        if (
            err.message ===
            "CORS origin not allowed"
        ) {
            return res.status(403).json({
                error:
                    "CORS origin not allowed."
            });
        }

        return res.status(500).json({
            error:
                "Internal server error."
        });
    }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    () => {
        console.log(
            `BloxWin running at http://localhost:${PORT}`
        );

        console.log(
            `Database: ${DATA_FILE}`
        );
    }
);
