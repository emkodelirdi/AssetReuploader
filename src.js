"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const FormData = require("form-data");
const { https } = require("follow-redirects");
const zlib = require("zlib");
const fetch = require("node-fetch");
const { execFileSync } = require("child_process");


const exeDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const outputDir = path.join(exeDir, "output");
const jobs = {};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// If user didn't supply a cookie for animations, call rbx_cookie.exe
function getCookieFromRustCLI() {
    const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
    const cookieExePath = path.join(baseDir, "rbx_cookie.exe");

    try {
        const token = execFileSync(cookieExePath, ["--format", "value"], {
            encoding: "utf8"
        }).trim();

        console.log("[rbx_cookie.exe] Found .ROBLOSECURITY token via Rust CLI.");
        return `.ROBLOSECURITY=${token};`;
    } catch (err) {
        console.error("[rbx_cookie.exe] Failed to find a cookie:", err.message);
        return null;
    }
}

const ANIMATION_UPLOAD_URL = "https://www.roblox.com/ide/publish/uploadnewanimation";

async function getCsrfToken(cookie) {
    const res = await fetch(ANIMATION_UPLOAD_URL, {
        method: "POST",
        headers: {
            "Cookie": cookie,
            "Content-Type": "application/xml",
            "Requester": "Client"
        },
        body: ""
    });
    const csrfToken = res.headers.get("x-csrf-token");
    if (!csrfToken) {
        throw new Error("Failed to retrieve x-csrf-token from uploadnewanimation");
    }
    return csrfToken;
}

async function uploadAnimationWithRetries(
    rawXmlBuffer,
    displayName,
    description,
    cookie,
    csrfToken,
    creatorID,
    isGroup,
    maxRetries = 10,
    retryDelayMs = 5000
) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await actuallyUploadAnimation(
                rawXmlBuffer,
                displayName,
                description,
                cookie,
                csrfToken,
                creatorID,
                isGroup
            );
        } catch (err) {
            attempt++;
            if (attempt >= maxRetries) {
                throw err;
            }
            console.warn(
                `[uploadAnimationWithRetries] Attempt ${attempt} failed: ${err.message}. Retrying in 5s...`
            );
            await sleep(retryDelayMs);
        }
    }
}

async function actuallyUploadAnimation(
    rawXmlBuffer,
    displayName,
    description,
    cookie,
    csrfToken,
    creatorID,
    isGroup
) {
    const url = new URL(ANIMATION_UPLOAD_URL);
    url.searchParams.set("name", displayName);
    url.searchParams.set("description", description);
    url.searchParams.set("isGamesAsset", "false");
    if (isGroup) url.searchParams.set("groupId", creatorID);
    else url.searchParams.set("userId", creatorID);
    url.searchParams.set("ispublic", "false");
    url.searchParams.set("assetTypeName", "animation");
    url.searchParams.set("AllID", "1");
    url.searchParams.set("allowComments", "false");

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Cookie": cookie,
            "x-csrf-token": csrfToken,
            "Content-Type": "application/xml",
            "User-Agent": "RobloxStudio/WinInet RobloxApp/0.483.1.425021 (GlobalDist; RobloxDirectDownload)",
            "Requester": "Client"
        },
        body: rawXmlBuffer
    });

    if (!resp.ok) {
        throw new Error(`Animation upload failed (status ${resp.status}): ${await resp.text()}`);
    }
    const text = (await resp.text()).trim();
    const assetId = parseInt(text, 10);
    if (isNaN(assetId)) {
        throw new Error(`Animation upload returned invalid assetId: ${text}`);
    }
    return assetId;
}


