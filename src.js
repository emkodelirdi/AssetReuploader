"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const FormData = require("form-data");
const { https } = require("follow-redirects");
const zlib = require("zlib");
const fetch = require("node-fetch");

const exeDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const outputDir = path.join(exeDir, "output");

const jobs = {};


function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


async function downloadAssetLegacy(assetId, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`[downloadAssetLegacy] assetId=${assetId} -> ${outputPath}`);
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
        const fileStream = fs.createWriteStream(outputPath);

        https.get(url, (res) => {
            console.log(`[downloadAssetLegacy] Response status for assetId ${assetId}: ${res.statusCode}`);
            if (res.statusCode !== 200) {
                fileStream.close();
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
                return reject(new Error(`Download failed (status ${res.statusCode}) for assetId ${assetId}`));
            }

            let stream = res;
            const encoding = res.headers["content-encoding"];
            if (encoding === "gzip") {
                console.log("[downloadAssetLegacy] Content-Encoding: gzip -> zlib Gunzip");
                stream = res.pipe(zlib.createGunzip());
            } else if (encoding === "deflate") {
                console.log("[downloadAssetLegacy] Content-Encoding: deflate -> zlib Inflate");
                stream = res.pipe(zlib.createInflate());
            }

            stream.pipe(fileStream);
            fileStream.on("finish", () => {
                fileStream.close(() => {
                    console.log(`[downloadAssetLegacy] Finished writing file: ${outputPath}`);
                    resolve();
                });
            });
        }).on("error", (err) => {
            fileStream.close();
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
            reject(err);
        });
    });
}

/**
 * Poll the Open Cloud operation until done=true, returning the final assetId.
 */
async function pollOperationUntilDone(operationId, apiKey) {
    const baseUrl = "https://apis.roblox.com/assets/v1/operations/";
    while (true) {
        const resp = await fetch(baseUrl + operationId, {
            method: "GET",
            headers: { "x-api-key": apiKey }
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new Error(`Operation poll failed (status ${resp.status}): ${body}`);
        }

        const data = await resp.json();
        if (data.done === true) {
            const finalAssetId = data.assetId || data.response?.assetId;
            if (!finalAssetId) {
                throw new Error(`Operation done but no assetId. Full data: ${JSON.stringify(data)}`);
            }
            return finalAssetId;
        }
        await sleep(2000);
    }
}


// Create image

async function createImageAsset(filePath, creatorID, isGroup, apiKey, oldAssetId) {
    const creationContext = isGroup
        ? { creator: { groupId: parseInt(creatorID, 10) } }
        : { creator: { userId: parseInt(creatorID, 10) } };

    const form = new FormData();
    form.append("request", JSON.stringify({
        assetType: "Image",
        displayName: path.basename(filePath),
        description: `Reuploaded from rbxassetid://${oldAssetId}`,
        creationContext
    }));
    form.append("fileContent", fs.createReadStream(filePath), {
        contentType: "image/png"
    });

    const response = await fetch("https://apis.roblox.com/assets/v1/assets", {
        method: "POST",
        headers: { "x-api-key": apiKey },
        body: form
    });

    if (response.status === 201) {
        // synchronous success
        const data = await response.json();
        if (!data.assetId) {
            throw new Error(`Response missing assetId. Full data: ${JSON.stringify(data)}`);
        }
        // If there's moderation info in data.moderationResult or data.response.moderationResult:
        const rawModeration = data.moderationResult || data.response?.moderationResult;
        return { newAssetId: data.assetId, rawModeration };
    }

    if (response.status === 200) {
        // async => poll
        const opData = await response.json();
        if (!opData.operationId) {
            throw new Error(`Got 200 but no operationId. Full data: ${JSON.stringify(opData)}`);
        }
        const finalAssetId = await pollOperationUntilDone(opData.operationId, apiKey);

        return { newAssetId: finalAssetId, rawModeration: null };
    }

    const errorText = await response.text().catch(() => "");
    throw new Error(`Open Cloud upload failed (status ${response.status}): ${errorText}`);
}


async function getAssetModeration(assetId, apiKey) {
    const url = `https://apis.roblox.com/assets/v1/assets/${assetId}?readMask=moderationResult`;
    const resp = await fetch(url, {
        method: "GET",
        headers: { "x-api-key": apiKey }
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`GET moderation failed (status ${resp.status}): ${body}`);
    }

    const data = await resp.json();
    return data.moderationResult || null;
}

/**
 * The main job pipeline:
 *   1) Clear outputDir
 *   2) Download assets in 60-chunk
 *   3) Wait 60s
 *   4) Upload assets in 60-chunk
 *       - after each chunk, we check moderation for each new asset in that chunk
 *   5) Done
 *
 * We'll store:
 *   jobInfo.results => array of { oldId, newId } for approved
 *   jobInfo.moderated => array of { oldId, newId, state } for moderated
 *   jobInfo.failures => errors
 */

function prepareOutputDir(outputDir) {
    // We'll attempt up to 5 times, with 200ms sleeps in between.
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            if (fs.existsSync(outputDir)) {
                console.log(`[prepareOutputDir] Removing existing folder: ${outputDir}`);
                fs.rmSync(outputDir, { recursive: true, force: true });
            }
            fs.mkdirSync(outputDir);
            console.log(`[prepareOutputDir] Created folder: ${outputDir}`);
            return; // success, break out
        } catch (err) {
            console.warn(
                `[prepareOutputDir] Attempt ${attempt} failed to create folder: ${err.message}`
            );
            // If not the last attempt, wait a bit before retrying
            if (attempt < 5) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); 
                // or use a Promise-based sleep
            } else {
                console.error("[prepareOutputDir] Gave up trying to create output folder.");
            }
        }
    }
}

