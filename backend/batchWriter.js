/**
 * BatchWriter buffers incoming search submissions in-memory and flushes them
 * to PostgreSQL periodically using a single bulk UPSERT query.
 * This alleviates database write locks under high concurrent search traffic.
 */
class BatchWriter {
    constructor(pgPool, flushIntervalMs = 5000) {
        this.pool = pgPool;
        this.buffer = new Map();
        
        // Performance metrics for reporting and viva documentation
        this.stats = {
            totalIncomingSearches: 0,   // Total search events submitted by users
            totalFlushes: 0,             // Number of times flush has been called with data
            totalQueriesUpserted: 0,     // Total number of unique rows upserted to Postgres
            lastFlushTimeMs: 0
        };

        // Run flush task asynchronously at designated intervals
        setInterval(() => this.flush(), flushIntervalMs);
    }

    /**
     * Add a search query to the write buffer
     */
    addSearch(query) {
        const cleanQuery = (query || '').trim().toLowerCase();
        if (!cleanQuery) return;

        const current = this.buffer.get(cleanQuery) || 0;
        this.buffer.set(cleanQuery, current + 1);
        this.stats.totalIncomingSearches += 1;
    }

    /**
     * Get statistics to evaluate batch write optimization efficiency
     */
    getStats() {
        return {
            ...this.stats,
            bufferSize: this.buffer.size
        };
    }

    /**
     * Flushes the buffer map to Postgres.
     * Uses atomic INSERT ... ON CONFLICT (query) DO UPDATE
     */
    async flush() {
        if (this.buffer.size === 0) return;

        const start = Date.now();
        // Extract snapshot and immediately clear the buffer to minimize lock time
        const entries = Array.from(this.buffer.entries());
        this.buffer.clear();

        const now = Date.now();
        
        // Programmatically assemble bulk insert parameters
        let queryText = `
            INSERT INTO searches (query, all_time_count, recent_count, last_searched_at)
            VALUES 
        `;
        const values = [];
        let counter = 1;

        entries.forEach(([query, count], index) => {
            queryText += `($${counter++}, $${counter++}, $${counter++}, $${counter++})`;
            if (index < entries.length - 1) queryText += `, `;
            // Initial counts are set to the buffered count, last_searched_at is current time
            values.push(query, count, count, now);
        });

        // Resolve conflicts on duplicate key (query) by accumulating search counts
        queryText += `
            ON CONFLICT (query) DO UPDATE SET
            all_time_count = searches.all_time_count + EXCLUDED.all_time_count,
            recent_count = searches.recent_count + EXCLUDED.recent_count,
            last_searched_at = EXCLUDED.last_searched_at
        `;

        try {
            await this.pool.query(queryText, values);
            const duration = Date.now() - start;
            this.stats.totalFlushes += 1;
            this.stats.totalQueriesUpserted += entries.length;
            this.stats.lastFlushTimeMs = duration;
            console.log(`[BatchWriter] Flushed ${entries.length} unique queries (${entries.reduce((sum, e) => sum + e[1], 0)} total clicks) to Postgres in ${duration}ms.`);
        } catch (err) {
            console.error('[BatchWriter] Critical error during bulk DB flush:', err);
            // In case of error, we log it. A production setup would retry, but for the scope
            // of this HLD assignment, standard exception logging is appropriate.
        }
    }
}

module.exports = BatchWriter;
