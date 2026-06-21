/**
 * DecayEngine runs a background loop to apply a 10% mathematical decay
 * to the `recent_count` field of all queries in the database.
 * This ensures that temporary spikes in search trends naturally fade over time.
 */
class DecayEngine {
    constructor(pgPool, intervalMs = 60000) {
        this.pool = pgPool;
        this.stats = {
            totalDecays: 0,
            lastDecayDurationMs: 0,
            lastDecayTimestamp: null
        };
        // Schedule decay execution
        setInterval(() => this.runDecay(), intervalMs);
    }

    /**
     * Get statistics of decay actions
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Executes the decay SQL update.
     * We filter using `recent_count > 0.01` to avoid writing updates to 
     * records that have already decayed to practically zero.
     */
    async runDecay() {
        const start = Date.now();
        try {
            const res = await this.pool.query(`
                UPDATE searches 
                SET recent_count = recent_count * 0.9 
                WHERE recent_count > 0.01
            `);
            const duration = Date.now() - start;
            
            this.stats.totalDecays += 1;
            this.stats.lastDecayDurationMs = duration;
            this.stats.lastDecayTimestamp = new Date().toISOString();

            console.log(`[DecayEngine] Applied 10% decay to trending queries. Rows affected: ${res.rowCount || 0} in ${duration}ms.`);
        } catch (err) {
            console.error('[DecayEngine] Fatal error during decay routine:', err);
        }
    }
}

module.exports = DecayEngine;
