const fs = require("fs/promises");
const path = require("path");

const SETTINGS_PATH = path.join(__dirname, "settings.json");

function validateSettingsArray(settings) {
    if (!Array.isArray(settings)) {
        throw new Error("SETTINGS must be a JSON array of job objects");
    }
    for (let i = 0; i < settings.length; i++) {
        const setting = settings[i];
        if (typeof setting !== "object" || setting === null) {
            throw new Error(`SETTINGS[${i}] must be an object`);
        }
        if (!setting.jobs || !setting.cron || !setting.method || !setting.url) {
            throw new Error(
                `SETTINGS[${i}] missing required fields: jobs, cron, method, url`
            );
        }
    }
}

/**
 * Accept legacy `{ jobs: [...] }` files; ignore extra keys (e.g. old logPurgeCron).
 * @param {unknown} parsed
 * @returns {object[]}
 */
function jobsOnlyFromParsed(parsed) {
    if (Array.isArray(parsed)) {
        validateSettingsArray(parsed);
        return parsed;
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.jobs)) {
        validateSettingsArray(parsed.jobs);
        return parsed.jobs;
    }
    throw new Error(
        "settings must be a JSON array of jobs or an object with a jobs array"
    );
}

async function loadInitialSettings() {
    const envStr = process?.env?.SETTINGS;
    if (envStr && typeof envStr === "string" && envStr.trim()) {
        try {
            const parsed = JSON.parse(envStr.trim());
            const jobs = jobsOnlyFromParsed(parsed);
            if (jobs.length === 0) {
                console.warn(
                    "SETTINGS env has empty jobs; loading settings.json instead"
                );
            } else {
                console.log("Using settings from environment (SETTINGS)");
                return jobs;
            }
        } catch (e) {
            console.error(e.message || String(e));
            console.warn("Falling back to settings.json");
        }
    }

    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return jobsOnlyFromParsed(parsed);
}

async function saveSettings(settings) {
    validateSettingsArray(settings);
    const text = `${JSON.stringify(settings, null, 2)}\n`;
    await fs.writeFile(SETTINGS_PATH, text, "utf8");
}

module.exports = {
    SETTINGS_PATH,
    validateSettingsArray,
    jobsOnlyFromParsed,
    loadInitialSettings,
    saveSettings,
};
