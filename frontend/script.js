// Global Application State
let activeSuggestions = [];
let highlightedIndex = -1;
let debounceTimer = null;
let lastMetrics = null; // Store previous metrics state to detect background updates

// DOM Element Selectors
const searchInput = document.getElementById('search-input');
const suggestionsDropdown = document.getElementById('suggestions-dropdown');
const outputContent = document.getElementById('output-content');
const batchIndicator = document.getElementById('batch-indicator');
const trendingChipsContainer = document.getElementById('trending-chips-container');
const logsPanel = document.getElementById('logs-panel');

// Metrics DOM elements
const metricHitRate = document.getElementById('metric-hit-rate');
const metricLatency = document.getElementById('metric-latency');
const metricWriteReduction = document.getElementById('metric-write-reduction');

// Node indicator element
const debugNodeIndicator = document.getElementById('debug-node-indicator');

/**
 * Append message logs to the UI debugger console
 */
function logEvent(message) {
    const time = new Date().toLocaleTimeString();
    const logLine = document.createElement('div');
    logLine.textContent = `[${time}] ${message}`;
    logsPanel.appendChild(logLine);
    logsPanel.scrollTop = logsPanel.scrollHeight;
}

/**
 * Handle input value changes with a debouncer to prevent flooding backend API.
 */
function onInputChanged(event) {
    const val = event.target.value;

    // Clear existing timer
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!val.trim()) {
        hideDropdown();
        updateRoutingDetails('');
        return;
    }

    // Trigger suggestions fetch after 250ms of typing inactivity
    debounceTimer = setTimeout(() => {
        fetchSuggestions(val);
        updateRoutingDetails(val);
    }, 250);
}

/**
 * Fetch suggestions from backend GET /suggest endpoint
 */
async function fetchSuggestions(prefix) {
    try {
        const url = `/suggest?q=${encodeURIComponent(prefix)}`;
        const start = performance.now();
        const response = await fetch(url);
        const list = await response.json();
        const duration = (performance.now() - start).toFixed(1);

        activeSuggestions = list;
        highlightedIndex = -1;

        renderSuggestions(list, prefix);
    } catch (err) {
        logEvent(`Error fetching suggestions: ${err.message}`);
    }
}

/**
 * Render suggestions in the dropdown list
 */
function renderSuggestions(list, prefix = '') {
    suggestionsDropdown.innerHTML = '';

    if (list.length === 0) {
        suggestionsDropdown.innerHTML = '<div class="suggestion-item" style="color: var(--text-muted); cursor: default;">No matching suggestions</div>';
        suggestionsDropdown.style.display = 'block';
        return;
    }

    list.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'suggestion-item';
        div.setAttribute('data-index', index);

        let displayHtml = escapeHtml(item);
        if (prefix && item.toLowerCase().startsWith(prefix.toLowerCase())) {
            const matchLen = prefix.length;
            const matchPart = escapeHtml(item.substring(0, matchLen));
            const restPart = escapeHtml(item.substring(matchLen));
            displayHtml = `<strong>${matchPart}</strong>${restPart}`;
        }

        // Autocomplete icon SVG
        div.innerHTML = `
            <svg class="suggestion-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
            <span>${displayHtml}</span>
        `;

        div.addEventListener('click', () => selectSuggestion(item));
        suggestionsDropdown.appendChild(div);
    });

    suggestionsDropdown.style.display = 'block';
}

/**
 * Select suggestion and populate input
 */
function selectSuggestion(val) {
    searchInput.value = val;
    hideDropdown();
    updateRoutingDetails(val);
    submitSearch();
}

/**
 * Hide suggestion list
 */
function hideDropdown() {
    suggestionsDropdown.style.display = 'none';
    activeSuggestions = [];
    highlightedIndex = -1;
}

/**
 * Handle keyboard accessibility navigation within dropdown suggestions list
 */
function onInputKeyDown(event) {
    if (suggestionsDropdown.style.display !== 'block' || activeSuggestions.length === 0) {
        if (event.key === 'Enter') {
            submitSearch();
        }
        return;
    }

    const items = suggestionsDropdown.getElementsByClassName('suggestion-item');

    if (event.key === 'ArrowDown') {
        event.preventDefault();
        highlightedIndex = (highlightedIndex + 1) % activeSuggestions.length;
        updateHighlight(items);
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        highlightedIndex = (highlightedIndex - 1 + activeSuggestions.length) % activeSuggestions.length;
        updateHighlight(items);
    } else if (event.key === 'Enter') {
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < activeSuggestions.length) {
            selectSuggestion(activeSuggestions[highlightedIndex]);
        } else {
            submitSearch();
        }
    } else if (event.key === 'Escape') {
        hideDropdown();
    }
}

