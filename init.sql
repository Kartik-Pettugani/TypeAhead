CREATE TABLE IF NOT EXISTS searches (
    query TEXT PRIMARY KEY,
    all_time_count INTEGER DEFAULT 0,
    recent_count NUMERIC DEFAULT 0,
    last_searched_at BIGINT
);

-- Optimize prefix matching (e.g. query LIKE 'prefix%') using text_pattern_ops
CREATE INDEX IF NOT EXISTS idx_searches_query_pattern ON searches (query text_pattern_ops);
