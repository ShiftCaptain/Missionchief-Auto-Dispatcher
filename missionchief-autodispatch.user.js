// ==UserScript==
// @name         MissionChief Auto-Dispatch v2
// @namespace    shiftcaptain.missionchief
// @version      0.17.0
// @description  Delta-based auto-dispatch (tops up partial/upgraded missions instead of abandoning them). Runs in-tab, no login handling needed.
// @match        https://www.missionchief.com/*
// @match        https://*.missionchief.com/*
// @match        https://*.leitstellenspiel.de/*
// @noframes
// @downloadURL  https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/missionchief-autodispatch.user.js
// @updateURL    https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/missionchief-autodispatch.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ── Config ────────────────────────────────────────────────────────────
    const CONFIG = {
        sleepPerBatchMs: 45000,   // time between batches
        dispatchDelayMs: 1000,    // time between individual dispatch calls
        missionsPerRun: 30,
    };

    // ── Utilities ─────────────────────────────────────────────────────────
    // log() writes to the real console AND a capped in-memory buffer — the
    // panel shows a structured mission status list day-to-day (see
    // upsertMissionRow below), but the buffer backs the "View Console Log"
    // button in Settings for anyone who doesn't want to open DevTools.
    const LOG_BUFFER_MAX = 1000;
    const logBuffer = [];
    function log(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(line);
        logBuffer.push(line);
        if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    }

    // Status -> color used for both the badge and the status text
    const STATUS_COLORS = {
        dispatched: '#1565c0',   // blue — just sent vehicles
        fullyStaffed: '#2e7d32', // green — nothing needed
        missing: '#ef6c00',      // orange — partial, still short
        noUnits: '#c62828',      // red — nothing available to send
        failed: '#c62828',       // red — dispatch call itself failed
        unknown: '#757575',      // gray — uncached/unknown mission type
    };

    const missionRowEls = new Map(); // key -> row element, persists across batches

    function upsertMissionRow(key, title, statusText, colorKey) {
        if (!rowsContainer) return;
        const color = STATUS_COLORS[colorKey] || '#757575';
        let row = missionRowEls.get(key);
        if (!row) {
            row = document.createElement('div');
            row.style.cssText = `
                all: unset; display: flex; align-items: center; gap: 8px;
                padding: 6px 10px; border-bottom: 1px solid #eee;
                font: 12px/1.3 Arial, Helvetica, sans-serif; box-sizing: border-box; width: 100%;
            `;
            row.innerHTML = `
                <span class="mc-badge" style="all:unset; display:inline-block; width:10px; height:10px; border-radius:2px; flex-shrink:0;"></span>
                <span class="mc-title" style="all:unset; flex:1 1 auto; color:var(--mc-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
                <span class="mc-status" style="all:unset; flex-shrink:0; font-weight:bold; white-space:nowrap;"></span>
            `;
            rowsContainer.appendChild(row);
            missionRowEls.set(key, row);
        }
        row.querySelector('.mc-badge').style.background = color;
        row.querySelector('.mc-title').textContent = title;
        const statusEl = row.querySelector('.mc-status');
        statusEl.textContent = statusText;
        statusEl.style.color = color;
    }

    function removeStaleMissionRows(activeKeys) {
        for (const [key, el] of missionRowEls) {
            if (!activeKeys.has(key)) {
                el.remove();
                missionRowEls.delete(key);
            }
        }
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.content : null;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Same purpose as sleep(), but updates the panel's countdown timer each
    // second and bails out immediately (rather than waiting out the full
    // duration) if the bot is stopped mid-wait.
    function sleepWithCountdown(totalMs) {
        return new Promise((resolve) => {
            const start = Date.now();
            function tick() {
                if (!isRunning) { resolve(); return; }
                const remaining = Math.max(0, totalMs - (Date.now() - start));
                const secs = Math.ceil(remaining / 1000);
                setTimerText(remaining > 0 ? `Next batch in ${secs}s` : 'Starting batch...');
                if (remaining <= 0) { resolve(); return; }
                setTimeout(tick, 250);
            }
            tick();
        });
    }

    // ── Storage: vehicle-class links + mission requirement cache ────────────
    // Same schema as the Python bot's links.json and json/region/<server>/missions/<mtid>.json,
    // just persisted via GM storage instead of files on disk.

    // Baked-in default vehicle class -> type ID mapping (ShiftCaptain's confirmed
    // links.json, verified against a live fleet report covering all 19 owned
    // vehicle types). Anyone installing this script fresh gets a working bot
    // immediately; Import Cache can still override this per-user if their
    // server's type IDs differ.
    const DEFAULT_LINKS = {
        "firetrucks": [0, 1, 30, 13, 18],
        "platform trucks": [2, 13],
        "wildland fire engines": [30, 31, 32, 33],
        "battalion chief vehicles": [3, 12],
        "heavy rescue vehicles": [4, 18, 8],
        "ambulance": [5, 27],
        "water tankers": [7],
        "hazmat vehicles": [9],
        "police cars": [10, 19, 26],
        "mobile command vehicles": [12],
        "mobile air vehicles": [6],
        "k-9 units": [19],
        "type 5 engine": [31],
        "type 7 engine": [32],
        "type 3 engine": [30],
        "pumper tanker": [33],
        "crew carrier": [34],
        "mass casulty unit": [20],
        "swat suv": [26],
        "swat armoured vehicles": [16],
        "swat personnel": [16, 26],
        "police helicopters": [14],
        "boats": [21, 22],
        "large fire boats": [24],
        "large rescue boat": [25],
        "police bike": [23],
        "ems chief": [29],
        "ems rescue": [28],
        "fly car": [15],
        "air ambulance": [11],
        "arff": [17],
        "sheriff supervisor units": [47],
        "prisoner transport": [87],
    };

    function getLinks() {
        const raw = GM_getValue('mc_links', null);
        if (raw) return JSON.parse(raw);
        // First run — seed storage from the baked-in defaults so the bot
        // works immediately without requiring an Import Cache step.
        setLinks(DEFAULT_LINKS);
        return { ...DEFAULT_LINKS };
    }
    function setLinks(obj) {
        GM_setValue('mc_links', JSON.stringify(obj));
    }
    function getMissionReqs() {
        const raw = GM_getValue('mc_missionReqs', null);
        return raw ? JSON.parse(raw) : {};
    }
    function setMissionReqs(obj) {
        GM_setValue('mc_missionReqs', JSON.stringify(obj));
    }
    function getIgnoreList() {
        const raw = GM_getValue('mc_ignoreList', null);
        return raw ? JSON.parse(raw) : [];
    }

    // Per-user preferences, toggled from the Settings panel. Defaults match
    // the bot's original behavior (own calls only, all mission types) so
    // installing/updating doesn't silently change anyone's existing setup.
    const DEFAULT_SETTINGS = {
        dispatchAllianceCalls: false,
        dispatchScheduledCalls: true,
        reassignCloserUnits: false, // opt-in: cancels an en-route unit if a meaningfully closer one becomes available
        darkMode: false,
    };
    function getSettings() {
        const raw = GM_getValue('mc_settings', null);
        return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    }
    function setSettings(obj) {
        GM_setValue('mc_settings', JSON.stringify(obj));
    }

    // Task forces: named groups of vehicle captions that should always be
    // dispatched together. Matched by exact caption text (case-insensitive),
    // since that's what's visible in-game — no need to dig up vehicle IDs.
    // Stored as an array of { name, members: [...] } objects.
    function getTaskForces() {
        const raw = GM_getValue('mc_taskForces', null);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        // Migrate from the old plain-array format (no names) if present.
        return parsed.map((g, i) =>
            Array.isArray(g) ? { name: `Task Force ${i + 1}`, members: g } : g
        );
    }
    function setTaskForces(groups) {
        GM_setValue('mc_taskForces', JSON.stringify(groups));
    }

    // Given a vehicle's caption, returns the set of OTHER captions (lowercased)
    // that share a task force with it. A vehicle can belong to more than one
    // group; partners from every matching group are included.
    function findTaskForcePartnerNames(caption, taskForces) {
        const lower = (caption || '').toLowerCase();
        const partners = new Set();
        for (const group of taskForces) {
            const members = group.members || [];
            if (members.some((n) => n.toLowerCase() === lower)) {
                members.forEach((n) => {
                    if (n.toLowerCase() !== lower) partners.add(n.toLowerCase());
                });
            }
        }
        return partners;
    }

    // Personnel certification & resource-need mappings: user-defined links
    // from a certification/resource keyword (as it appears in the game's own
    // missing_text field, e.g. "HazMat" or "foam") to a vehicle class from
    // links.json whose crews/cargo are assumed to cover it. No defaults are
    // guessed here — a wrong guess (e.g. assuming Heavy Rescue = Tech Rescue
    // certified) could cause bad dispatches, so this starts empty until the
    // user defines it themselves, same as Task Forces.
    function getPersonnelMappings() {
        const raw = GM_getValue('mc_personnelMappings', null);
        return raw ? JSON.parse(raw) : [];
    }
    function setPersonnelMappings(arr) {
        GM_setValue('mc_personnelMappings', JSON.stringify(arr));
    }
    function getResourceMappings() {
        const raw = GM_getValue('mc_resourceMappings', null);
        return raw ? JSON.parse(raw) : [];
    }
    function setResourceMappings(arr) {
        GM_setValue('mc_resourceMappings', JSON.stringify(arr));
    }
    function findMappedVehicleClass(keyword, mappings) {
        const lower = (keyword || '').toLowerCase();
        const hit = mappings.find((m) =>
            lower.includes(m.key.toLowerCase()) || m.key.toLowerCase().includes(lower)
        );
        return hit ? hit.vehicleClass : null;
    }

    // Tries to match a keyword straight against existing links.json class
    // names (e.g. "water" -> "water tankers") before falling back to a
    // user-defined mapping — covers the common case with zero setup, only
    // requiring the Settings mapping for names that don't naturally align
    // (e.g. "Technical Rescuer" needing to point at "heavy rescue vehicles").
    function autoMatchVehicleClass(keyword, links) {
        const lower = (keyword || '').toLowerCase();
        const classNames = Object.keys(links);
        const exact = classNames.find((c) => c.toLowerCase() === lower);
        if (exact) return exact;
        const partial = classNames.find((c) => {
            const cLower = c.toLowerCase();
            return cLower.includes(lower) || lower.includes(cLower);
        });
        return partial || null;
    }

    // Parses mission.missing_text — a live, game-computed field reporting
    // exactly what's still short, e.g.
    // {"vehicles":"5 firetrucks","personnel":"4x HazMat","other":"200 gal. foam"}
    // Note: the game uses real non-breaking spaces (\u00a0) between words.
    function parseMissingText(mission) {
        if (!mission.missing_text) return null;
        try {
            return JSON.parse(mission.missing_text);
        } catch (e) {
            return null;
        }
    }

    // "4x HazMat, 6x Technical Rescuer" -> [{ qty: 4, cert: 'HazMat' }, ...]
    function parsePersonnelNeeds(text) {
        if (!text) return [];
        return text
            .split(',')
            .map((s) => s.replace(/\u00a0/g, ' ').trim())
            .filter(Boolean)
            .map((tok) => {
                const m = tok.match(/^(\d+)\s*x\s*(.+)$/i);
                return m ? { qty: parseInt(m[1], 10), cert: m[2].trim() } : null;
            })
            .filter(Boolean);
    }

    // "200 gal. foam" -> [{ qty: 200, resource: 'foam', raw: '200 gal. foam' }]
    function parseOtherNeeds(text) {
        if (!text) return [];
        return text
            .split(',')
            .map((s) => s.replace(/\u00a0/g, ' ').trim())
            .filter(Boolean)
            .map((tok) => {
                const m = tok.match(/^([\d.]+)\s*(?:gal\.?|gallons?)?\s*(.+)$/i);
                return m
                    ? { qty: parseFloat(m[1]), resource: m[2].trim().toLowerCase(), raw: tok }
                    : { qty: null, resource: tok.toLowerCase(), raw: tok };
            });
    }

    // Scheduled/special missions: confirmed via live data that the mission's
    // own "sw" field (paired with a "sw_start_in" countdown) is the real,
    // authoritative flag for this — e.g. "Traffic light failure" showed
    // sw: true despite not matching any caption keyword. Caption keywords are
    // kept as a fallback only for the rare case a mission lacks the field.
    const SCHEDULED_KEYWORDS = ['fire alarm', 'exercise', 'speed trap', 'training', 'drill', 'inspection'];
    function isScheduledMission(mission) {
        if (typeof mission.sw === 'boolean') return mission.sw;
        const caption = (mission.caption || '').toLowerCase();
        return SCHEDULED_KEYWORDS.some((kw) => caption.includes(kw));
    }

    // ── API calls (confirmed endpoints from the Python bot) ─────────────────
    async function fetchMissions() {
        const res = await fetch('/map/missions_json', {
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`missions fetch failed: ${res.status}`);
        const text = await res.text();
        if (!text.trim()) return [];
        const data = JSON.parse(text);
        // Returns everything unfiltered — alliance/scheduled/ignore-list
        // filtering happens in runBatch() against live settings, so toggling
        // a setting takes effect on the very next batch without needing to
        // change this function.
        return Array.isArray(data)
            ? data
            : (data.missions || data.result || Object.values(data)[0] || []);
    }

    async function fetchVehicles() {
        const res = await fetch('/api/vehicles', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`vehicles fetch failed: ${res.status}`);
        return res.json();
    }

    async function fetchBuildingCoords() {
        const res = await fetch('/api/buildings', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`buildings fetch failed: ${res.status}`);
        const buildings = await res.json();
        const coords = {};
        for (const b of buildings) {
            coords[b.id] = [b.latitude || 0, b.longitude || 0];
        }
        return coords;
    }

    async function fetchEinsaetze() {
        const res = await fetch('/einsaetze.json', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`einsaetze fetch failed: ${res.status}`);
        const raw = await res.json();
        if (Array.isArray(raw)) {
            const obj = {};
            raw.forEach((m, i) => { obj[String(m.id ?? i)] = m; });
            return obj;
        }
        return raw;
    }

    async function dispatchVehicles(missionId, vehicleIds) {
        const token = getCsrfToken();
        const params = new URLSearchParams();
        vehicleIds.forEach((id) => params.append('vehicle_ids[]', id));
        const res = await fetch(`/missions/${missionId}/alarm`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                ...(token ? { 'X-CSRF-Token': token } : {}),
            },
            body: params.toString(),
        });
        return res.ok;
    }

    // Confirmed via a live Network capture of clicking "Cancel" on a
    // dispatched vehicle: GET /vehicles/{id}/backalarm?return=mission_js&sd=d&sk=ac
    // (sd/sk appear to be static params, not per-request tokens). Recalls a
    // vehicle that's currently en route back to its station, clearing its
    // mission assignment.
    async function cancelVehicleDispatch(vehicleId) {
        const res = await fetch(`/vehicles/${vehicleId}/backalarm?return=mission_js&sd=d&sk=ac`, {
            credentials: 'same-origin',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        return res.ok;
    }

    // ── Cache auto-builder (mirrors build_cache_entry from the Python bot) ──
    function buildCacheEntry(mtid, einsaetze, links) {
        const mtype = einsaetze[String(mtid)];
        if (!mtype) return null;

        const name = mtype.name || mtype.caption || `Mission ${mtid}`;
        const rawReqs = mtype.requirements || {};
        const skipKeywords = ['water', 'water needed', 'oneof'];

        const reqs = [];
        for (const [className, qty] of Object.entries(rawReqs)) {
            let cls = className.toLowerCase().replace(/_/g, ' ');
            if (skipKeywords.some((kw) => cls.includes(kw))) continue;
            if (!(cls in links)) {
                const matched = Object.keys(links).find((k) => k.toLowerCase() === cls);
                if (matched) cls = matched; else continue;
            }
            reqs.push({ requirement: cls, qty: String(qty) });
        }

        const missionReqs = getMissionReqs();
        missionReqs[String(mtid)] = { missionId: String(mtid), missionName: name, requirements: reqs };
        setMissionReqs(missionReqs);

        log(reqs.length
            ? `  CACHE Added '${name}' [type ${mtid}]: ${JSON.stringify(reqs)}`
            : `  CACHE Added '${name}' [type ${mtid}] (no vehicle requirements)`);
        return missionReqs[String(mtid)];
    }

    // ── Patient transport (mirrors fetch_transport_options / run_transport_pass) ──
    async function fetchTransportOptions(vehicleId) {
        const res = await fetch(`/vehicles/${vehicleId}`, { credentials: 'same-origin' });
        if (!res.ok) return [];
        const html = await res.text();

        const hospitals = [];
        const rowPattern = /<tr class="">([\s\S]*?)<\/tr>/g;
        const namePattern = /<td>\s*([A-Za-z0-9 \-.']+?)\s*<div/;
        const distancePattern = /([\d.]+)\s*km/;
        const bedsPattern = /(\d+)\s*\/\s*(\d+)/;
        const deptPattern = /label-(success|danger)["']>\s*(Yes|No)/i;
        const buildingPattern = /\/patient\/(\d+)"/;

        let rowMatch;
        while ((rowMatch = rowPattern.exec(html)) !== null) {
            const row = rowMatch[1];
            const nameM = namePattern.exec(row);
            const distM = distancePattern.exec(row);
            const bedsM = bedsPattern.exec(row);
            const deptM = deptPattern.exec(row);
            const bldM = buildingPattern.exec(row);
            if (!(nameM && distM && bedsM && bldM)) continue;
            hospitals.push({
                name: nameM[1].trim(),
                building_id: parseInt(bldM[1], 10),
                distance_km: parseFloat(distM[1]),
                free: parseInt(bedsM[1], 10),
                total: parseInt(bedsM[2], 10),
                dept_match: deptM ? deptM[2].toLowerCase() === 'yes' : false,
            });
        }
        return hospitals;
    }

    async function transportPatient(vehicleId, buildingId) {
        const res = await fetch(`/vehicles/${vehicleId}/patient/${buildingId}`, { credentials: 'same-origin' });
        return res.ok;
    }

    async function runTransportPass(vehicles) {
        let transportCount = 0;
        for (const v of vehicles) {
            if (!isRunning) break;
            if (v.fms_real !== 5) continue;
            const vid = v.id;
            const vname = v.caption || `Vehicle ${vid}`;

            const hospitals = await fetchTransportOptions(vid);
            if (!hospitals.length) continue;

            const candidates = hospitals.filter((h) => h.dept_match && h.free > 0);
            if (!candidates.length) {
                log(`  TRANSPORT ${vname}: no hospital with matching department and free beds`);
                continue;
            }

            candidates.sort((a, b) => a.distance_km - b.distance_km);
            const chosen = candidates[0];

            const success = await transportPatient(vid, chosen.building_id);
            if (success) {
                log(`  TRANSPORT ${vname} -> ${chosen.name} (${chosen.distance_km.toFixed(1)} km, ${chosen.free}/${chosen.total} beds)`);
                transportCount++;
            } else {
                log(`  TRANSPORT ${vname} -> FAILED to send to ${chosen.name}`);
            }
            await sleep(CONFIG.dispatchDelayMs);
        }
        if (transportCount) {
            log(`Transport pass complete — ${transportCount} patient(s) sent to hospitals.`);
        }
    }

    // ── Prisoner transport (mirrors fetch_prisoner_options / run_prisoner_transport_pass) ──
    async function fetchPrisonerOptions(vehicleId) {
        const res = await fetch(`/vehicles/${vehicleId}`, { credentials: 'same-origin' });
        if (!res.ok) return [];
        const html = await res.text();

        const prisons = [];
        const pushPattern = /erb_(?:alliance_)?prisons\.push\((\{[\s\S]*?\})\);/g;

        let m;
        while ((m = pushPattern.exec(html)) !== null) {
            let obj;
            try {
                obj = JSON.parse(m[1]);
            } catch (e) {
                continue;
            }
            prisons.push({
                name: obj.name || '',
                building_id: obj.id,
                distance_km: parseFloat(obj.distance_in_km || 0),
                free_cells: parseInt(obj.free_cells || 0, 10),
            });
        }
        return prisons;
    }

    async function transportPrisoner(vehicleId, buildingId) {
        const res = await fetch(`/vehicles/${vehicleId}/gefangener/${buildingId}`, { credentials: 'same-origin' });
        return res.ok;
    }

    // Reads a vehicle's detail page for two things not available anywhere in
    // the API: the Staff table (Name / Training columns, for certification
    // checks) and any "{Resource} amount" info rows (e.g. "Water amount:
    // 750 gal.", "Foam amount: 25 gal.") for actual carried capacity. Both
    // come off the same page, so one fetch covers both use cases.
    // Uses DOMParser (real browser context) rather than regex, since table
    // structure is more reliably queried by header/label text than markup shape.
    const vehicleDetailsCache = new Map(); // vehicleId -> { staff, resources, fetchedAt }
    const DETAILS_CACHE_MS = 30000;

    async function fetchVehicleDetails(vehicleId) {
        const cached = vehicleDetailsCache.get(vehicleId);
        if (cached && Date.now() - cached.fetchedAt < DETAILS_CACHE_MS) return cached;

        const empty = { staff: [], resources: {}, fetchedAt: Date.now() };
        const res = await fetch(`/vehicles/${vehicleId}`, { credentials: 'same-origin' });
        if (!res.ok) return empty;
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        // Staff table
        let staff = [];
        const tables = Array.from(doc.querySelectorAll('table'));
        for (const table of tables) {
            const headers = Array.from(table.querySelectorAll('th')).map((th) => th.textContent.trim().toLowerCase());
            const nameIdx = headers.indexOf('name');
            const trainingIdx = headers.indexOf('training');
            if (nameIdx === -1 || trainingIdx === -1) continue;

            const rows = Array.from(table.querySelectorAll('tbody tr'));
            staff = rows
                .map((tr) => {
                    const cells = Array.from(tr.querySelectorAll('td'));
                    return {
                        name: (cells[nameIdx]?.textContent || '').trim(),
                        training: (cells[trainingIdx]?.textContent || '').trim(),
                    };
                })
                .filter((s) => s.name);
            break;
        }

        // Resource capacity rows — plain label/value pairs like
        // "Water amount" | "750 gal." sitting in the vehicle's info table.
        const resources = {};
        const allRows = Array.from(doc.querySelectorAll('tr'));
        for (const tr of allRows) {
            const cells = Array.from(tr.querySelectorAll('td, th'));
            if (cells.length < 2) continue;
            const label = cells[0].textContent.trim().toLowerCase();
            const m = label.match(/^(.+?)\s*amount$/);
            if (!m) continue;
            const resourceName = m[1].trim();
            const numMatch = cells[1].textContent.trim().match(/([\d.]+)/);
            if (numMatch) resources[resourceName] = parseFloat(numMatch[1]);
        }

        const result = { staff, resources, fetchedAt: Date.now() };
        vehicleDetailsCache.set(vehicleId, result);
        return result;
    }

    function staffHasCertification(staff, certKeyword) {
        const lower = (certKeyword || '').toLowerCase();
        return staff.some((s) => {
            const t = s.training.toLowerCase();
            return t.includes(lower) || lower.includes(t);
        });
    }

    function vehicleHasResource(resources, resourceKeyword) {
        const lower = (resourceKeyword || '').toLowerCase();
        for (const [name, amount] of Object.entries(resources)) {
            const n = name.toLowerCase();
            if ((n.includes(lower) || lower.includes(n)) && amount > 0) return true;
        }
        return false;
    }

    async function runPrisonerTransportPass(vehicles) {
        let transportCount = 0;
        for (const v of vehicles) {
            if (!isRunning) break;
            if (v.fms_real !== 5) continue;
            const vid = v.id;
            const vname = v.caption || `Vehicle ${vid}`;

            const prisons = await fetchPrisonerOptions(vid);
            if (!prisons.length) continue;

            const candidates = prisons.filter((p) => p.free_cells > 0);
            if (!candidates.length) {
                log(`  PRISONER ${vname}: no station with free cells`);
                continue;
            }

            candidates.sort((a, b) => a.distance_km - b.distance_km);
            const chosen = candidates[0];

            const success = await transportPrisoner(vid, chosen.building_id);
            if (success) {
                log(`  PRISONER ${vname} -> ${chosen.name} (${chosen.distance_km.toFixed(1)} km, ${chosen.free_cells} free cells)`);
                transportCount++;
            } else {
                log(`  PRISONER ${vname} -> FAILED to send to ${chosen.name}`);
            }
            await sleep(CONFIG.dispatchDelayMs);
        }
        if (transportCount) {
            log(`Prisoner transport pass complete — ${transportCount} prisoner(s) sent to stations.`);
        }
    }

    // ── Dispatch logic (the fixed, delta-based version) ──────────────────────
    // States 1 (at station) and 2 (available via radio) are both legitimately
    // dispatchable. The real guard against double-dispatch / unwanted
    // "follow-up" assignments is checking the vehicle has NO current
    // commitment at all — no active mission target and nothing queued.
    const AVAILABLE_STATES = new Set([1, 2]);

    function getAvailableVehicles(vehicles) {
        return vehicles.filter((v) =>
            AVAILABLE_STATES.has(v.fms_real ?? v.fms_show)
            && !(v.target_type === 'mission' && v.target_id) // not already assigned to a mission
            && !v.queued_mission_id // nothing already queued as a follow-up
        );
    }

    // Counts vehicles CURRENTLY assigned to this mission via target_type/target_id —
    // the real source of truth, confirmed against live vehicle data. This is what
    // replaces the old "skip mission if vehicle_state != 0" behavior that caused
    // partial dispatches and upgrades to get silently abandoned.
    // Returns both the per-type counts AND the set of vehicle IDs counted, so
    // callers can merge in additional sources without double-counting.
    function getAssignedVehicleCounts(missionId, vehicles) {
        const counts = {};
        const ids = new Set();
        for (const v of vehicles) {
            if (v.target_type === 'mission' && v.target_id === missionId) {
                counts[v.vehicle_type] = (counts[v.vehicle_type] || 0) + 1;
                ids.add(v.id);
            }
        }
        return { counts, ids };
    }

    // Some mission upgrades (e.g. Little Field Fire -> Large Field Fire) appear
    // to issue a NEW mission id for what is physically the same call at the same
    // address. When that happens, vehicles already working it still point their
    // target_id at the OLD id, so a lookup keyed on the current id finds nothing
    // and the bot treats it as a brand-new mission — dispatching the full
    // requirement set on top of units that are already there.
    //
    // Fix: track commitment by LOCATION (which an upgrade doesn't change) as a
    // second layer alongside the live target_id check. Any vehicle we previously
    // saw committed to this location, that's still busy (not back in the
    // available pool), gets folded into the assigned counts even if its
    // target_id no longer matches the mission's current id.
    const missionTrack = {}; // signature -> Set of vehicle ids last known committed here

    function missionSignature(mission) {
        const lat = (mission.latitude || 0).toFixed(5);
        const lon = (mission.longitude || 0).toFixed(5);
        return `${lat},${lon}`;
    }

    function getRequiredVehicleTypes(entry, links, assignedCounts) {
        const reqs = (entry?.requirements || []).map((r) => [r.requirement, parseInt(r.qty, 10)]);
        const slots = [];
        for (const [className, qty] of reqs) {
            if (className.toLowerCase() === 'ambulance') continue;
            let typeIds = links[className];
            if (!typeIds) {
                const matched = Object.keys(links).find((k) => k.toLowerCase() === className.toLowerCase());
                typeIds = matched ? links[matched] : null;
            }
            if (!typeIds || !typeIds.length) continue;
            const alreadyAssigned = typeIds.reduce((sum, t) => sum + (assignedCounts[t] || 0), 0);
            const stillNeeded = Math.max(0, qty - alreadyAssigned);
            for (let i = 0; i < stillNeeded; i++) slots.push(typeIds);
        }
        return slots;
    }

    // No live vehicle position data exists anywhere in the API (confirmed —
    // no polling endpoint fires even after watching Network for 2+ minutes).
    // Distance can only ever be approximated via the vehicle's HOME STATION
    // location. That's exact for state 1 (truly at the station) but just a
    // guess for state 2 (returning from a previous call — could be much
    // closer or farther than its station in reality). Rather than treat both
    // as equally trustworthy, prefer confirmed-accurate state-1 candidates
    // first, only falling back to state-2 approximations when nothing state-1
    // is available.
    function nearestVehicleForSlot(available, acceptableTypes, missionLat, missionLon, usedIds, buildingCoords) {
        const candidates = available.filter((v) => !usedIds.has(v.id) && acceptableTypes.includes(v.vehicle_type));
        if (!candidates.length) return null;

        function nearestOf(pool) {
            let best = null;
            let bestDist = Infinity;
            for (const v of pool) {
                const [lat, lon] = buildingCoords[v.building_id] || [0, 0];
                const d = haversineKm(lat, lon, missionLat, missionLon);
                if (d < bestDist) { bestDist = d; best = v; }
            }
            return best;
        }

        const atStation = candidates.filter((v) => (v.fms_real ?? v.fms_show) === 1);
        return nearestOf(atStation.length ? atStation : candidates);
    }

    // ── Main batch ────────────────────────────────────────────────────────
    const state = { links: {}, einsaetze: {}, buildingCoords: {} };
    let isRunning = false;

    // Opt-in only (Settings toggle, default off): recalls an EN ROUTE vehicle
    // (fms_real === 3 — never touches ones already on scene) if a confirmed
    // at-station vehicle of the same type is meaningfully closer. Doesn't
    // redispatch in the same pass — just cancels and lets the next batch's
    // normal delta-fill logic pick up the freed requirement with the closer
    // unit. Margin thresholds and a per-batch cap guard against thrashing
    // (constantly swapping over marginal, noise-level distance differences).
    async function runReassignmentPass(missions, vehicles) {
        const REASSIGN_MIN_RATIO = 0.8; // candidate must be at most 80% of the en-route unit's distance
        const REASSIGN_MIN_KM = 1;      // and at least 1km closer in absolute terms
        const MAX_REASSIGNS_PER_BATCH = 5;

        const atStation = vehicles.filter((v) => (v.fms_real ?? v.fms_show) === 1);
        let swaps = 0;

        for (const mission of missions) {
            if (swaps >= MAX_REASSIGNS_PER_BATCH) break;
            const mlat = mission.latitude || 0;
            const mlon = mission.longitude || 0;
            const mid = mission.id;

            const enRoute = vehicles.filter((v) =>
                v.fms_real === 3 && v.target_type === 'mission' && v.target_id === mid
            );
            if (!enRoute.length) continue;

            for (const ev of enRoute) {
                if (swaps >= MAX_REASSIGNS_PER_BATCH) break;

                const [evLat, evLon] = state.buildingCoords[ev.building_id] || [0, 0];
                const evDist = haversineKm(evLat, evLon, mlat, mlon);

                let best = null;
                let bestDist = Infinity;
                for (const c of atStation) {
                    if (c.vehicle_type !== ev.vehicle_type || c.id === ev.id) continue;
                    const [clat, clon] = state.buildingCoords[c.building_id] || [0, 0];
                    const d = haversineKm(clat, clon, mlat, mlon);
                    if (d < bestDist) { bestDist = d; best = c; }
                }

                if (best && bestDist <= evDist * REASSIGN_MIN_RATIO && (evDist - bestDist) >= REASSIGN_MIN_KM) {
                    const success = await cancelVehicleDispatch(ev.id);
                    log(success
                        ? `  REASSIGN ${mission.caption || mid}: recalled ${ev.caption || ev.id} (${evDist.toFixed(1)}km) — ${best.caption || best.id} is closer (${bestDist.toFixed(1)}km), will dispatch next batch`
                        : `  REASSIGN ${mission.caption || mid}: FAILED to recall ${ev.caption || ev.id}`);
                    if (success) swaps++;
                    await sleep(CONFIG.dispatchDelayMs);
                }
            }
        }

        if (swaps > 0) log(`Reassignment pass complete — ${swaps} unit(s) recalled for closer replacements.`);
    }

    async function runBatch() {
        log('Fetching missions and vehicles...');
        let missions, vehicles;
        try {
            [missions, vehicles] = await Promise.all([fetchMissions(), fetchVehicles()]);
        } catch (e) {
            log(`Network error: ${e.message} — will retry next batch`);
            return;
        }

        const available = getAvailableVehicles(vehicles);
        log(`  ${missions.length} active missions | ${available.length} vehicles available`);

        const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
        const availableByCaption = new Map();
        for (const v of available) {
            if (v.caption) availableByCaption.set(v.caption.toLowerCase(), v);
        }
        const taskForces = getTaskForces();
        const personnelMappings = getPersonnelMappings();
        const resourceMappings = getResourceMappings();

        const settings = getSettings();
        if (!settings.dispatchAllianceCalls) {
            missions = missions.filter((m) => !m.alliance_id && !m.is_alliance);
        }
        if (!settings.dispatchScheduledCalls) {
            missions = missions.filter((m) => !isScheduledMission(m));
        }
        const ignoreList = getIgnoreList().map((n) => n.toLowerCase());
        missions = missions.filter((m) => !ignoreList.includes((m.caption || '').toLowerCase()));

        const missionReqs = getMissionReqs();
        const totalOf = (mtid) =>
            (missionReqs[mtid]?.requirements || []).reduce((s, r) => s + parseInt(r.qty, 10), 0);
        missions.sort((a, b) => {
            const mtA = String(a.mtid ?? a.mission_type_id ?? '');
            const mtB = String(b.mtid ?? b.mission_type_id ?? '');
            return totalOf(mtA) - totalOf(mtB);
        });
        missions = missions.slice(0, CONFIG.missionsPerRun);

        if (settings.reassignCloserUnits) {
            await runReassignmentPass(missions, vehicles);
        }

        let dispatchedCount = 0;
        const usedIds = new Set();
        const processedKeys = new Set();
        const verifyQueue = []; // successful dispatches to double-check after the batch

        for (const mission of missions) {
            if (!isRunning) break;

            const name = mission.caption || `Mission #${mission.id}`;
            const mlat = mission.latitude || 0;
            const mlon = mission.longitude || 0;
            const mid = mission.id;
            const mtid = String(mission.mtid ?? mission.mission_type_id ?? '');
            const sig = missionSignature(mission);
            const rowKey = String(mid);
            processedKeys.add(rowKey);

            let entry = missionReqs[mtid];
            if (!mtid || !entry) {
                if (mtid && state.einsaetze[mtid]) {
                    entry = buildCacheEntry(mtid, state.einsaetze, state.links);
                    if (!entry) {
                        log(`  SKIP  ${name} [type ${mtid}] (unknown mission type)`);
                        upsertMissionRow(rowKey, name, 'Unknown Type', 'unknown');
                        continue;
                    }
                } else {
                    log(`  SKIP  ${name} [type ${mtid}] (not in cache)`);
                    upsertMissionRow(rowKey, name, 'Not Cached', 'unknown');
                    continue;
                }
            }

            // Delta: what's already assigned to THIS mission, per vehicle type —
            // live target_id matches first...
            const assigned = getAssignedVehicleCounts(mid, vehicles);

            // ...then fold in anything previously tracked at this LOCATION that's
            // still busy but whose target_id fell out of sync (the upgrade case).
            const tracked = missionTrack[sig];
            if (tracked) {
                for (const vid of tracked) {
                    if (assigned.ids.has(vid)) continue; // already counted, don't double-count
                    const v = vehicleById.get(vid);
                    if (v && !AVAILABLE_STATES.has(v.fms_real ?? v.fms_show)) {
                        assigned.counts[v.vehicle_type] = (assigned.counts[v.vehicle_type] || 0) + 1;
                        assigned.ids.add(vid);
                    }
                }
            }
            const assignedCounts = assigned.counts;
            missionTrack[sig] = new Set(assigned.ids);

            const slots = getRequiredVehicleTypes(entry, state.links, assignedCounts);

            const patients = mission.patients_count || 0;
            if (patients > 0) {
                const ambTypes = state.links['ambulance'];
                if (ambTypes && ambTypes.length) {
                    const alreadyAmb = ambTypes.reduce((s, t) => s + (assignedCounts[t] || 0), 0);
                    const stillNeededAmb = Math.max(0, patients - alreadyAmb);
                    for (let i = 0; i < stillNeededAmb; i++) slots.push(ambTypes);
                }
            }

            // Personnel certifications & resources (water, foam, etc.): both
            // verified against real per-vehicle data scraped from the vehicle
            // detail page (crew Training table, and "{X} amount" capacity
            // rows) rather than guessed. Settings mappings are OPTIONAL —
            // they narrow which vehicles get checked first for speed, but
            // the bot works with zero configuration by checking the nearest
            // available vehicles broadly when no mapping/class-name match exists.
            const missing = parseMissingText(mission);
            const resourceNotes = [];
            const personnelNeeds = missing ? parsePersonnelNeeds(missing.personnel) : [];
            const otherNeeds = missing ? parseOtherNeeds(missing.other) : [];
            const hasPersonnelNeed = personnelNeeds.length > 0;
            const hasResourceNeed = otherNeeds.length > 0;

            const totalRequired = (entry.requirements || []).reduce((s, r) => s + parseInt(r.qty, 10), 0);
            if (totalRequired === 0 && !patients && !hasPersonnelNeed && !hasResourceNeed) {
                // No-requirement mission type — dispatch empty once.
                // vehicle_state is safe to use ONLY here as a one-time marker,
                // since there's nothing to ever top up on a no-req mission.
                if ((mission.vehicle_state || 0) !== 0) {
                    upsertMissionRow(rowKey, name, 'Fully Staffed', 'fullyStaffed');
                    continue;
                }
                const success = await dispatchVehicles(mid, []);
                log(success
                    ? `  SENT  ${name} [type ${mtid}] -> 0 vehicle(s) (no requirements)`
                    : `  FAIL  ${name} [type ${mtid}] (dispatch error)`);
                upsertMissionRow(rowKey, name, success ? 'Dispatched' : 'Failed', success ? 'dispatched' : 'failed');
                if (success) dispatchedCount++;
                await sleep(CONFIG.dispatchDelayMs);
                continue;
            }

            if (!slots.length && !hasPersonnelNeed && !hasResourceNeed) {
                log(`  SKIP  ${name} [type ${mtid}] (fully staffed already)`);
                upsertMissionRow(rowKey, name, 'Fully Staffed', 'fullyStaffed');
                continue;
            }

            const selectedIds = [];
            const selectedNames = [];
            let unfilled = 0;
            for (const acceptableTypes of slots) {
                const v = nearestVehicleForSlot(available, acceptableTypes, mlat, mlon, usedIds, state.buildingCoords);
                if (!v) {
                    unfilled++;
                } else {
                    selectedIds.push(v.id);
                    usedIds.add(v.id);
                    // Capture status at the moment of selection — if a follow-up
                    // shows up later in-game, compare that vehicle's name here
                    // against what its fms/target/queued fields looked like
                    // right before we dispatched it.
                    selectedNames.push(
                        `${v.caption || v.id} (fms=${v.fms_real ?? v.fms_show}, target=${v.target_type || 'none'}/${v.target_id ?? '-'}, queued=${v.queued_mission_id ?? '-'})`
                    );
                }
            }

            // Builds a distance-sorted candidate pool: narrowed to a mapped/
            // auto-matched vehicle class if one exists (fewer, more relevant
            // checks), otherwise every available vehicle (broader, but still
            // works with zero configuration).
            const CANDIDATES_TO_CHECK = 3;
            function nearestCandidates(typeIds) {
                const pool = typeIds
                    ? available.filter((v) => !usedIds.has(v.id) && typeIds.includes(v.vehicle_type))
                    : available.filter((v) => !usedIds.has(v.id));
                return pool
                    .map((v) => {
                        const [lat, lon] = state.buildingCoords[v.building_id] || [0, 0];
                        return { v, dist: haversineKm(lat, lon, mlat, mlon) };
                    })
                    .sort((a, b) => a.dist - b.dist)
                    .slice(0, CANDIDATES_TO_CHECK)
                    .map((x) => x.v);
            }

            const unresolvedNeeds = []; // short descriptions of shortfalls we couldn't fill, for accurate row status

            // Vehicles already committed to this mission — either already on
            // scene/en route from a prior batch, or just selected THIS batch
            // to satisfy a plain vehicle-count requirement (e.g. "5 firetrucks").
            // Check these FIRST: an engine dispatched to meet a firetruck
            // requirement may already be carrying the foam/certification a
            // separate personnel/resource line is asking for, and searching
            // for an additional vehicle without checking that first wastes a
            // dispatch on something already covered.
            async function findAlreadyCovering(checkFn) {
                const idsToCheck = [...new Set([...assigned.ids, ...selectedIds])];
                for (const id of idsToCheck) {
                    const v = vehicleById.get(id);
                    if (!v) continue;
                    const details = await fetchVehicleDetails(id);
                    if (checkFn(details)) return v;
                }
                return null;
            }

            for (const need of personnelNeeds) {
                const already = await findAlreadyCovering((d) => staffHasCertification(d.staff, need.cert));
                if (already) {
                    resourceNotes.push(`personnel: ${need.qty}x ${need.cert} still needed -> already covered by ${already.caption || already.id}`);
                    continue;
                }

                const cls = findMappedVehicleClass(need.cert, personnelMappings);
                const typeIds = cls ? state.links[cls] : null;
                const candidates = nearestCandidates(typeIds);

                let matched = null;
                for (const cand of candidates) {
                    const details = await fetchVehicleDetails(cand.id);
                    if (staffHasCertification(details.staff, need.cert)) {
                        matched = cand;
                        break;
                    }
                }

                if (matched) {
                    selectedIds.push(matched.id);
                    usedIds.add(matched.id);
                    selectedNames.push(`${matched.caption || matched.id} (verified: crew certified in ${need.cert})`);
                    resourceNotes.push(`personnel: ${need.qty}x ${need.cert} still needed -> sent ${matched.caption || matched.id} (certification confirmed)`);
                } else if (candidates.length) {
                    resourceNotes.push(`personnel: ${need.qty}x ${need.cert} still needed -> checked ${candidates.length} nearby vehicle(s), none certified`);
                    unresolvedNeeds.push(`${need.qty}x ${need.cert}`);
                } else {
                    resourceNotes.push(`personnel: ${need.qty}x ${need.cert} still needed -> no available vehicles nearby to check`);
                    unresolvedNeeds.push(`${need.qty}x ${need.cert}`);
                }
            }

            for (const need of otherNeeds) {
                const already = await findAlreadyCovering((d) => vehicleHasResource(d.resources, need.resource));
                if (already) {
                    resourceNotes.push(`other: ${need.raw} still needed -> already covered by ${already.caption || already.id}`);
                    continue;
                }

                const cls = autoMatchVehicleClass(need.resource, state.links)
                    || findMappedVehicleClass(need.resource, resourceMappings);
                const typeIds = cls ? state.links[cls] : null;
                const candidates = nearestCandidates(typeIds);

                let matched = null;
                for (const cand of candidates) {
                    const details = await fetchVehicleDetails(cand.id);
                    if (vehicleHasResource(details.resources, need.resource)) {
                        matched = cand;
                        break;
                    }
                }

                if (matched) {
                    selectedIds.push(matched.id);
                    usedIds.add(matched.id);
                    selectedNames.push(`${matched.caption || matched.id} (verified: carries ${need.resource})`);
                    resourceNotes.push(`other: ${need.raw} still needed -> sent ${matched.caption || matched.id} (capacity confirmed)`);
                } else if (candidates.length) {
                    resourceNotes.push(`other: ${need.raw} still needed -> checked ${candidates.length} nearby vehicle(s), none carrying ${need.resource}`);
                    unresolvedNeeds.push(need.raw);
                } else {
                    resourceNotes.push(`other: ${need.raw} still needed -> no available vehicles nearby to check`);
                    unresolvedNeeds.push(need.raw);
                }
            }

            // Task forces: if any selected vehicle has a dispatch partner that's
            // currently available and not already picked, pull it in too — even
            // if the mission's own requirements never called for that vehicle
            // type. BFS-style so chains (A pairs with B, B pairs with C) resolve
            // fully in one pass.
            if (taskForces.length && selectedIds.length) {
                const addedPartners = [];
                let frontier = [...selectedIds];
                while (frontier.length) {
                    const nextFrontier = [];
                    for (const id of frontier) {
                        const v = vehicleById.get(id);
                        if (!v || !v.caption) continue;
                        const partnerNames = findTaskForcePartnerNames(v.caption, taskForces);
                        for (const partnerNameLower of partnerNames) {
                            const partnerVehicle = availableByCaption.get(partnerNameLower);
                            if (partnerVehicle && !usedIds.has(partnerVehicle.id)) {
                                selectedIds.push(partnerVehicle.id);
                                usedIds.add(partnerVehicle.id);
                                addedPartners.push(partnerVehicle);
                                nextFrontier.push(partnerVehicle.id);
                            }
                        }
                    }
                    frontier = nextFrontier;
                }
                if (addedPartners.length) {
                    addedPartners.forEach((v) => selectedNames.push(
                        `${v.caption || v.id} (task force partner, fms=${v.fms_real ?? v.fms_show})`
                    ));
                    log(`  TASKFORCE +${addedPartners.length} partner vehicle(s) added for ${name}`);
                }
            }

            // Combines vehicle-slot shortfall with any unresolved
            // personnel/resource needs into one accurate "Missing" label —
            // previously this only ever reflected vehicle slots, so a mission
            // could show "Missing 0" while still genuinely short on something
            // like foam, which was misleading.
            function missingLabel() {
                const bits = [];
                if (unfilled > 0) bits.push(`${unfilled} vehicle(s)`);
                if (unresolvedNeeds.length) bits.push(unresolvedNeeds.join(', '));
                return bits.length ? `Missing ${bits.join(' + ')}` : null;
            }

            if (!selectedIds.length) {
                log(`  SKIP  ${name} [type ${mtid}] (no available vehicles)`);
                resourceNotes.forEach((n) => log(`         ~ ${n}`));
                upsertMissionRow(rowKey, name, missingLabel() || `Missing ${unfilled}`, 'noUnits');
                continue;
            }

            const success = await dispatchVehicles(mid, selectedIds);
            if (success) {
                selectedIds.forEach((id) => missionTrack[sig].add(id));
                log(unfilled > 0
                    ? `  PART  ${name} [type ${mtid}] -> ${selectedIds.length} vehicle(s) (${unfilled} slot(s) unfilled, will retry)`
                    : `  SENT  ${name} [type ${mtid}] -> ${selectedIds.length} vehicle(s)`);
                selectedNames.forEach((n) => log(`         + ${n}`));
                resourceNotes.forEach((n) => log(`         ~ ${n}`));
                const missing = missingLabel();
                upsertMissionRow(
                    rowKey, name,
                    missing ? `Dispatched (${selectedIds.length}), ${missing}` : `Dispatched (${selectedIds.length})`,
                    missing ? 'missing' : 'dispatched'
                );
                dispatchedCount++;
                // Don't fully trust this yet — a dispatch call can succeed but
                // still land as a QUEUED follow-up rather than an immediate
                // assignment if the vehicle wasn't truly free. Verify after
                // the batch and walk it back if it didn't land immediately.
                verifyQueue.push({ rowKey, sig, mid, name, mtid, ids: [...selectedIds], unfilledAtDispatch: unfilled });
            } else {
                log(`  FAIL  ${name} [type ${mtid}] (dispatch error)`);
                upsertMissionRow(rowKey, name, 'Failed', 'failed');
            }

            await sleep(CONFIG.dispatchDelayMs);
        }

        // ── Post-batch verification ──────────────────────────────────────
        // Re-check every vehicle we just dispatched: did it actually land on
        // THIS mission immediately, or did the game queue it as a follow-up
        // for later? If it didn't land immediately, stop trusting it as
        // committed so the next batch tries a different vehicle instead of
        // assuming the slot is filled.
        if (verifyQueue.length && isRunning) {
            await sleep(2000); // give the game a moment to settle
            try {
                const recheck = await fetchVehicles();
                const recheckById = new Map(recheck.map((v) => [v.id, v]));

                for (const rec of verifyQueue) {
                    const flagged = [];
                    for (const id of rec.ids) {
                        const v = recheckById.get(id);
                        const landedImmediately = v && v.target_type === 'mission' && v.target_id === rec.mid;
                        if (!landedImmediately) flagged.push({ id, v });
                    }
                    if (!flagged.length) continue;

                    const track = missionTrack[rec.sig];
                    if (track) flagged.forEach((f) => track.delete(f.id));

                    flagged.forEach((f) => {
                        const vv = f.v;
                        const desc = vv
                            ? `${vv.caption || f.id} (now target=${vv.target_type || 'none'}/${vv.target_id ?? '-'}, queued=${vv.queued_mission_id ?? '-'})`
                            : `vehicle ${f.id} (not found on recheck)`;
                        log(`  WARN  ${rec.name} [type ${rec.mtid}] -> ${desc} did NOT land immediately — treating as not dispatched`);
                    });

                    const confirmedCount = rec.ids.length - flagged.length;
                    const totalMissing = rec.unfilledAtDispatch + flagged.length;
                    upsertMissionRow(
                        rec.rowKey, rec.name,
                        confirmedCount > 0 ? `Dispatched (${confirmedCount}), Missing ${totalMissing}` : `Missing ${totalMissing}`,
                        confirmedCount > 0 ? 'missing' : 'noUnits'
                    );
                }
            } catch (e) {
                log(`Network error during dispatch verification: ${e.message}`);
            }
        }

        removeStaleMissionRows(processedKeys);
        log(`Batch complete — dispatched to ${dispatchedCount} mission(s).`);
    }

    // ── Control loop ──────────────────────────────────────────────────────
    async function mainLoop() {
        log('Loading mission type definitions (einsaetze.json)...');
        try {
            state.einsaetze = await fetchEinsaetze();
            log(`  Loaded ${Object.keys(state.einsaetze).length} mission types.`);
        } catch (e) {
            log(`  WARNING: could not load einsaetze.json (${e.message}). Auto-cache disabled this session.`);
            state.einsaetze = {};
        }

        log('Loading station locations...');
        try {
            state.buildingCoords = await fetchBuildingCoords();
            log(`  Loaded ${Object.keys(state.buildingCoords).length} stations.`);
        } catch (e) {
            log(`  WARNING: could not load buildings (${e.message}).`);
            state.buildingCoords = {};
        }

        state.links = getLinks();
        if (!Object.keys(state.links).length) {
            log('  WARNING: no vehicle class links loaded. Use "Import Cache" to load your links.json first.');
        }

        let batchNum = 1;
        while (isRunning) {
            log(`-- Batch #${batchNum} --`);
            setTimerText('Fetching missions & vehicles...');
            await runBatch();

            if (!isRunning) break;
            try {
                setTimerText('Running transport passes...');
                const freshVehicles = await fetchVehicles();
                await runTransportPass(freshVehicles);
                if (!isRunning) break;
                await runPrisonerTransportPass(freshVehicles);
            } catch (e) {
                log(`Network error during transport pass: ${e.message}`);
            }

            if (!isRunning) break;
            log(`Sleeping ${CONFIG.sleepPerBatchMs / 1000}s before next batch...`);
            await sleepWithCountdown(CONFIG.sleepPerBatchMs);
            batchNum++;
        }
        setTimerText('Stopped');
        log('Stopped.');
    }

    function start() {
        if (isRunning) return;
        isRunning = true;
        updateStatus();
        mainLoop();
    }
    function stop() {
        isRunning = false;
        updateStatus();
        setTimerText('Stopped');
    }

    // ── UI panel ──────────────────────────────────────────────────────────
    let rowsContainer, statusEl, panelEl, timerEl;

    function updateStatus() {
        if (!statusEl) return;
        statusEl.textContent = isRunning ? 'RUNNING' : 'STOPPED';
        statusEl.style.color = isRunning ? '#7fffa0' : '#ffd1d1';
    }

    function setTimerText(text) {
        if (!timerEl) return;
        timerEl.textContent = text;
    }

    function getSavedRect() {
        const raw = GM_getValue('mc_panel_rect', null);
        return raw ? JSON.parse(raw) : null;
    }
    function saveRect() {
        if (!panelEl) return;
        const r = panelEl.getBoundingClientRect();
        GM_setValue('mc_panel_rect', JSON.stringify({
            left: r.left, top: r.top, width: r.width, height: r.height,
        }));
    }

    // Light/dark palettes applied as CSS custom properties on the panel root.
    // Custom properties are the one thing the "all: unset/initial" isolation
    // trick doesn't reset, so this is what lets every themed element update
    // live without rebuilding the panel's HTML.
    const THEMES = {
        light: {
            bg: '#fff', border: '#b5b5b5', text: '#222', subtext: '#888',
            toolbarBg: '#f7f7f7', toolbarBorder: '#ddd',
            timerBg: '#f2f2f2', timerBorder: '#ddd', timerText: '#555',
            btnBg: '#f2f2f2', btnText: '#333', btnBorder: '#c8c8c8',
            rowBorder: '#eee', listRowBg: '#f7f7f7', listRowBorder: '#e5e5e5',
            inputBg: '#fff', inputBorder: '#c8c8c8',
        },
        dark: {
            bg: '#1e1e1e', border: '#444', text: '#eee', subtext: '#999',
            toolbarBg: '#2a2a2a', toolbarBorder: '#444',
            timerBg: '#2a2a2a', timerBorder: '#444', timerText: '#aaa',
            btnBg: '#333', btnText: '#eee', btnBorder: '#555',
            rowBorder: '#333', listRowBg: '#2a2a2a', listRowBorder: '#444',
            inputBg: '#2a2a2a', inputBorder: '#555',
        },
    };
    function applyTheme(dark) {
        if (!panelEl) return;
        const t = dark ? THEMES.dark : THEMES.light;
        for (const [k, v] of Object.entries(t)) {
            panelEl.style.setProperty(`--mc-${k}`, v);
        }
    }

    function buildPanel() {
        const panel = document.createElement('div');
        panelEl = panel;

        const saved = getSavedRect();
        const defaultWidth = 340;
        const defaultHeight = 300;
        const left = saved ? saved.left : (window.innerWidth - defaultWidth - 20);
        const top = saved ? saved.top : (window.innerHeight - defaultHeight - 20);
        const width = saved ? saved.width : defaultWidth;
        const height = saved ? saved.height : defaultHeight;

        // MissionChief-styled theme: red header bar, white body, gray toolbar
        // buttons — matches the site's own panel styling instead of a generic
        // dev-tool look. "all: initial/unset" keeps the host page's CSS from
        // overriding button text/colors (that was the earlier invisible-button bug).
        panel.style.cssText = `
            all: initial; position: fixed; left: ${left}px; top: ${top}px;
            width: ${width}px; height: ${height}px; min-width: 260px; min-height: 220px;
            display: flex; flex-direction: column;
            background: var(--mc-bg); border: 1px solid var(--mc-border); border-radius: 5px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.35); z-index: 999999;
            font-family: Arial, Helvetica, sans-serif; overflow: hidden;
        `;

        const btnStyle = `
            all: unset; box-sizing: border-box; flex: 1; text-align: center;
            background: var(--mc-btn-bg); color: var(--mc-btn-text); border: 1px solid var(--mc-btn-border);
            border-radius: 3px; padding: 5px 4px; cursor: pointer;
            font: 12px/1.2 Arial, Helvetica, sans-serif; user-select: none;
        `;

        panel.innerHTML = `
            <div id="mc-header" style="all:unset; display:flex; justify-content:space-between; align-items:center;
                 padding:6px 10px; background:linear-gradient(#e0483a,#c0392b); color:#fff;
                 font:bold 13px/1.3 Arial, Helvetica, sans-serif; cursor:move; user-select:none; flex-shrink:0;">
                <span style="color:#fff;">MC Auto-Dispatch v2</span>
                <span id="mc-status" style="font-weight:bold; color:#ffd1d1;">STOPPED</span>
            </div>
            <div style="all:unset; display:flex; gap:6px; padding:8px; box-sizing:border-box; width:100%; background:var(--mc-toolbar-bg); border-bottom:1px solid var(--mc-toolbar-border); flex-shrink:0;">
                <button id="mc-start" style="${btnStyle}">Start</button>
                <button id="mc-stop" style="${btnStyle}">Stop</button>
                <button id="mc-import" style="${btnStyle}">Import Cache</button>
                <button id="mc-settings-btn" style="${btnStyle}">Settings</button>
            </div>
            <div id="mc-rows" style="all:unset; display:block; box-sizing:border-box; width:100%;
                 flex: 1 1 auto; min-height: 60px; background:var(--mc-bg); overflow-y:auto;"></div>
            <div id="mc-timer" style="all:unset; display:block; box-sizing:border-box; width:100%;
                 padding:5px 10px; background:var(--mc-timer-bg); border-top:1px solid var(--mc-timer-border); color:var(--mc-timer-text);
                 font:11px/1.3 Arial, Helvetica, sans-serif; text-align:center; flex-shrink:0;">Idle</div>
            <div id="mc-resize" title="Drag to resize" style="position:absolute; right:2px; bottom:2px; width:14px; height:14px;
                 cursor: nwse-resize; background:
                 linear-gradient(135deg, transparent 0%, transparent 40%, #999 40%, #999 46%, transparent 46%,
                 transparent 60%, #999 60%, #999 66%, transparent 66%, transparent 80%, #999 80%, #999 86%, transparent 86%);"></div>
            <input type="file" id="mc-file-input" multiple accept=".json" style="display:none;">

            <div id="mc-settings-overlay" style="all:unset; position:absolute; inset:0; display:none;
                 flex-direction:column; background:var(--mc-bg); z-index:10; font-family:Arial, Helvetica, sans-serif;">
                <div style="all:unset; display:flex; justify-content:space-between; align-items:center;
                     padding:6px 10px; background:linear-gradient(#e0483a,#c0392b); color:#fff;
                     font:bold 13px/1.3 Arial, Helvetica, sans-serif; flex-shrink:0;">
                    <span style="color:#fff;">Settings</span>
                    <span id="mc-settings-close" style="cursor:pointer; color:#fff; font-weight:bold; padding:0 6px; font-size:16px; line-height:1;">&times;</span>
                </div>
                <div style="all:unset; display:block; padding:14px; overflow-y:auto; flex:1 1 auto; box-sizing:border-box; width:100%;">
                    <div style="all:unset; display:flex; gap:8px; margin-bottom:16px;">
                        <button id="mc-view-log-btn" style="${btnStyle} flex:1;">View Console Log</button>
                    </div>
                    <label style="all:unset; display:flex; align-items:flex-start; gap:8px; margin-bottom:16px; cursor:pointer; color:var(--mc-text); font:12px/1.4 Arial, Helvetica, sans-serif;">
                        <input type="checkbox" id="mc-setting-darkmode" style="all:revert; margin-top:2px; flex-shrink:0;">
                        <span>Dark Mode<br><span style="color:var(--mc-subtext); font-size:11px;">Switches the panel to a dark theme.</span></span>
                    </label>
                    <label style="all:unset; display:flex; align-items:flex-start; gap:8px; margin-bottom:16px; cursor:pointer; color:var(--mc-text); font:12px/1.4 Arial, Helvetica, sans-serif;">
                        <input type="checkbox" id="mc-setting-alliance" style="all:revert; margin-top:2px; flex-shrink:0;">
                        <span>Dispatch to Alliance Calls<br><span style="color:var(--mc-subtext); font-size:11px;">Include missions belonging to your alliance, not just your own department.</span></span>
                    </label>
                    <label style="all:unset; display:flex; align-items:flex-start; gap:8px; cursor:pointer; color:var(--mc-text); font:12px/1.4 Arial, Helvetica, sans-serif;">
                        <input type="checkbox" id="mc-setting-scheduled" style="all:revert; margin-top:2px; flex-shrink:0;">
                        <span>Dispatch to Scheduled/Special Calls<br><span style="color:var(--mc-subtext); font-size:11px;">Fire alarms, exercises, speed traps, drills, inspections, and similar events.</span></span>
                    </label>
                    <label style="all:unset; display:flex; align-items:flex-start; gap:8px; margin-top:16px; cursor:pointer; color:var(--mc-text); font:12px/1.4 Arial, Helvetica, sans-serif;">
                        <input type="checkbox" id="mc-setting-reassign" style="all:revert; margin-top:2px; flex-shrink:0;">
                        <span>Reassign to Closer Units <span style="color:#c62828; font-weight:bold;">(experimental)</span><br><span style="color:var(--mc-subtext); font-size:11px;">Recalls an en-route unit if a confirmed closer one becomes available, freeing it to be redispatched next batch. Never touches units already on scene. Uses an unofficially-confirmed cancel endpoint — watch the console log closely after enabling.</span></span>
                    </label>

                    <div style="all:unset; display:block; margin-top:20px; padding-top:14px; border-top:1px solid var(--mc-row-border);">
                        <div style="all:unset; display:block; font-weight:bold; color:var(--mc-text); margin-bottom:4px;">Task Forces</div>
                        <div style="all:unset; display:block; color:var(--mc-subtext); font-size:11px; margin-bottom:10px;">
                            Vehicles that should always be dispatched together. When any member is sent to a call, the others go too if available.
                        </div>
                        <div id="mc-taskforce-list" style="all:unset; display:block; margin-bottom:10px;"></div>
                        <input type="text" id="mc-taskforce-name-input" placeholder="Task force name (e.g. Truck Company 4)"
                               style="all:revert; box-sizing:border-box; width:100%; padding:5px 6px; border:1px solid var(--mc-input-border); border-radius:3px; font:12px Arial, Helvetica, sans-serif; margin-bottom:6px; background:var(--mc-input-bg); color:var(--mc-text);">
                        <div style="all:unset; display:flex; gap:6px;">
                            <input type="text" id="mc-taskforce-input" placeholder="PSF - Engine 4, PSF - Ladder 1"
                                   style="all:revert; flex:1 1 auto; box-sizing:border-box; padding:5px 6px; border:1px solid var(--mc-input-border); border-radius:3px; font:12px Arial, Helvetica, sans-serif; background:var(--mc-input-bg); color:var(--mc-text);">
                            <button id="mc-taskforce-add" style="${btnStyle} flex:0 0 auto; width:56px;">Add</button>
                        </div>
                    </div>
                </div>

                <div id="mc-log-overlay" style="all:unset; position:absolute; inset:0; display:none;
                     flex-direction:column; background:var(--mc-bg); z-index:11; font-family:Arial, Helvetica, sans-serif;">
                    <div style="all:unset; display:flex; justify-content:space-between; align-items:center;
                         padding:6px 10px; background:linear-gradient(#e0483a,#c0392b); color:#fff;
                         font:bold 13px/1.3 Arial, Helvetica, sans-serif; flex-shrink:0;">
                        <span style="color:#fff;">Console Log</span>
                        <span id="mc-log-close" style="cursor:pointer; color:#fff; font-weight:bold; padding:0 6px; font-size:16px; line-height:1;">&times;</span>
                    </div>
                    <pre id="mc-log-content" style="all:unset; display:block; box-sizing:border-box; width:100%; flex:1 1 auto;
                         margin:0; padding:8px; overflow-y:auto; background:#111; color:#8fd68f; font:11px/1.4 'Consolas','Courier New',monospace;
                         white-space:pre-wrap; word-break:break-word;"></pre>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        applyTheme(getSettings().darkMode);

        rowsContainer = panel.querySelector('#mc-rows');
        statusEl = panel.querySelector('#mc-status');
        timerEl = panel.querySelector('#mc-timer');

        panel.querySelector('#mc-start').addEventListener('click', start);
        panel.querySelector('#mc-stop').addEventListener('click', stop);

        const fileInput = panel.querySelector('#mc-file-input');
        panel.querySelector('#mc-import').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', handleImport);

        setupSettingsPanel(panel);

        setupDragging(panel, panel.querySelector('#mc-header'));
        setupResizing(panel, panel.querySelector('#mc-resize'));
        setupPopupWatcher(panel);
    }

    function setupSettingsPanel(panel) {
        const overlay = panel.querySelector('#mc-settings-overlay');
        const allianceCheckbox = panel.querySelector('#mc-setting-alliance');
        const scheduledCheckbox = panel.querySelector('#mc-setting-scheduled');
        const reassignCheckbox = panel.querySelector('#mc-setting-reassign');
        const darkModeCheckbox = panel.querySelector('#mc-setting-darkmode');
        const logOverlay = panel.querySelector('#mc-log-overlay');
        const logContent = panel.querySelector('#mc-log-content');
        let logRefreshInterval = null;
        const taskforceList = panel.querySelector('#mc-taskforce-list');
        const taskforceNameInput = panel.querySelector('#mc-taskforce-name-input');
        const taskforceInput = panel.querySelector('#mc-taskforce-input');

        function renderTaskForces() {
            const groups = getTaskForces();
            taskforceList.innerHTML = '';
            if (!groups.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'all:unset; display:block; color:var(--mc-subtext); font-size:11px; font-style:italic;';
                empty.textContent = 'No task forces yet.';
                taskforceList.appendChild(empty);
                return;
            }
            groups.forEach((group, idx) => {
                const row = document.createElement('div');
                row.style.cssText = `
                    all:unset; display:flex; align-items:center; justify-content:space-between; gap:8px;
                    padding:5px 8px; margin-bottom:4px; background:var(--mc-list-row-bg); border:1px solid var(--mc-list-row-border);
                    border-radius:3px; font-size:11px; color:var(--mc-text);
                `;
                const label = document.createElement('span');
                label.innerHTML = '';
                label.style.cssText = 'all:unset; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                const nameSpan = document.createElement('span');
                nameSpan.textContent = group.name;
                nameSpan.style.cssText = 'all:unset; font-weight:bold; color:var(--mc-text);';
                const membersSpan = document.createElement('span');
                membersSpan.textContent = `: ${group.members.join(' + ')}`;
                membersSpan.style.cssText = 'all:unset; color:var(--mc-subtext);';
                label.appendChild(nameSpan);
                label.appendChild(membersSpan);
                const removeBtn = document.createElement('span');
                removeBtn.textContent = '×';
                removeBtn.title = 'Remove';
                removeBtn.style.cssText = 'all:unset; cursor:pointer; color:#c62828; font-weight:bold; padding:0 4px; flex-shrink:0;';
                removeBtn.addEventListener('click', () => {
                    const current = getTaskForces();
                    current.splice(idx, 1);
                    setTaskForces(current);
                    renderTaskForces();
                });
                row.appendChild(label);
                row.appendChild(removeBtn);
                taskforceList.appendChild(row);
            });
        }

        function addTaskForce() {
            const members = taskforceInput.value
                .split(',')
                .map((n) => n.trim())
                .filter(Boolean);
            if (members.length < 2) {
                log('Task force needs at least 2 vehicle names, comma-separated.');
                return;
            }
            const groups = getTaskForces();
            const typedName = taskforceNameInput.value.trim();
            const name = typedName || `Task Force ${groups.length + 1}`;
            groups.push({ name, members });
            setTaskForces(groups);
            taskforceNameInput.value = '';
            taskforceInput.value = '';
            renderTaskForces();
        }

        function openSettings() {
            const s = getSettings();
            allianceCheckbox.checked = s.dispatchAllianceCalls;
            scheduledCheckbox.checked = s.dispatchScheduledCalls;
            reassignCheckbox.checked = s.reassignCloserUnits;
            darkModeCheckbox.checked = s.darkMode;
            renderTaskForces();
            overlay.style.display = 'flex';
        }
        function closeSettings() {
            overlay.style.display = 'none';
        }

        function refreshLogContent() {
            logContent.textContent = logBuffer.join('\n');
            logContent.scrollTop = logContent.scrollHeight;
        }
        function openLogViewer() {
            refreshLogContent();
            logOverlay.style.display = 'flex';
            logRefreshInterval = setInterval(refreshLogContent, 1000);
        }
        function closeLogViewer() {
            logOverlay.style.display = 'none';
            if (logRefreshInterval) { clearInterval(logRefreshInterval); logRefreshInterval = null; }
        }

        panel.querySelector('#mc-settings-btn').addEventListener('click', openSettings);
        panel.querySelector('#mc-settings-close').addEventListener('click', closeSettings);
        panel.querySelector('#mc-view-log-btn').addEventListener('click', openLogViewer);
        panel.querySelector('#mc-log-close').addEventListener('click', closeLogViewer);
        panel.querySelector('#mc-taskforce-add').addEventListener('click', addTaskForce);
        taskforceNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addTaskForce();
        });
        taskforceInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addTaskForce();
        });

        // Saved immediately on change — takes effect on the next batch,
        // no separate save step needed.
        allianceCheckbox.addEventListener('change', () => {
            const s = getSettings();
            s.dispatchAllianceCalls = allianceCheckbox.checked;
            setSettings(s);
            log(`Setting changed: Dispatch to Alliance Calls = ${s.dispatchAllianceCalls}`);
        });
        scheduledCheckbox.addEventListener('change', () => {
            const s = getSettings();
            s.dispatchScheduledCalls = scheduledCheckbox.checked;
            setSettings(s);
            log(`Setting changed: Dispatch to Scheduled/Special Calls = ${s.dispatchScheduledCalls}`);
        });
        reassignCheckbox.addEventListener('change', () => {
            const s = getSettings();
            s.reassignCloserUnits = reassignCheckbox.checked;
            setSettings(s);
            log(`Setting changed: Reassign to Closer Units = ${s.reassignCloserUnits}`);
        });
        darkModeCheckbox.addEventListener('change', () => {
            const s = getSettings();
            s.darkMode = darkModeCheckbox.checked;
            setSettings(s);
            applyTheme(s.darkMode);
            log(`Setting changed: Dark Mode = ${s.darkMode}`);
        });
    }

    // MissionChief's popups (station/vehicle detail pages, etc.) render inside
    // an iframe overlaying the page. Since our panel is position:fixed with a
    // high z-index, it would otherwise always sit on top of that popup. Rather
    // than guess at the popup's exact markup, track how many iframes exist on
    // page load as a baseline — any iframe count ABOVE that baseline means a
    // popup opened, so we hide the panel until the count drops back down.
    function setupPopupWatcher(panel) {
        const baselineIframeCount = document.querySelectorAll('iframe').length;
        let hidden = false;

        function sync() {
            const extra = document.querySelectorAll('iframe').length > baselineIframeCount;
            if (extra && !hidden) {
                panel.style.display = 'none';
                hidden = true;
            } else if (!extra && hidden) {
                panel.style.display = 'flex';
                hidden = false;
            }
        }

        const observer = new MutationObserver(sync);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function setupDragging(panel, handle) {
        let dragging = false;
        let startX, startY, startLeft, startTop;

        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const r = panel.getBoundingClientRect();
            startLeft = r.left;
            startTop = r.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newLeft = startLeft + dx;
            let newTop = startTop + dy;
            newLeft = Math.max(0, Math.min(window.innerWidth - 60, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));
            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            saveRect();
        });
    }

    function setupResizing(panel, handle) {
        let resizing = false;
        let startX, startY, startWidth, startHeight;

        handle.addEventListener('mousedown', (e) => {
            resizing = true;
            startX = e.clientX;
            startY = e.clientY;
            const r = panel.getBoundingClientRect();
            startWidth = r.width;
            startHeight = r.height;
            e.preventDefault();
            e.stopPropagation();
        });

        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const newWidth = Math.max(260, startWidth + (e.clientX - startX));
            const newHeight = Math.max(220, startHeight + (e.clientY - startY));
            panel.style.width = `${newWidth}px`;
            panel.style.height = `${newHeight}px`;
        });

        document.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            saveRect();
        });
    }

    // Import your existing links.json and any mission-type cache files
    // (e.g. 798.json) — select them all at once via the file picker.
    async function handleImport(e) {
        const files = Array.from(e.target.files || []);
        let linksImported = 0;
        let missionsImported = 0;
        const links = getLinks();
        const missionReqs = getMissionReqs();

        for (const file of files) {
            try {
                const text = await file.text();
                const data = JSON.parse(text);

                if (data && data.missionId && data.requirements) {
                    missionReqs[String(data.missionId)] = data;
                    missionsImported++;
                } else if (data && typeof data === 'object' && !Array.isArray(data)) {
                    const looksLikeLinks = Object.values(data).every((v) => Array.isArray(v));
                    if (looksLikeLinks) {
                        Object.assign(links, data);
                        linksImported = Object.keys(data).length;
                    }
                }
            } catch (err) {
                log(`Import error on ${file.name}: ${err.message}`);
            }
        }

        setLinks(links);
        setMissionReqs(missionReqs);
        state.links = links;
        log(`Import complete — ${linksImported} vehicle class link(s), ${missionsImported} mission type file(s) added to cache.`);
    }

    // ── Init ──────────────────────────────────────────────────────────────
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        buildPanel();
    } else {
        window.addEventListener('DOMContentLoaded', buildPanel);
    }
})();