// Basic download function
async function downloadAssetLegacy(assetId, outputPath) {
    return new Promise((resolve, reject) => {
        console.log(`[downloadAssetLegacy] assetId=${assetId} -> ${outputPath}`);
        const url = `https://assetdelivery.roblox.com/v1/asset/?id=${assetId}`;
        const fileStream = fs.createWriteStream(outputPath);

        https.get(url, (res) => {
            console.log(`[downloadAssetLegacy] Response for assetId ${assetId}: ${res.statusCode}`);
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


async function downloadAssetLegacyWithRetries(assetId, outputPath) {
    const maxRetries = 10;
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await downloadAssetLegacy(assetId, outputPath);
            // success => we're done
            return;
        } catch (err) {
            attempt++;
            // If the error message indicates 429 or "Too Many Requests," we retry
            if (err.message.includes("429") || err.message.toLowerCase().includes("rate limit")) {
                console.warn(`[downloadAssetLegacyWithRetries] 429 or rate-limit for asset ${assetId}, attempt ${attempt}`);
                if (attempt < maxRetries) {
                    // wait 1s before next attempt
                    await sleep(1000);
                } else {
                    // final failure
                    throw err;
                }
            } else {
                // Some other error => fail out immediately
                throw err;
            }
        } finally {
            // Always limit the overall rate to about 5/s
            await sleep(200);
        }
    }
}

// Poll operation for async Open Cloud
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
        const data = await response.json();
        if (!data.assetId) {
            throw new Error(`Response missing assetId. Full data: ${JSON.stringify(data)}`);
        }
        const rawModeration = data.moderationResult || data.response?.moderationResult;
        return { newAssetId: data.assetId, rawModeration };
    }
    if (response.status === 200) {
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

// Prepare output folder
function prepareOutputDir(dir) {
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            if (fs.existsSync(dir)) {
                console.log(`[prepareOutputDir] Removing existing folder: ${dir}`);
                fs.rmSync(dir, { recursive: true, force: true });
            }
            fs.mkdirSync(dir);
            console.log(`[prepareOutputDir] Created folder: ${dir}`);
            return;
        } catch (err) {
            console.warn(`[prepareOutputDir] Attempt ${attempt} failed: ${err.message}`);
            if (attempt < 5) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            } else {
                console.error("[prepareOutputDir] Gave up trying to create output folder.");
            }
        }
    }
}


