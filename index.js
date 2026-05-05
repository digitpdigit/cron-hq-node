/**
 * Package to automatically run jobs based on cron schedule
 */

require("dotenv").config({ debug: false });
const { loadInitialSettings } = require("./settingsStore");
const { createApp } = require("./server");
const HQ = require("./hq");

(async function main() {
    const settings = await loadInitialSettings();
    const debugMode = process?.env?.DEBUG === "true";
    console.log("Debug mode", debugMode);

    const hq = new HQ({
        settings,
        debug: debugMode,
    });
    hq.initialize();

    const app = createApp(hq);
    const PORT = Number(process.env.PORT) || 3040;
    app.listen(PORT, () => {
        console.log(`cron-hq listening on http://localhost:${PORT}`);
        console.log(
            `Probe: http://localhost:${PORT}/api — should return JSON (not 404).`
        );
    });
})();