/**
 * Apply highlighted css class to selected navigation index
 */
function updateHighlight(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove('highlighted');
    }
    if (highlightedIndex >= 0 && highlightedIndex < items.length) {
        items[highlightedIndex].classList.add('highlighted');
        items[highlightedIndex].scrollIntoView({ block: 'nearest' });
    }
}

/**
 * Submit search query to the database updates POST /search API
 */
async function submitSearch() {
    const val = searchInput.value.trim();
    if (!val) return;

    hideDropdown();
    batchIndicator.textContent = "Buffering...";
    batchIndicator.style.color = "var(--primary)";

    try {
        const response = await fetch('/search?q=' + encodeURIComponent(val), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: val })
        });
        const data = await response.json();

        // Render clean inline message to user
        outputContent.textContent = data.message || JSON.stringify(data);

        logEvent(`[User Search] Submitted: "${val}". Count recorded in buffer map.`);

        // Visual indicator that the query is buffered in the in-memory write buffer
        setTimeout(() => {
            batchIndicator.textContent = "Buffered";
            batchIndicator.style.color = varColorString('success');
        }, 300);

        // Fetch new trending queries to verify update
        fetchTrending();
    } catch (err) {
        outputContent.textContent = JSON.stringify({ error: err.message }, null, 4);
        logEvent(`Search submission failed: ${err.message}`);
    }
}

/**
 * Fetch and display global trending searches
 */
async function fetchTrending() {
    try {
        const response = await fetch(`/suggest?q=`);
        const list = await response.json();

        trendingChipsContainer.innerHTML = '';
        if (list.length === 0) {
            trendingChipsContainer.innerHTML = '<span style="font-size: 0.9rem; color: var(--text-muted);">No trends yet. Start searching!</span>';
            return;
        }

        list.forEach((item) => {
            const chip = document.createElement('div');
            chip.className = 'trending-chip';
            chip.innerHTML = `
                <span>🔥</span>
                <span>${escapeHtml(item)}</span>
            `;
            chip.addEventListener('click', () => {
                searchInput.value = item;
                submitSearch();
            });
            trendingChipsContainer.appendChild(chip);
        });
    } catch (err) {
        console.error('Error fetching trending list:', err);
    }
}

/**
 * Query /cache/debug endpoint to populate the consistent hashing visualizer
 */
async function updateRoutingDetails(prefix) {
    const cleanPrefix = (prefix || '').trim().toLowerCase();
    if (!cleanPrefix) {
        debugNodeIndicator.className = 'node-indicator-small unmapped';
        debugNodeIndicator.textContent = 'None';
        return;
    }

    try {
        const url = `/cache/debug?prefix=${encodeURIComponent(cleanPrefix)}`;
        const response = await fetch(url);
        const data = await response.json();

        debugNodeIndicator.className = `node-indicator-small ${data.responsibleNode}`;
        debugNodeIndicator.textContent = data.responsibleNode.toUpperCase();
    } catch (err) {
        console.error('Error updating routing details:', err);
    }
}

/**
 * Poll system metrics from GET /metrics endpoint
 */
async function pollMetrics() {
    try {
        const response = await fetch('/metrics');
        const m = await response.json();

        // Update Metrics Cards
        metricHitRate.textContent = m.cacheHitRate;
        metricLatency.textContent = m.p95LatencyMs + ' ms';
        metricWriteReduction.textContent = m.batchWriter.writeReduction;

        // Monitor background server actions and output logs
        if (lastMetrics) {
            // Check if a flush occurred
            if (m.batchWriter.flushes > lastMetrics.batchWriter.flushes) {
                const written = m.batchWriter.rowsUpserted - lastMetrics.batchWriter.rowsUpserted;
                logEvent(`[Batch Service] Buffer flushed to DB. Upserted ${written} unique queries.`);
            }
            // Check if a decay cycle occurred
            if (m.decayEngine.totalDecays > lastMetrics.decayEngine.totalDecays) {
                logEvent(`[Decay Engine] Decay cycle completed. Adjusted active search ranks by -10%.`);
            }
        }

        lastMetrics = m;
    } catch (err) {
        console.error('Error polling metrics:', err);
    }
}


// Helper: Escape HTML strings for XSS mitigation
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function varColorString(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(`--${varName}`).trim();
}

// App Initialization Bootstrapping
window.addEventListener('DOMContentLoaded', () => {
    fetchTrending();
    // Poll metrics every 1.5 seconds
    setInterval(pollMetrics, 1500);
    // Execute immediate poll
    pollMetrics();
    logEvent('[Client] Connection successfully established with Node.js cluster server.');
});
