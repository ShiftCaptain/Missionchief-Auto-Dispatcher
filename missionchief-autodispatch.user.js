// ==UserScript==
// @name         MissionChief Auto-Dispatch v2
// @namespace    shiftcaptain.missionchief
// @version      0.2.0
// @description  Delta-based auto-dispatch (tops up partial/upgraded missions instead of abandoning them). Runs in-tab, no login handling needed.
// @match        https://www.missionchief.com/*
// @match        https://*.missionchief.com/*
// @match        https://*.leitstellenspiel.de/*
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
        showOwn: true,
    };

    // ── Utilities ─────────────────────────────────────────────────────────
    function log(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        console.log(line);
        appendToPanelLog(line);
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
        let missions = Array.isArray(data)
            ? data
            : (data.missions || data.result || Object.values(data)[0] || []);
        if (CONFIG.showOwn) {
            missions = missions.filter((m) => !m.alliance_id && !m.is_alliance);
        }
        return missions;
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
    const AVAILABLE_STATES = new Set([1, 2]);

    function getAvailableVehicles(vehicles) {
        return vehicles.filter((v) => AVAILABLE_STATES.has(v.fms_real ?? v.fms_show));
    }

    // Counts vehicles CURRENTLY assigned to this mission via target_type/target_id —
    // the real source of truth, confirmed against live vehicle data. This is what
    // replaces the old "skip mission if vehicle_state != 0" behavior that caused
    // partial dispatches and upgrades to get silently abandoned.
    function getAssignedVehicleCounts(missionId, vehicles) {
        const counts = {};
        for (const v of vehicles) {
            if (v.target_type === 'mission' && v.target_id === missionId) {
                counts[v.vehicle_type] = (counts[v.vehicle_type] || 0) + 1;
            }
        }
        return counts;
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

    function nearestVehicleForSlot(available, acceptableTypes, missionLat, missionLon, usedIds, buildingCoords) {
        const candidates = available.filter((v) => !usedIds.has(v.id) && acceptableTypes.includes(v.vehicle_type));
        if (!candidates.length) return null;
        let best = null;
        let bestDist = Infinity;
        for (const v of candidates) {
            const [lat, lon] = buildingCoords[v.building_id] || [0, 0];
            const d = haversineKm(lat, lon, missionLat, missionLon);
            if (d < bestDist) { bestDist = d; best = v; }
        }
        return best;
    }

    // ── Main batch ────────────────────────────────────────────────────────
    const state = { links: {}, einsaetze: {}, buildingCoords: {} };
    let isRunning = false;

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

        let dispatchedCount = 0;
        const usedIds = new Set();

        for (const mission of missions) {
            if (!isRunning) break;

            const name = mission.caption || `Mission #${mission.id}`;
            const mlat = mission.latitude || 0;
            const mlon = mission.longitude || 0;
            const mid = mission.id;
            const mtid = String(mission.mtid ?? mission.mission_type_id ?? '');

            let entry = missionReqs[mtid];
            if (!mtid || !entry) {
                if (mtid && state.einsaetze[mtid]) {
                    entry = buildCacheEntry(mtid, state.einsaetze, state.links);
                    if (!entry) {
                        log(`  SKIP  ${name} [type ${mtid}] (unknown mission type)`);
                        continue;
                    }
                } else {
                    log(`  SKIP  ${name} [type ${mtid}] (not in cache)`);
                    continue;
                }
            }

            // Delta: what's already assigned to THIS mission, per vehicle type
            const assignedCounts = getAssignedVehicleCounts(mid, vehicles);
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

            const totalRequired = (entry.requirements || []).reduce((s, r) => s + parseInt(r.qty, 10), 0);
            if (totalRequired === 0 && !patients) {
                // No-requirement mission type — dispatch empty once.
                // vehicle_state is safe to use ONLY here as a one-time marker,
                // since there's nothing to ever top up on a no-req mission.
                if ((mission.vehicle_state || 0) !== 0) continue;
                const success = await dispatchVehicles(mid, []);
                log(success
                    ? `  SENT  ${name} [type ${mtid}] -> 0 vehicle(s) (no requirements)`
                    : `  FAIL  ${name} [type ${mtid}] (dispatch error)`);
                if (success) dispatchedCount++;
                await sleep(CONFIG.dispatchDelayMs);
                continue;
            }

            if (!slots.length) {
                log(`  SKIP  ${name} [type ${mtid}] (fully staffed already)`);
                continue;
            }

            const selectedIds = [];
            let unfilled = 0;
            for (const acceptableTypes of slots) {
                const v = nearestVehicleForSlot(available, acceptableTypes, mlat, mlon, usedIds, state.buildingCoords);
                if (!v) { unfilled++; } else { selectedIds.push(v.id); usedIds.add(v.id); }
            }

            if (!selectedIds.length) {
                log(`  SKIP  ${name} [type ${mtid}] (no available vehicles)`);
                continue;
            }

            const success = await dispatchVehicles(mid, selectedIds);
            if (success) {
                log(unfilled > 0
                    ? `  PART  ${name} [type ${mtid}] -> ${selectedIds.length} vehicle(s) (${unfilled} slot(s) unfilled, will retry)`
                    : `  SENT  ${name} [type ${mtid}] -> ${selectedIds.length} vehicle(s)`);
                dispatchedCount++;
            } else {
                log(`  FAIL  ${name} [type ${mtid}] (dispatch error)`);
            }

            await sleep(CONFIG.dispatchDelayMs);
        }

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
            await runBatch();

            if (!isRunning) break;
            try {
                const freshVehicles = await fetchVehicles();
                await runTransportPass(freshVehicles);
                if (!isRunning) break;
                await runPrisonerTransportPass(freshVehicles);
            } catch (e) {
                log(`Network error during transport pass: ${e.message}`);
            }

            if (!isRunning) break;
            log(`Sleeping ${CONFIG.sleepPerBatchMs / 1000}s before next batch...`);
            await sleep(CONFIG.sleepPerBatchMs);
            batchNum++;
        }
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
    }

    // ── UI panel ──────────────────────────────────────────────────────────
    let logEl, statusEl, panelEl;

    function appendToPanelLog(line) {
        if (!logEl) return;
        logEl.textContent += line + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }

    function updateStatus() {
        if (!statusEl) return;
        statusEl.textContent = isRunning ? 'RUNNING' : 'STOPPED';
        statusEl.style.color = isRunning ? '#7fffa0' : '#ffd1d1';
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
            background: #fff; border: 1px solid #b5b5b5; border-radius: 5px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.35); z-index: 999999;
            font-family: Arial, Helvetica, sans-serif; overflow: hidden;
        `;

        const btnStyle = `
            all: unset; box-sizing: border-box; flex: 1; text-align: center;
            background: #f2f2f2; color: #333; border: 1px solid #c8c8c8;
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
            <div style="all:unset; display:flex; gap:6px; padding:8px; box-sizing:border-box; width:100%; background:#f7f7f7; border-bottom:1px solid #ddd; flex-shrink:0;">
                <button id="mc-start" style="${btnStyle}">Start</button>
                <button id="mc-stop" style="${btnStyle}">Stop</button>
                <button id="mc-import" style="${btnStyle}">Import Cache</button>
            </div>
            <textarea id="mc-log" readonly style="all:unset; display:block; box-sizing:border-box; width:100%;
                 flex: 1 1 auto; min-height: 60px; background:#181818; color:#8fd68f; border:none;
                 padding:8px; resize:none; font:11px/1.4 'Consolas','Courier New',monospace; white-space:pre-wrap; overflow-y:auto;"></textarea>
            <div id="mc-resize" title="Drag to resize" style="position:absolute; right:2px; bottom:2px; width:14px; height:14px;
                 cursor: nwse-resize; background:
                 linear-gradient(135deg, transparent 0%, transparent 40%, #999 40%, #999 46%, transparent 46%,
                 transparent 60%, #999 60%, #999 66%, transparent 66%, transparent 80%, #999 80%, #999 86%, transparent 86%);"></div>
            <input type="file" id="mc-file-input" multiple accept=".json" style="display:none;">
        `;
        document.body.appendChild(panel);

        logEl = panel.querySelector('#mc-log');
        statusEl = panel.querySelector('#mc-status');

        panel.querySelector('#mc-start').addEventListener('click', start);
        panel.querySelector('#mc-stop').addEventListener('click', stop);

        const fileInput = panel.querySelector('#mc-file-input');
        panel.querySelector('#mc-import').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', handleImport);

        setupDragging(panel, panel.querySelector('#mc-header'));
        setupResizing(panel, panel.querySelector('#mc-resize'));
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