async function runJob(jobId, assetIDs, creatorID, isGroup, apiKey) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }

    try {
        console.log(`[runJob] Starting job ${jobId} with ${assetIDs.length} assets.`);

        // 1) Clear and recreate outputDir with retries
        prepareOutputDir(outputDir);

        // Setup tracking arrays
        jobInfo.failures = [];
        jobInfo.moderated = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        // 2) Download in 60-chunk
        const downloaded = [];
        let downloadedCount = 0;

        for (let i = 0; i < assetIDs.length; i += 60) {
            const slice = assetIDs.slice(i, i + 60);
            for (const rbxAssetIdStr of slice) {
                downloadedCount++;

                // parse numeric ID
                const match = rbxAssetIdStr.match(/\d+/);
                if (!match) {
                    jobInfo.failures.push({
                        assetId: rbxAssetIdStr,
                        stage: "download",
                        error: "Could not parse numeric ID"
                    });
                    jobInfo.done = downloadedCount;
                    jobInfo.message = `Download parse fail: ${rbxAssetIdStr}`;
                    continue;
                }

                const numericId = match[0];
                const fileName = `asset_${numericId}.png`;
                const filePath = path.join(outputDir, fileName);

                // Attempt download
                try {
                    await downloadAssetLegacy(numericId, filePath);
                    downloaded.push({ fileName, oldId: rbxAssetIdStr });
                    jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
                } catch (err) {
                    console.error(`[runJob] Download error for ${rbxAssetIdStr}:`, err);
                    jobInfo.failures.push({
                        assetId: rbxAssetIdStr,
                        stage: "download",
                        error: err.message
                    });
                    jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
                }

                jobInfo.done = downloadedCount;
            }

            // If more remain, wait 60s
            if (i + 60 < assetIDs.length) {
                jobInfo.message = "Waiting...";
                console.log(`[runJob] Download batch done (up to index ${i+60}). Sleeping 60s...`);
                await sleep(60_000);
            }
        }

        // 3) Reset jobInfo.done for uploading
        jobInfo.done = 0;
        const totalToUpload = downloaded.length;
        let uploadedCount = 0;
        jobInfo.message = "Starting uploads...";

        // 4) Upload in 60-chunk, then check moderation
        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);

            // Step 4.1: Create assets
            const newlyCreated = [];
            for (const item of slice) {
                uploadedCount++;
                const filePath = path.join(outputDir, item.fileName);

                // Attempt creation
                let newAssetId = null;
                let rawModeration = null;
                try {
                    jobInfo.message = `${uploadedCount}/${totalToUpload} uploading...`;
                    const result = await createImageAsset(filePath, creatorID, isGroup, apiKey, item.oldId);
                    newAssetId = result.newAssetId;
                    rawModeration = result.rawModeration; 
                } catch (err) {
                    console.error(`[runJob] Upload error for ${item.oldId}:`, err);
                
                    // If it includes "status 401" and "Invalid API Key", warn
                    if (err.message.includes("status 401") && err.message.includes("Invalid API Key")) {
                        jobInfo.warnApiKey = true;
                    }
                
                    jobInfo.failures.push({
                        assetId: item.oldId,
                        stage: "upload",
                        error: err.message
                    });
                    jobInfo.message = `Upload failed: ${item.oldId}`;
                    jobInfo.done = uploadedCount;
                    continue;
                }

                // If we have a newAssetId, store in newlyCreated for moderation check
                newlyCreated.push({
                    oldId: item.oldId,
                    newId: newAssetId,
                    rawModeration
                });

                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${totalToUpload} uploaded`;
            }

            // Step 4.2: Check moderation for each new asset (in 60-chunk)
            let moderationCount = 0;
            for (let mIndex = 0; mIndex < newlyCreated.length; mIndex++) {
                const entry = newlyCreated[mIndex];

                // Check if we already have "Approved"/"Rejected" from rawModeration
                let moderationState = null;
                if (entry.rawModeration && entry.rawModeration.moderationState) {
                    moderationState = entry.rawModeration.moderationState;
                } else {
                    // If not provided, do a separate GET
                    try {
                        moderationCount++;
                        const modData = await getAssetModeration(entry.newId, apiKey);
                        moderationState = modData?.moderationState; // e.g. "Approved", "Rejected", etc.

                        // If we've done 60 checks, wait 60s
                        if (moderationCount % 60 === 0 && mIndex + 1 < newlyCreated.length) {
                            jobInfo.message = "Waiting...";
                            console.log("[runJob] Moderation check batch 60 done, sleeping 60s...");
                            await sleep(60_000);
                        }
                    } catch (err) {
                        console.error(`[runJob] Moderation GET error for asset ${entry.newId}:`, err);
                        jobInfo.failures.push({
                            assetId: entry.oldId,
                            stage: "moderationCheck",
                            error: err.message
                        });
                        moderationState = "Unknown";
                    }
                }

                // If "Approved", store in results
                // else put in "moderated"
                if (moderationState === "Approved") {
                    jobInfo.results.push({
                        oldId: entry.oldId,
                        newId: `rbxassetid://${entry.newId}`
                    });
                } else {
                    jobInfo.moderated.push({
                        oldId: entry.oldId,
                        newId: `rbxassetid://${entry.newId}`,
                        state: moderationState || "NoInfo"
                    });
                }
            }

            // After finishing this batch, wait 60s if more remain
            if (i + 60 < downloaded.length) {
                jobInfo.message = "Waiting...";
                console.log("[runJob] Upload+moderation batch done. Sleeping 60s...");
                await sleep(60_000);
            }
        }

        // 5) Done
        let finalMsg = `${jobInfo.results.length} assets have been reuploaded and replaced.`;
        if (jobInfo.warnApiKey) {
            finalMsg = `Some or all assets failed. The API Key may be invalid.`
        }
        jobInfo.message = finalMsg;

        jobInfo.finished = true;
        console.log(`[runJob] Job ${jobId} complete. 
          Approved: ${jobInfo.results.length}, 
          Moderated: ${jobInfo.moderated.length}, 
          Failures: ${jobInfo.failures.length}`);

    } catch (err) {
        console.error(`[runJob] Fatal error in job ${jobId}:`, err);
        jobInfo.message = `Fatal error: ${err.message}`;
        jobInfo.finished = true;
    }
}

