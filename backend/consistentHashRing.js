const crypto = require('crypto');

/**
 * Consistent Hash Ring for distributed caching.
 * Uses MD5 hashing to map prefix keys onto a ring of virtual nodes,
 * ensuring balanced request routing across multiple cache instances.
 */
class ConsistentHashRing {
    constructor(redisClients, virtualNodes = 100) {
        this.ring = [];
        this.nodes = {};
        this.virtualNodes = virtualNodes;

        // Register each physical Redis client on the ring
        redisClients.forEach((client, index) => {
            const nodeName = `redis-${index + 1}`;
            this.nodes[nodeName] = client;

            // Generate virtual nodes to prevent clustering and ensure even keyspace distribution
            for (let i = 0; i < this.virtualNodes; i++) {
                const hash = this._hash(`${nodeName}-vnode-${i}`);
                this.ring.push({ hash, nodeName });
            }
        });

        // Sort the ring lexicographically based on MD5 hashes for binary search operations
        this.ring.sort((a, b) => a.hash.localeCompare(b.hash));
    }

    /**
     * Compute MD5 hash of key
     */
    _hash(key) {
        return crypto.createHash('md5').update(key).digest('hex');
    }

    /**
     * Get both the server node label and Redis client object for a prefix.
     * Useful for debugging node distribution and serving queries.
     */
    getNodeAndClient(prefix) {
        // Standardize input prefix to ensure routing consistency
        const cleanPrefix = (prefix || '').trim().toLowerCase();
        const hash = this._hash(cleanPrefix);

        // Find the first virtual node with a hash greater than or equal to the prefix hash
        for (let i = 0; i < this.ring.length; i++) {
            if (this.ring[i].hash >= hash) {
                const nodeName = this.ring[i].nodeName;
                return { nodeName, client: this.nodes[nodeName], hash };
            }
        }

        // Wrap around to the start of the ring if no match is found
        const nodeName = this.ring[0].nodeName;
        return { nodeName, client: this.nodes[nodeName], hash };
    }

    /**
     * Returns the target Redis client for a given search prefix
     */
    getClient(prefix) {
        return this.getNodeAndClient(prefix).client;
    }
}

module.exports = ConsistentHashRing;
