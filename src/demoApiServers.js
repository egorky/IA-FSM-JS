// src/demoApiServers.js
const express = require('express');
const http = require('http');
const logger = require('./logger');
const { getAllApiConfigs: getOriginalAllApiConfigs, getApiConfigById } = require('./apiConfigLoader'); // To get API details
const { DEMO_MODE } = require('./configConstants');

const DEMO_API_BASE_PORT = parseInt(process.env.DEMO_API_BASE_PORT, 10) || 7080;
let activeServers = []; // To keep track of servers for shutdown
let portCounter = 0;

// This function will be adapted from apiCallerService or made shared
// For now, a simplified version
function generateDemoDataForEndpoint(apiId, apiConfig, reqParams, reqBody, reqQuery) {
    logger.debug({ apiId, reqParams, reqBody, reqQuery }, "DEMO_SERVER: Generating data for endpoint.");

    let mockData = {
        message: `Demo response for ${apiId}`,
        echo_params: reqParams,
        echo_body: reqBody,
        echo_query: reqQuery,
        timestamp: new Date().toISOString(),
        isDemoServerResponse: true
    };

    // Reuse logic from apiCallerService or make it more robust here
    // For now, basic examples:
    if (apiId === 'api_generate_token' || apiId === 'api_generate_system_token') {
        return {
            access_token: 'DEMO_SERVER_ACCESS_TOKEN_XYZ_789',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'read write demo_server_scope'
        };
    } else if (apiId === 'api_get_full_user') {
        const idNumber = reqParams.idNumber || 'N/A';
        return {
            personal_info: {
                full_name: `Demo Server User ${idNumber}`,
                age: 35,
            },
            contact: {
                email_address: `demo_server_${idNumber}@example.com`,
            },
            id_document_number: idNumber
        };
    } else if (apiId === 'api_get_city_id') {
        const cityName = reqQuery.city_name_query || 'UnknownCity';
        return {
            id: `ds_city_id_${cityName.toLowerCase()}`,
            name: cityName,
            country_code: reqQuery.country_code || 'DS_CC',
            availableCitiesMap: { "Guayaquil": "DS_GYE", "Quito": "DS_UIO" }
        };
    }
    // Add more specific mocks as needed based on apiConfig.producesParameters

    if (apiConfig && apiConfig.producesParameters) {
        const producedMock = {};
        for (const paramName in apiConfig.producesParameters) {
            if (paramName.toLowerCase().includes('name')) producedMock[paramName] = `DemoServer User`;
            else if (paramName.toLowerCase().includes('id')) producedMock[paramName] = `ds-${paramName}-${Math.floor(Math.random() * 1000)}`;
            else producedMock[paramName] = `DemoServer value for ${paramName}`;
        }
        mockData = { ...mockData, ...producedMock };
    }
    return mockData;
}


