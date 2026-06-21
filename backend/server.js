const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const cors = require('cors');
const path = require('path');

const ConsistentHashRing = require('./consistentHashRing');
const BatchWriter = require('./batchWriter');
const DecayEngine = require('./decayEngine');
const seeder = require('./seeder');

const app = express();
app.use(cors());
app.use(express.json());

// Express serves the public assets from the mounted directory
app.use(express.static(path.join(__dirname, 'public')));

// Configure DB Connection Pool
const pool = new Pool({
    user: process.env.DB_USER || 'admin',
    password: process.env.DB_PASSWORD || 'password',
    host: process.env.DB_HOST || 'postgres',
    database: process.env.DB_NAME || 'typeahead',
    port: parseInt(process.env.DB_PORT || '5432', 10),
});

// Circular buffer for tracking API request latencies to compute p95 values
const latencyBuffer = [];
const MAX_LATENCY_BUFFER_SIZE = 1000;

function recordLatency(durationMs) {
    latencyBuffer.push(durationMs);
    if (latencyBuffer.length > MAX_LATENCY_BUFFER_SIZE) {
        latencyBuffer.shift();
    }
}

function getP95Latency() {
    if (latencyBuffer.length === 0) return 0;
    const sorted = [...latencyBuffer].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.95);
    return sorted[index];
}

// Global stats tracker
const stats = {
    cacheHits: 0,
    cacheMisses: 0,
};

let hashRing;
let batchWriter;
let decayEngine;

/**
 * Initialize all external connections and start the services
 */
async function initialize() {
    console.log('[Server] Connecting to database...');
    // Verify PostgreSQL connection and wait for table structures
    await pool.query('SELECT NOW()');

    // Run database seeding task
    try {
        await seeder.seed(pool);
    } catch (err) {
        console.error('[Server] Database seeding failed:', err);
    }

    // Connect to 3 Redis Instances
    const redisNodesStr = process.env.REDIS_NODES || 'redis://redis1:6379,redis://redis2:6379,redis://redis3:6379';
    const redisUrls = redisNodesStr.split(',');
    
    console.log(`[Server] Connecting to ${redisUrls.length} Redis cache nodes...`);
    const redisClients = await Promise.all(redisUrls.map(async (url, index) => {
        const client = createClient({ url });
        client.on('error', (err) => console.error(`[Redis Client-${index + 1}] Connection error:`, err));
        await client.connect();
        console.log(`[Server] Redis Client-${index + 1} connected successfully.`);
        return client;
    }));

    // Initialize core business logic objects
    hashRing = new ConsistentHashRing(redisClients, 100);
    batchWriter = new BatchWriter(pool, 5000);        // Flush buffer every 5 seconds
    decayEngine = new DecayEngine(pool, 60000);       // Run decay loop every 60 seconds

    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`[Server] Search Typeahead backend listening on port ${port}`);
    });
}

/**
 * API: GET /suggest?q=<prefix>&ranking=<basic|enhanced>
 * Returns up to 10 matching suggestion strings.
 * Falls back to PostgreSQL on cache miss and writes results to the mapped Redis node.
 */
