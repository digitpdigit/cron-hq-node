const Caller = require("./caller");
const cron = require("node-cron");

/** Weekly Sunday 03:00:00 (optional seconds field). */
const DEFAULT_LOG_PURGE_CRON = "0 0 3 * * 0";

/**
 * @param {unknown} val raw env string / boolean (dotenv is always string)
 * @returns {string|null} cron expression or null when disabled
 */
function coerceLogPurgeCron(val) {
    if (val === undefined || val === null) {
        return DEFAULT_LOG_PURGE_CRON;
    }
    if (typeof val === "boolean") {
        return val ? DEFAULT_LOG_PURGE_CRON : null;
    }
    const t = String(val).trim();
    if (t === "") {
        return DEFAULT_LOG_PURGE_CRON;
    }
    const lower = t.toLowerCase();
    if (lower === "false") {
        return null;
    }
    if (lower === "true") {
        return DEFAULT_LOG_PURGE_CRON;
    }
    return t;
}

/** Read scheduled log purge from env only (omit var → default weekly). */
function effectiveLogPurgeCronFromEnv() {
    if (Object.prototype.hasOwnProperty.call(process.env, "LOG_PURGE_CRON")) {
        return coerceLogPurgeCron(process.env.LOG_PURGE_CRON);
    }
    return DEFAULT_LOG_PURGE_CRON;
}

class HQ {
    constructor({ settings, debug }) {
        this.settings = settings;
        this.caller = [];
        this.tasks = [];
        this.logPurgeCron = effectiveLogPurgeCronFromEnv();
        this.logPurgeTask = null;
        this.debug = debug;
    }

    stopScheduledTasks() {
        for (const task of this.tasks) {
            try {
                task.stop();
            } catch (_) {
                /* ignore */
            }
        }
        this.tasks = [];
    }

    stopLogPurgeTask() {
        if (this.logPurgeTask) {
            try {
                this.logPurgeTask.stop();
            } catch (_) {
                /* ignore */
            }
            this.logPurgeTask = null;
        }
    }

    clearLogs() {
        for (const c of this.caller) {
            c.clearLogs();
        }
    }

    _mountSchedulers() {
        for (const setting of this.settings) {
            const caller = new Caller(
                setting.url,
                setting.method,
                setting.body,
                setting.headers,
                setting.jobs,
                setting.cron,
                this.debug
            );
            this.caller.push(caller);
            console.log("Scheduling cron for", setting.jobs, setting.cron);
            const task = cron.schedule(setting.cron, () => {
                caller.call();
            });
            this.tasks.push(task);
        }
    }

    _mountLogPurgeScheduler() {
        if (this.logPurgeCron === null) {
            return;
        }
        if (!cron.validate(this.logPurgeCron)) {
            console.warn(
                "LOG_PURGE_CRON invalid, skipping scheduled log purge:",
                this.logPurgeCron
            );
            return;
        }
        console.log("Scheduling log purge cron:", this.logPurgeCron);
        this.logPurgeTask = cron.schedule(this.logPurgeCron, () => {
            console.log("cron-hq: scheduled log purge");
            this.clearLogs();
        });
    }

    initialize() {
        this.reload(this.settings);
    }

    reload(nextSettings) {
        this.stopScheduledTasks();
        this.stopLogPurgeTask();
        this.caller = [];
        this.settings = structuredClone(nextSettings);
        this.logPurgeCron = effectiveLogPurgeCronFromEnv();
        this._mountSchedulers();
        this._mountLogPurgeScheduler();
    }

    _getLogs() {
        return this.caller.flatMap((caller) => caller.logs());
    }

    getFlatLogs() {
        return this._getLogs();
    }

    getLogs() {
        const logs = this._getLogs();
        const groupedLogs = logs.reduce((acc, log) => {
            acc[log.name] = [...(acc[log.name] || []), log];
            return acc;
        }, {});

        Object.keys(groupedLogs).forEach((name) => {
            groupedLogs[name].sort((a, b) => a.timestamp - b.timestamp);
        });

        return groupedLogs;
    }

    getCallerInformations() {
        return this.caller.map((c) => c.getInfo());
    }
}

module.exports = HQ;
module.exports.DEFAULT_LOG_PURGE_CRON = DEFAULT_LOG_PURGE_CRON;
module.exports.coerceLogPurgeCron = coerceLogPurgeCron;
module.exports.effectiveLogPurgeCronFromEnv = effectiveLogPurgeCronFromEnv;