function startDemoServers(callback) {
    if (!DEMO_MODE) {
        logger.info("DEMO_MODE is not active. Demo API servers will not be started.");
        if(callback) callback();
        return;
    }

    const allApiConfigs = getOriginalAllApiConfigs();
    if (!allApiConfigs || Object.keys(allApiConfigs).length === 0) {
        logger.warn("No API configurations found. Cannot start demo servers.");
        if(callback) callback();
        return;
    }

    const apps = {}; // port -> app instance

    logger.info("DEMO_MODE: Starting demo API servers...");

    for (const apiId in allApiConfigs) {
        const apiConfig = allApiConfigs[apiId];
        if (!apiConfig.url_template) {
            logger.warn({ apiId }, "DEMO_SERVER: API config missing url_template. Skipping demo server setup for this API.");
            continue;
        }

        // Determine port and path
        // This is a simple parser, might need to be more robust for complex URLs
        let port = DEMO_API_BASE_PORT + portCounter; // Assign ports sequentially for simplicity
        let apiPath;
        try {
            const urlObject = new URL(apiConfig.url_template.startsWith('http') ? apiConfig.url_template : `http://dummybase${apiConfig.url_template}`);
            const pathSegments = urlObject.pathname.split('/');

            // Heuristic: if the first segment looks like a port number or a common service name that might be part of a base URL in real configs
            // we try to assign a unique port. Otherwise, group by a common port.
            // This needs refinement based on actual url_template structures.
            // For now, let's try to use one port per "domain" found in url_template if it looks like a placeholder.
            // Or, more simply, one port for all demo servers initially.

            // Simplified: Using one base port and incrementing for now to avoid clashes if many APIs are defined.
            // A better approach would be to parse the host from url_template if it's a placeholder like {{api_host}}
            // and map those hosts to specific demo ports.
            // For now, let's use a single demo port for all, or a few distinct ones.
            // Let's use one main port for now for simplicity of setup for the user.
            port = DEMO_API_BASE_PORT; // Using a single port for all demo APIs

            apiPath = urlObject.pathname;
            // Replace template placeholders in path like /users/{{params.userId}} with Express-style /users/:userId
            apiPath = apiPath.replace(/\{\{params\.(\w+)\}\}/g, ':$1').replace(/\{\{(\w+)\}\}/g, ':$1');

        } catch (e) {
            logger.error({ apiId, url_template: apiConfig.url_template, err: e }, "DEMO_SERVER: Could not parse url_template to determine path and port. Skipping.");
            continue;
        }

        if (!apps[port]) {
            apps[port] = express();
            apps[port].use(express.json());
            apps[port].use(express.urlencoded({ extended: true }));
            portCounter++; // Only increment if we were to use different ports. Not used if single port.
        }
        const app = apps[port];
        const method = apiConfig.method ? apiConfig.method.toLowerCase() : 'get';

        logger.info(`DEMO_SERVER: Setting up ${method.toUpperCase()} ${apiPath} for ${apiId} on port ${port}`);

        app[method](apiPath, (req, res) => {
            logger.info({
                demoApiId: apiId,
                method: req.method,
                path: req.originalUrl,
                params: req.params,
                query: req.query,
                body: req.body,
                headers: req.headers
            }, "DEMO_SERVER: Request received.");

            // Simplified Auth Check
            if (apiConfig.authentication && apiConfig.authentication.authProfileId) {
                const expectedAuthHeader = apiConfig.authentication.tokenPlacement?.name || 'authorization';
                const expectedScheme = (apiConfig.authentication.tokenPlacement?.scheme || 'Bearer') + ' ';
                const tokenValue = req.headers[expectedAuthHeader.toLowerCase()];

                if (!tokenValue || !tokenValue.startsWith(expectedScheme + 'DEMO_')) { // Check for demo token
                    logger.warn({ apiId, headers: req.headers }, "DEMO_SERVER: Auth check failed (missing or invalid demo token).");
                    return res.status(401).json({ error: "Demo Authentication Failed", message: "Valid demo token required." });
                }
                logger.info({apiId}, "DEMO_SERVER: Demo authentication successful.");
            }

            const responseData = generateDemoDataForEndpoint(apiId, apiConfig, req.params, req.body, req.query);

            // For ASYNC APIs in DEMO_MODE, the demo server itself should push to Redis stream
            // We need to identify if the original API was meant to be async.
            // We don't have direct access to the 'executionMode' from states.json here.
            // Assumption: if response_stream_key_template exists, it's an async API.
            if (apiConfig.response_stream_key_template) {
                const sessionId = req.headers['x-session-id'] || req.query.sessionId || 'unknown_session_demo';
                const correlationId = req.headers['x-correlation-id'] || req.query.correlationId || uuidv4();

                const streamTemplateContext = { sessionId, correlationId, apiId, ...req.query, ...req.params };
                const responseStreamKey = processTemplate(apiConfig.response_stream_key_template, streamTemplateContext);

                const streamPayload = {
                    correlationId,
                    sessionId,
                    apiId,
                    status: 'success', // Assuming demo server always succeeds for now
                    httpCode: 200,
                    data: responseData,
                    isDemoServerStream: true,
                    timestamp: new Date().toISOString()
                };
                const messageFields = [];
                for (const key in streamPayload) {
                    messageFields.push(key, JSON.stringify(streamPayload[key]));
                }
                const streamMaxLen = parseInt(process.env.SIMULATOR_STREAM_MAXLEN, 10) || 1000;
                const xaddArgs = [responseStreamKey, 'MAXLEN', '~', streamMaxLen.toString(), '*', ...messageFields];

                // Use redisClient from the main app context
                require('./redisClient').getClient().call('XADD', ...xaddArgs)
                    .then(messageId => logger.info({ responseStreamKey, messageId, demoApiId: apiId }, 'DEMO_SERVER: Successfully added simulated ASYNC API response to Redis Stream.'))
                    .catch(err => logger.error({ err, responseStreamKey, demoApiId: apiId }, 'DEMO_SERVER: Error adding ASYNC message to Redis Stream.'));

                // For async, the HTTP response from the demo server itself is just an ack
                res.status(202).json({ message: "Accepted for async processing by demo server", apiId, correlationId });
            } else {
                // For SYNC APIs, respond directly
                res.status(200).json(responseData);
            }
        });
    }

    Object.keys(apps).forEach(portNumStr => {
        const portNum = parseInt(portNumStr, 10);
        const server = http.createServer(apps[portNum]);
        server.listen(portNum, () => {
            logger.info(`DEMO_SERVER: Express server for demo APIs listening on http://127.0.0.1:${portNum}`);
        }).on('error', (err) => {
            logger.error({ err, portNum }, `DEMO_SERVER: Failed to start server on port ${portNum}. It might be in use.`);
        });
        activeServers.push(server);
    });
    if(callback) setTimeout(callback, 100); // Give servers a moment to start
}

function stopDemoServers(callback) {
    logger.info('DEMO_SERVER: Stopping demo API servers...');
    let stoppedCount = 0;
    const totalServers = activeServers.length;

    if (totalServers === 0) {
        if (callback) callback();
        return;
    }

    activeServers.forEach(server => {
        server.close(() => {
            stoppedCount++;
            logger.info(`DEMO_SERVER: Server on port ${server.address()?.port} stopped.`);
            if (stoppedCount === totalServers) {
                logger.info('DEMO_SERVER: All demo API servers stopped.');
                activeServers = [];
                if (callback) callback();
            }
        });
    });
     // Force close after timeout if needed
    setTimeout(() => {
        if (stoppedCount < totalServers) {
            logger.warn("DEMO_SERVER: Some demo servers did not stop gracefully, forcing shutdown.");
            activeServers.forEach(s => { if (s.listening) s.closeIdle(); }); // Attempt to force close remaining
            if (callback) callback();
        }
    }, 2000);
}

module.exports = { startDemoServers, stopDemoServers };