async function runJobImages(jobId, assetIDs, creatorID, isGroup, apiKey) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }

    try {
        console.log(`[runJobImages] Starting job ${jobId} with ${assetIDs.length} assets.`);

        // 1) Clear and recreate outputDir with retries
        prepareOutputDir(outputDir);

        // Setup tracking arrays
        jobInfo.failures = [];
        jobInfo.moderated = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        // 2) Download each asset with 5/s + 429-retry
        const downloaded = [];
        let downloadedCount = 0;

        for (const rbxAssetIdStr of assetIDs) {
            downloadedCount++;

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

            try {
                await downloadAssetLegacyWithRetries(numericId, filePath);
                downloaded.push({ fileName, oldId: rbxAssetIdStr });
                jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
            } catch (err) {
                console.error(`[runJobImages] Download error for ${rbxAssetIdStr}:`, err);
                jobInfo.failures.push({
                    assetId: rbxAssetIdStr,
                    stage: "download",
                    error: err.message
                });
                jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
            }

            jobInfo.done = downloadedCount;
        }

        jobInfo.done = 0;
        const totalToUpload = downloaded.length;
        let uploadedCount = 0;
        jobInfo.message = "Starting uploads...";

        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);

            // Step 4.1: Create assets
            const newlyCreated = [];
            for (const item of slice) {
                uploadedCount++;
                const filePath = path.join(outputDir, item.fileName);

                let newAssetId = null;
                let rawModeration = null;
                try {
                    jobInfo.message = `${uploadedCount}/${totalToUpload} uploading...`;
                    const result = await createImageAsset(
                        filePath,
                        creatorID,
                        isGroup,
                        apiKey,
                        item.oldId
                    );
                    newAssetId = result.newAssetId;
                    rawModeration = result.rawModeration;
                } catch (err) {
                    console.error(`[runJobImages] Upload error for ${item.oldId}:`, err);
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

                newlyCreated.push({
                    oldId: item.oldId,
                    newId: newAssetId,
                    rawModeration
                });

                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${totalToUpload} uploaded`;
            }

            // Step 4.2: Check moderation for each new asset in the 60-chunk
            let moderationCount = 0;
            for (let mIndex = 0; mIndex < newlyCreated.length; mIndex++) {
                const entry = newlyCreated[mIndex];
                let moderationState = null;

                if (entry.rawModeration && entry.rawModeration.moderationState) {
                    moderationState = entry.rawModeration.moderationState;
                } else {
                    try {
                        moderationCount++;
                        const modData = await getAssetModeration(entry.newId, apiKey);
                        moderationState = modData?.moderationState;

                        if (moderationCount % 60 === 0 && mIndex + 1 < newlyCreated.length) {
                            jobInfo.message = "Waiting...";
                            console.log("[runJobImages] Moderation check batch 60 done, sleeping 60s...");
                            await sleep(60_000);
                        }
                    } catch (err) {
                        console.error(`[runJobImages] Moderation GET error for asset ${entry.newId}:`, err);
                        jobInfo.failures.push({
                            assetId: entry.oldId,
                            stage: "moderationCheck",
                            error: err.message
                        });
                        moderationState = "Unknown";
                    }
                }

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
                console.log("[runJobImages] Upload+moderation batch done. Sleeping 60s...");
                await sleep(60_000);
            }
        }

        let finalMsg = `${jobInfo.results.length} assets have been reuploaded.`;
        if (jobInfo.warnApiKey) {
            finalMsg = `Some or all assets failed. The API Key may be invalid.`;
        }
        jobInfo.message = finalMsg;
        jobInfo.finished = true;

        console.log(`[runJobImages] Job ${jobId} complete.
          Approved: ${jobInfo.results.length},
          Moderated: ${jobInfo.moderated.length},
          Failures: ${jobInfo.failures.length}`);

    } catch (err) {
        console.error(`[runJobImages] Fatal error in job ${jobId}:`, err);
        jobInfo.message = `Fatal error: ${err.message}`;
        jobInfo.finished = true;
    }
}


async function runJobAnimations(jobId, assetIDs, creatorID, isGroup, apiKey, cookie) {
    const jobInfo = jobs[jobId];
    if (!jobInfo) {
        throw new Error(`No job info found for jobId ${jobId}`);
    }

    try {
        console.log(`[runJobAnimations] Starting job ${jobId} with ${assetIDs.length} animations.`);
        prepareOutputDir(outputDir);

        jobInfo.failures = [];
        jobInfo.moderated = [];
        jobInfo.results = [];
        jobInfo.total = assetIDs.length;
        jobInfo.done = 0;
        jobInfo.message = "Starting downloads...";

        if (!cookie) {
            console.log("[runJobAnimations] No cookie in JSON => calling rbx_cookie.exe...");
            const autoCookie = getCookieFromRustCLI();
            if (!autoCookie) {
                throw new Error("rbx_cookie.exe did not find a .ROBLOSECURITY cookie!");
            }
            cookie = autoCookie;
            console.log(`[runJobAnimations] Retrieved cookie from Rust CLI: ${cookie}`);
        }

        // 1) Download in 60-chunks , each asset uses 5/s + 429 retry
        let downloadedCount = 0;
        const downloaded = [];

        for (let i = 0; i < assetIDs.length; i += 60) {
            const slice = assetIDs.slice(i, i + 60);

            for (const rbxAssetIdStr of slice) {
                downloadedCount++;
                const match = rbxAssetIdStr.match(/\d+/);
                if (!match) {
                    jobInfo.failures.push({
                        assetId: rbxAssetIdStr,
                        stage: "download",
                        error: "Not a numeric ID"
                    });
                    jobInfo.done = downloadedCount;
                    jobInfo.message = `Invalid ID: ${rbxAssetIdStr}`;
                    continue;
                }

                const numericId = match[0];
                const ext = ".xml";
                const fileName = `asset_${numericId}${ext}`;
                const filePath = path.join(outputDir, fileName);

                try {
                    await downloadAssetLegacyWithRetries(numericId, filePath);
                    downloaded.push({ fileName, oldId: rbxAssetIdStr });
                    jobInfo.message = `${downloadedCount}/${assetIDs.length} downloaded`;
                } catch (err) {
                    console.error(`[runJobAnimations] Download error for ${rbxAssetIdStr}:`, err);
                    jobInfo.failures.push({ assetId: rbxAssetIdStr, stage: "download", error: err.message });
                    jobInfo.message = `Download failed: ${rbxAssetIdStr}`;
                }
                jobInfo.done = downloadedCount;
            }
        }

        // 2) Upload in 60-chunks
        jobInfo.done = 0;
        jobInfo.message = "Starting animation uploads...";
        let uploadedCount = 0;
        const csrfToken = await getCsrfToken(cookie);

        for (let i = 0; i < downloaded.length; i += 60) {
            const slice = downloaded.slice(i, i + 60);

            for (const item of slice) {
                uploadedCount++;
                const filePath = path.join(outputDir, item.fileName);

                let newAssetId = null;
                try {
                    const buffer = fs.readFileSync(filePath);
                    jobInfo.message = `${uploadedCount}/${downloaded.length} uploading (animation)...`;
                    const desc = `Reuploaded from rbxassetid://${item.oldId}`;

                    newAssetId = await uploadAnimationWithRetries(
                        buffer,
                        path.basename(filePath),
                        desc,
                        cookie,
                        csrfToken,
                        creatorID,
                        isGroup,
                        5,
                        5000
                    );
                } catch (err) {
                    console.error(`[runJobAnimations] Upload error for ${item.oldId}:`, err);
                    jobInfo.failures.push({ assetId: item.oldId, stage: "upload", error: err.message });
                    jobInfo.message = `Upload failed: ${item.oldId}`;
                    jobInfo.done = uploadedCount;
                    continue;
                }

                // For animations, we skip moderation checks
                jobInfo.results.push({
                    oldId: item.oldId,
                    newId: `rbxassetid://${newAssetId}`
                });

                jobInfo.done = uploadedCount;
                jobInfo.message = `${uploadedCount}/${downloaded.length} uploaded (animation)`;
            }
            // no 60s wait in-between animation uploads
        }

        let msg = `${jobInfo.results.length} assets have been reuploaded.`;
        jobInfo.message = msg;
        jobInfo.finished = true;

        console.log(`[runJobAnimations] Job ${jobId} complete.
Animations reuploaded: ${jobInfo.results.length},
Failures: ${jobInfo.failures.length}`);

    } catch (err) {
        console.error(`[runJobAnimations] Fatal error in job ${jobId}:`, err);
        jobInfo.message = `Fatal: ${err.message}`;
        jobInfo.finished = true;
    }
}


