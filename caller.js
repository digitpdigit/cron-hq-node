const { v4: uuidv4 } = require('uuid');

class Caller {
    constructor(url, method, body, headers, name, cron, debug) {
        console.log("================================================")
        console.log("Creating caller");
        console.log("URL: ", url);
        console.log("Method: ", method);
        console.log("Body: ", body);
        console.log("Headers: ", headers);
        console.log("Name: ", name);
        console.log("Cron: ", cron);
        console.log("Debug mode: ", debug);
        console.log("================================================")

        this.url = url;
        this.method = method;
        this.body = body;
        this.headers = headers;

        // * Logging purposes
        this.name = name;
        this.cron = cron;
        this.logEntries = [];
        this.debug = debug;

        this._debug("Caller created");
        this._debug("URL", this.url);
        this._debug("Method", this.method);
        this._debug("Body", this.body);
        this._debug("Headers", this.headers);
        this._debug("Name", this.name);
        this._debug("Debug mode", this.debug);
        this._debug("================================================")
    }

    _debug(...args) {
        if (this.debug) {
            console.log(...args);
        }
    }

    _createLog({
        tag, 
        message,
        id,
        data = {},
        status,
        error = null,
        url,
    }) {
        this._debug("================================================")
        this._debug("Creating log");
        this._debug("Tag: ", tag);
        this._debug("Message: ", message);
        this._debug("ID: ", id);
        this._debug("Data: ", data);
        this._debug("Status: ", status);
        this._debug("Error: ", error);
        this._debug("================================================")

        this.logEntries.push({
            name: this.name,
            id,
            timestamp: new Date(),
            tag,
            data,
            message,
            status,
            error,
            url: this.url,
        });
    }

    async call() {
        this._debug("================================================")
        this._debug("Name", this.name);
        this._debug("Calling URL", this.url);
        this._debug("================================================")

        const id = uuidv4();
        try {
            const params = {
                method: this.method,
                body: this.body ? JSON.stringify(this.body) : undefined,
                headers: this.headers
            }

            if (this.method === "GET" || this.method === "DELETE") {
                delete params.body;
            }

            fetch(this.url, params)
            .then(response => {
                this._createLog({
                    id,
                    tag: "CALL",
                    message: "Success: URL called successfully",
                    data: response.body,
                    status: "success"
                });
            }).catch(error => {
                this._createLog({
                    id,
                    tag: "CALL",
                    message: "Error: URL not called",
                    error: error.message,
                    status: "error"
                });
            });

            this._createLog({
                id,
                tag: "CALL",
                message: "Initiate: Calling URL",
                data: this.url,
                status: "success"
            });
            
        } catch (error) {
            this._debug("Error: ", error.message);
            this._createLog({
                id,
                tag: "CALL",
                message: "SERVER ERROR: Failed to call URL",
                error: error.message,
                status: "error"
            });
        }
    }

    logs() {
        return this.logEntries;
    }

    clearLogs() {
        this.logEntries.length = 0;
    }

    getInfo() {
        return {
            url: this.url,
            method: this.method,
            body: this.body,
            headers: this.headers,
            name: this.name,
            cron: this.cron,
        };
    }
}

module.exports = Caller;