/**
 * Handle POST /upload
 */
function handleUpload(req, res, body) {
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (err) {
        console.error("[handleUpload] JSON parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    }

    const { assetIDs, creatorID, isGroup, apiKey } = payload || {};
    console.log("[handleUpload] Received payload:", {
        assetIDs,
        creatorID,
        isGroup,
        apiKeyLength: apiKey?.length,
    });

    if (!Array.isArray(assetIDs) || !creatorID || !apiKey) {
        console.error("[handleUpload] Missing required fields.");
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Missing required fields (assetIDs, creatorID, apiKey)"
        }));
    }

    const jobId = randomUUID();
    jobs[jobId] = {
        total: assetIDs.length,
        done: 0,
        finished: false,
        results: [],    // assets that ended up "Approved"
        moderated: [],  // assets that are "Rejected" or "Unknown"
        failures: [],   // download / upload / network errors
        warnApiKey: false,
        message: "Starting reupload job..."
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobId }));

    runJob(jobId, assetIDs, creatorID, !!isGroup, apiKey).catch((err) => {
        console.error(`[handleUpload] Fatal job error:`, err);
        jobs[jobId].message = `Fatal: ${err.message}`;
        jobs[jobId].finished = true;
    });
}


function handleModerated(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }

    const offset = parseInt(params.get("offset") || "0", 10);
    const count = parseInt(params.get("count") || "50", 10);

    const jobInfo = jobs[jobId];
    if (!jobInfo.finished) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Job not finished yet. Wait for 'finished' == true."
        }));
    }

    // We return the "moderated" array in chunks
    const moderated = jobInfo.moderated || [];
    const slice = moderated.slice(offset, offset + count);
    const hasMore = (offset + count) < moderated.length;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        data: slice,
        offset,
        count,
        total: moderated.length,
        hasMore
    }));
}