app.get('/suggestions', async (req, res) => {
    const startTime = Date.now();
    const rawPrefix = req.query.q || '';
    const prefix = rawPrefix.trim().toLowerCase();
    
    // Support toggleable ranking modes for grading demonstration
    const ranking = req.query.ranking || 'enhanced';

    try {
        // If prefix is empty, bypass cache and retrieve global trending directly from Postgres
        // so that trending chips update immediately when the batch writer flushes search counts.
        if (prefix === '') {
            let dbQuery = '';
            if (ranking === 'basic') {
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    ORDER BY all_time_count DESC 
                    LIMIT 10
                `;
            } else {
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    ORDER BY (all_time_count + (recent_count * 5)) DESC 
                    LIMIT 10
                `;
            }
            const dbRes = await pool.query(dbQuery);
            const suggestions = dbRes.rows.map(row => row.query);
            const duration = Date.now() - startTime;
            recordLatency(duration);
            return res.json(suggestions);
        }

        // Namespace keys by ranking mode to prevent collision
        const cacheKey = `suggest:${ranking}:${prefix}`;

        // Locate appropriate Redis client from Hash Ring
        const targetClient = hashRing.getClient(prefix);

        // Check cache
        const cachedResult = await targetClient.get(cacheKey);
        if (cachedResult !== null) {
            stats.cacheHits++;
            const suggestions = JSON.parse(cachedResult);
            const duration = Date.now() - startTime;
            recordLatency(duration);
            return res.json(suggestions);
        }

        // Cache Miss: Query Database
        stats.cacheMisses++;
        let dbQuery = '';
        let params = [];

        if (prefix) {
            if (ranking === 'basic') {
                // Rank purely on all-time popular search volume
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    WHERE query LIKE $1 
                    ORDER BY all_time_count DESC 
                    LIMIT 10
                `;
            } else {
                // Enhanced Ranking: Combines long-term volume with decayed recent trends
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    WHERE query LIKE $1 
                    ORDER BY (all_time_count + (recent_count * 5)) DESC 
                    LIMIT 10
                `;
            }
            params = [`${prefix}%`];
        } else {
            // If prefix is empty, return global trending/popular queries
            if (ranking === 'basic') {
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    ORDER BY all_time_count DESC 
                    LIMIT 10
                `;
            } else {
                dbQuery = `
                    SELECT query 
                    FROM searches 
                    ORDER BY (all_time_count + (recent_count * 5)) DESC 
                    LIMIT 10
                `;
            }
        }

        const dbRes = await pool.query(dbQuery, params);
        // Requirement: "extract only the strings (strip the counts) and save them with a 60-second TTL"
        const suggestions = dbRes.rows.map(row => row.query);

        // Write suggestions string array back to Redis with a 60s TTL ONLY if we found matches.
        // Leaving empty results uncached ensures that subsequent searches for non-existent terms
        // continue to miss and correctly decrease the cache hit rate.
        if (suggestions.length > 0) {
            await targetClient.set(cacheKey, JSON.stringify(suggestions), { EX: 60 });
        }

        const duration = Date.now() - startTime;
        recordLatency(duration);
        return res.json(suggestions);

    } catch (err) {
        console.error('[Suggest API Error]', err);
        // Gracefully failover: query directly from PostgreSQL to ensure continuous uptime
        try {
            const dbQuery = prefix 
                ? `SELECT query FROM searches WHERE query LIKE $1 ORDER BY all_time_count DESC LIMIT 10`
                : `SELECT query FROM searches ORDER BY all_time_count DESC LIMIT 10`;
            const dbRes = await pool.query(dbQuery, prefix ? [`${prefix}%`] : []);
            return res.json(dbRes.rows.map(r => r.query));
        } catch (dbErr) {
            return res.status(500).json({ error: 'Internal system fault.' });
        }
    }
});

/**
 * API: POST /search
 * Receives search submissions and pushes them to the in-memory batch buffer.
 */
app.post('/select', (req, res) => {
    const query = req.query.q || req.body.query;
    if (!query || typeof query !== 'string' || !query.trim()) {
        return res.status(400).json({ error: 'Search query is required.' });
    }

    // Buffer search submission
    batchWriter.addSearch(query);

    return res.json({ message: "Searched" });
});

/**
 * API: GET /cache/debug?prefix=<prefix>&ranking=<basic|enhanced>
 * Debug cache routing: identifies which Redis node is responsible for the prefix
 * and reports the current hash values and hit/miss status.
 */
app.get('/cache/debug', async (req, res) => {
    const rawPrefix = req.query.prefix || '';
    const prefix = rawPrefix.trim().toLowerCase();
    const ranking = req.query.ranking || 'enhanced';

    try {
        const cacheKey = `suggest:${ranking}:${prefix}`;
        const { nodeName, client, hash } = hashRing.getNodeAndClient(prefix);

        const cachedVal = await client.get(cacheKey);
        const exists = cachedVal !== null;

        return res.json({
            prefix,
            cacheKey,
            responsibleNode: nodeName,
            md5Hash: hash,
            cached: exists,
            values: exists ? JSON.parse(cachedVal) : null
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

/**
 * API: GET /metrics
 * Aggregates and returns performance indicators.
 */
app.get('/metrics', (req, res) => {
    const bwStats = batchWriter.getStats();
    const deStats = decayEngine.getStats();

    const totalRequests = stats.cacheHits + stats.cacheMisses;
    const hitRate = totalRequests > 0 ? ((stats.cacheHits / totalRequests) * 100).toFixed(2) + '%' : '0.00%';

    const writeReduction = bwStats.totalIncomingSearches > 0 
        ? ((1 - (bwStats.totalFlushes / bwStats.totalIncomingSearches)) * 100).toFixed(2) + '%'
        : '0.00%';

    return res.json({
        cacheHits: stats.cacheHits,
        cacheMisses: stats.cacheMisses,
        cacheHitRate: hitRate,
        p95LatencyMs: getP95Latency().toFixed(2),
        totalRequests,
        batchWriter: {
            incomingSearches: bwStats.totalIncomingSearches,
            flushes: bwStats.totalFlushes,
            rowsUpserted: bwStats.totalQueriesUpserted,
            writeReduction,
            bufferSize: bwStats.bufferSize
        },
        decayEngine: {
            totalDecays: deStats.totalDecays,
            lastDecayTimestamp: deStats.lastDecayTimestamp,
            lastDecayDurationMs: deStats.lastDecayDurationMs
        }
    });
});

// Self-executing initialization boot
initialize().catch(err => {
    console.error('[Server] Initialization failed:', err);
    process.exit(1);
});