function handleUpload(req, res, body) {
    let payload;
    try {
        payload = JSON.parse(body);
    } catch (err) {
        console.error("[handleUpload] JSON parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid JSON payload" }));
    }

    const { assetIDs, creatorID, isGroup, apiKey, uploadAnimations, cookie } = payload || {};
    console.log("[handleUpload] Received payload:", {
        assetIDs,
        creatorID,
        isGroup,
        apiKeyLength: apiKey?.length,
        uploadAnimations,
    });

    if (!Array.isArray(assetIDs) || !creatorID) {
        console.error("[handleUpload] Missing required fields.");
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Missing required fields (assetIDs, creatorID)"
        }));
    }
    if (!uploadAnimations && !apiKey) {
        console.error("[handleUpload] Missing apiKey for images.");
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            error: "Missing 'apiKey' (required for images)."
        }));
    }

    const jobId = randomUUID();
    jobs[jobId] = {
        total: assetIDs.length,
        done: 0,
        finished: false,
        results: [],
        moderated: [],
        failures: [],
        warnApiKey: false,
        message: "Starting reupload job..."
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobId }));

    if (uploadAnimations) {
        runJobAnimations(jobId, assetIDs, creatorID, !!isGroup, apiKey || "", cookie || "")
            .catch((err) => {
                console.error(`[handleUpload] Fatal animation job error:`, err);
                jobs[jobId].message = `Fatal: ${err.message}`;
                jobs[jobId].finished = true;
            });
    } else {
        runJobImages(jobId, assetIDs, creatorID, !!isGroup, apiKey)
            .catch((err) => {
                console.error(`[handleUpload] Fatal image job error:`, err);
                jobs[jobId].message = `Fatal: ${err.message}`;
                jobs[jobId].finished = true;
            });
    }
}

function handleProgress(req, res, urlObj) {
    const params = new URLSearchParams(urlObj.search);
    const jobId = params.get("jobId");
    if (!jobId || !jobs[jobId]) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid or missing jobId" }));
    }

    const jobInfo = jobs[jobId];
    const chunkSize = 50;

    const out = {
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
        out.resultsCount = jobInfo.results.length;
        out.moderatedCount = jobInfo.moderated.length;
        out.failuresCount = jobInfo.failures.length;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
}

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
        return res.end(JSON.stringify({ error: "Job not finished yet. Wait for 'finished' == true." }));
    }
    const results = jobInfo.results;
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
        return res.end(JSON.stringify({ error: "Job not finished yet. Wait for 'finished' == true." }));
    }
    const moderated = jobInfo.moderated;
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