/**
 * GET /progress?jobId=...
 */
function handleProgress(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }

    const jobInfo = jobs[jobId];
    const chunkSize = 50; // or your preference

    const response = {
        total: jobInfo.total,
        done: jobInfo.done,
        message: jobInfo.message,
        finished: jobInfo.finished,
        resultsCount: null,
        moderatedCount: null,
        failuresCount: null,
        chunkSize
    };

    if (jobInfo.finished) {
        response.resultsCount = jobInfo.results.length;
        response.moderatedCount = jobInfo.moderated.length;
        response.failuresCount = jobInfo.failures.length;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
}

/**
 * GET /chunks?jobId=...&offset=...&count=...
 * Returns slices from jobInfo.results (Approved only).
 */
function handleChunks(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }

    const offset = parseInt(params.get("offset") || "0", 10);
    const count = parseInt(params.get("count") || "50", 10);

    const jobInfo = jobs[jobId];
    if (!jobInfo.finished) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Job not finished yet. Wait for 'finished' == true."
        }));
    }

    const results = jobInfo.results; // only the approved
    const slice = results.slice(offset, offset + count);
    const hasMore = (offset + count) < results.length;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
        data: slice,
        offset,
        count,
        total: results.length,
        hasMore
    }));
}


// Create server
const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "POST" && urlObj.pathname === "/upload") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            console.log("[server] Received POST /upload");
            handleUpload(req, res, body);
        });
    } else if (req.method === "GET" && urlObj.pathname === "/progress") {
        handleProgress(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/chunks") {
        handleChunks(req, res, urlObj);
    } else if (req.method === "GET" && urlObj.pathname === "/moderated") {
        handleModerated(req, res, urlObj);
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
});

server.listen(3000, () => {
    console.log("[server] Listening on http://localhost:3000");
});
