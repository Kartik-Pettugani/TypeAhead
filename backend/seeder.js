const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/**
 * Seeder loads real-world search query frequency data from a CSV file.
 * 
 * The CSV file (query_frequency.csv) contains ~1M rows of actual search
 * queries with their frequency counts, providing realistic distribution
 * for the typeahead suggestion system.
 * 
 * Format: query,count
 * Example: google,32396
 */
async function seed(pool) {
    console.log('[Seeder] Starting CSV data import...');
    
    // Check if database already holds a substantial dataset
    try {
        const checkRes = await pool.query('SELECT COUNT(*) FROM searches');
        const existingCount = parseInt(checkRes.rows[0].count, 10);
        if (existingCount >= 100000) {
            console.log(`[Seeder] Database already populated with ${existingCount} queries. Skipping seed.`);
            return;
        }
    } catch (err) {
        console.error('[Seeder] Failed to check database occupancy:', err.message);
        return;
    }

    // Resolve path to the CSV file (mounted via docker-compose volume)
    const csvPath = path.join(__dirname, 'data', 'query_frequency.csv');
    
    if (!fs.existsSync(csvPath)) {
        console.error(`[Seeder] CSV file not found at: ${csvPath}`);
        console.error('[Seeder] Ensure query_frequency.csv is mounted to /usr/src/app/data/');
        return;
    }

    console.log(`[Seeder] Reading CSV from: ${csvPath}`);

    // Parse CSV using readline for memory-efficient streaming
    const queries = [];
    const fileStream = fs.createReadStream(csvPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let isHeader = true;
    let lineCount = 0;

    for await (const line of rl) {
        // Skip header row
        if (isHeader) {
            isHeader = false;
            continue;
        }

        // Parse CSV line: "query,count"
        // Handle queries that might contain commas by finding the LAST comma
        const lastCommaIdx = line.lastIndexOf(',');
        if (lastCommaIdx === -1) continue;

        const query = line.substring(0, lastCommaIdx).trim().toLowerCase();
        const countStr = line.substring(lastCommaIdx + 1).trim();
        const count = parseInt(countStr, 10);

        if (!query || isNaN(count) || count <= 0) continue;

        queries.push({ query, count });
        lineCount++;
    }

    console.log(`[Seeder] Parsed ${lineCount} valid queries from CSV.`);

    if (queries.length === 0) {
        console.error('[Seeder] No valid queries found in CSV. Aborting seed.');
        return;
    }

    // Batch insert into PostgreSQL
    const batchSize = 4000;
    const now = Date.now();
    let inserted = 0;

    for (let i = 0; i < queries.length; i += batchSize) {
        const chunk = queries.slice(i, i + batchSize);
        
        let queryText = 'INSERT INTO searches (query, all_time_count, recent_count, last_searched_at) VALUES ';
        const values = [];
        let paramCounter = 1;

        chunk.forEach((entry, idx) => {
            // Use the real frequency count from the CSV as all_time_count
            const allTimeCount = entry.count;
            
            // Set ~5% of queries to have recent search traffic for trending demo
            // Higher-frequency queries get proportionally more recent traffic
            const recentCount = idx % 20 === 0 
                ? Math.floor(allTimeCount * (0.05 + Math.random() * 0.15)) 
                : 0;

            queryText += `($${paramCounter++}, $${paramCounter++}, $${paramCounter++}, $${paramCounter++})`;
            if (idx < chunk.length - 1) queryText += ', ';
            
            values.push(entry.query, allTimeCount, recentCount, now);
        });

        queryText += ' ON CONFLICT (query) DO NOTHING';

        try {
            await pool.query(queryText, values);
            inserted += chunk.length;
        } catch (err) {
            console.error(`[Seeder] Batch insert error at offset ${i}:`, err.message);
            // Continue with next batch rather than abort entirely
        }

        if (inserted % 20000 === 0 || i + batchSize >= queries.length) {
            console.log(`[Seeder] Seeded ${Math.min(inserted, queries.length)} / ${queries.length} rows...`);
        }
    }
    
    console.log(`[Seeder] Database seeding completed successfully. Total rows inserted: ${inserted}`);
}

module.exports = { seed };
