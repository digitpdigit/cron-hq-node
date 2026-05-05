const path = require("path");
const express = require("express");
const {
    validateSettingsArray,
    saveSettings,
} = require("./settingsStore");

function isReadableStreamLike(v) {
    return (
        v != null &&
        typeof v === "object" &&
        typeof v.getReader === "function"
    );
}

/** Safe JSON payloads for REST + SSE (Dates → ISO; streams → marker). */
function serializeLogEntry(entry) {
    return {
        ...entry,
        timestamp:
            entry.timestamp instanceof Date
                ? entry.timestamp.toISOString()
                : entry.timestamp,
        data: isReadableStreamLike(entry.data) ? "[ReadableStream]" : entry.data,
    };
}

function serializeLogsGrouped(grouped) {
    const out = {};
    for (const [name, entries] of Object.entries(grouped)) {
        out[name] = entries.map(serializeLogEntry);
    }
    return out;
}

/** Build `{ summaries, flat }` for dashboard: merge cron/url from live callers (getInfo) with settings fallback. */
function buildLogsDashboardPayload(hq) {
    const metaByCaller = {};
    for (const info of hq.getCallerInformations()) {
        metaByCaller[info.name] = {
            cron: info.cron ?? "",
            url: info.url ?? "",
        };
    }
    for (const s of hq.settings) {
        const k = s.jobs;
        if (!(k in metaByCaller)) {
            metaByCaller[k] = {
                cron: s.cron ?? "",
                url: s.url ?? "",
            };
        }
    }

    const groupedRaw = hq.getLogs();

    /** @returns {Record<string, any[]>} */
    const augmentedGrouped = {};
    for (const [name, entries] of Object.entries(groupedRaw)) {
        const meta = metaByCaller[name] || { cron: "", url: "" };
        augmentedGrouped[name] = entries.map((entry) => {
            const serialized = serializeLogEntry(entry);
            return {
                ...serialized,
                caller: name,
                cron: meta.cron,
                url: meta.url,
            };
        });
    }

    const flat = Object.values(augmentedGrouped)
        .flat()
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    const summaries = [];
    for (const setting of hq.settings) {
        const callerName = setting.jobs;
        const entries = augmentedGrouped[callerName] || [];
        const last = entries.length ? entries[entries.length - 1] : null;
        const slice = entries.slice(-3).reverse();

        summaries.push({
            caller: callerName,
            url: setting.url ?? "",
            cron: setting.cron ?? "",
            lastTag: last ? last.tag : null,
            latestStatus: last ? last.status : null,
            lastTimestamp: last ? last.timestamp : null,
            lastMessage: last ? last.message : null,
            recentThree: slice.map((e) => ({
                id: e.id,
                timestamp: e.timestamp,
                tag: e.tag,
                data: e.data,
                message: e.message,
                status: e.status,
                error: e.error,
            })),
        });
    }

    return { summaries, flat };
}

function createApp(hq) {
    const app = express();
    app.use(express.json({ limit: "512kb" }));

    /** All JSON / SSE endpoints under `/api` (single Router — avoids stray 404 when wiring paths). */
    const apiRouter = express.Router();

    apiRouter.get("/settings", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(structuredClone(hq.settings));
    });

    apiRouter.get("/callers/informations", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(hq.getCallerInformations());
    });

    apiRouter.put("/settings", async (req, res) => {
        try {
            validateSettingsArray(req.body);
            await saveSettings(req.body);
            hq.reload(req.body);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({
                ok: false,
                error: err.message || String(err),
            });
        }
    });

    apiRouter.get("/logs", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.json(buildLogsDashboardPayload(hq));
    });

    apiRouter.post("/logs/clear", (req, res) => {
        hq.clearLogs();
        res.status(204).end();
    });

    apiRouter.get("/events", (req, res) => {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }

        const send = () => {
            try {
                const payload = buildLogsDashboardPayload(hq);
                res.write(`event: logs\ndata: ${JSON.stringify(payload)}\n\n`);
            } catch (e) {
                res.write(
                    `event: error\ndata: ${JSON.stringify({ message: String(e.message) })}\n\n`
                );
            }
        };

        send();
        const interval = setInterval(send, 1000);

        req.on("close", () => {
            clearInterval(interval);
            try {
                res.end();
            } catch (_) {
                /* ignore */
            }
        });
    });

    const apiProbe = (_req, res) => {
        res.set("Cache-Control", "no-store");
        res.json({
            ok: true,
            name: "cron-hq",
            endpoints: [
                "GET /api",
                "GET /api/settings",
                "GET /api/callers/informations",
                "PUT /api/settings",
                "GET /api/logs",
                "POST /api/logs/clear",
                "GET /api/events",
            ],
        });
    };
    /** Express 5: mount + Router GET "/" may not match bare `/api`; register explicitly first. */
    app.get("/api", apiProbe);
    app.get("/api/", apiProbe);

    app.use("/api", apiRouter);

    const publicDir = path.join(__dirname, "public");
    app.use(express.static(publicDir));

    return app;
}

module.exports = {
    createApp,
    serializeLogsGrouped,
    buildLogsDashboardPayload,
};
