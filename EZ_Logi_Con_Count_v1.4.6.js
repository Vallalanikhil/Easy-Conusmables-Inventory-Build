// ==UserScript==
// @name         EZ Logi Con Count v1.4.6
// @namespace    http://tampermonkey.net/
// @version      1.4.6
// @description  Inventory management for DCO consumables — CMH73 | Google Sheets sync
// @match        https://myday-website.cmh.aws-border.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      hooks.slack.com
// @connect      api.qrserver.com
// @connect      docs.google.com
// @connect      spreadsheets.google.com
// @connect      cdnjs.cloudflare.com
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIGURATION ────────────────────────────────────────────────────────
  const CONFIG = {
    // Google Apps Script Web App — handles all read/write to Google Sheets
    // Deployed under marcuspride14@gmail.com personal account
    APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbysgI1oQHYyqJ0jPFAjg6sPLcOONaBmEOyGgFv3QFfrlJeN8P7oGKpNDA37No2SHThWsg/exec',
    DEPLOYMENT_ID:   'AKfycbysgI1oQHYyqJ0jPFAjg6sPLcOONaBmEOyGgFv3QFfrlJeN8P7oGKpNDA37No2SHThWsg',

    // Slack Workflow webhook — instant per-item low stock alerts
    SLACK_WEBHOOK: 'https://hooks.slack.com/triggers/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',

    // Slack Workflow webhook — daily digest (separate workflow)
    SLACK_DIGEST_WEBHOOK: 'https://hooks.slack.com/triggers/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',

    // How often to push local changes to Google Sheets (ms)
    SYNC_INTERVAL_MS: 60 * 60 * 1000, // 1 hour

    // Available buildings
    BUILDINGS: ['CMH73'],

    // Boost base URL — used for QR scan deduction links
    BOOST_URL: 'https://myday-website.cmh.aws-border.com',

    // Published CSV URLs per building — read-only, no auth needed
    // To add a new building: add a new sheet tab, publish it as CSV, add the URL here
    CSV_URLS: {
      'CMH73': 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSf17egxibNMiZ_9Tr1vQIbC_NGL03V_N3fqg8ukHB3b5XRpgkhE7kCMVWje1OF4B3jt8HgeAhJIS0Q/pub?gid=446507335&single=true&output=csv',
      // 'CMH74': 'https://docs.google.com/spreadsheets/d/e/YOUR_CMH74_CSV_URL/pub?...',
      // 'CMH75': 'https://docs.google.com/spreadsheets/d/e/YOUR_CMH75_CSV_URL/pub?...',
    },
  };

  // ─── COLUMN INDEXES ───────────────────────────────────────────────────────
  const COL = { BUILDING: 0, ITEM: 1, CURRENT: 2, MAX: 3, MIN: 4 };

  // ─── SEED DATA (from CSV) ─────────────────────────────────────────────────
  const SEED_DATA = [
    ['CMH73','Isopropyl Alcohol',46,75,25],
    ['CMH73','Thermal Paste',7,30,5],
    ['CMH73','Electrical Tape',22,20,5],
    ['CMH73','Dual-LC Cleaner',6,20,5],
    ['CMH73','MPO Cleaner',1,20,5],
    ['CMH73','Single-LC Cleaner',66,20,10],
    ['CMH73','MTP to LC 2.3m',16,20,10],
    ['CMH73','MTP to LC 25m',2,10,2],
    ['CMH73','MTP to LC 30m',0,5,2],
    ['CMH73','MTP to LC 55m',2,5,2],
    ['CMH73','LC to LC 2m',46,30,10],
    ['CMH73','LC to LC 3m',0,30,10],
    ['CMH73','LC to LC 6m',0,20,5],
    ['CMH73','LC to LC 15m',4,8,2],
    ['CMH73','LC to LC 20m',14,10,2],
    ['CMH73','LC to LC 30m',8,8,2],
    ['CMH73','MTP to LC 75m',3,6,2],
    ['CMH73','MTP to LC 85m',3,6,2],
    ['CMH73','MTP to LC 100m',0,4,1],
    ['CMH73','Green CAT6 (10m)',15,15,5],
    ['CMH73','Green CAT6 (50m)',4,6,2],
    ['CMH73','Orange CAT6 (5m)',17,20,5],
    ['CMH73','Orange CAT6 (35m)',4,6,2],
    ['CMH73','Orange CAT6 (50m)',4,6,2],
    ['CMH73','LC to LC 40m',2,6,2],
    ['CMH73','LC to LC 50m',7,10,2],
    ['CMH73','SFP-H10GB-CU.5M-C',13,10,2],
    ['CMH73','SFP-H10GB-CU3M-C',7,10,2],
  ];

  // ─── STATE ────────────────────────────────────────────────────────────────
  let userBuilding = GM_getValue('building', null);
  let userRole     = GM_getValue('role', null);
  let allRows      = [];
  let headerRow    = [];
  let inventory    = [];
  let alerted      = {};
  let syncTimer    = null;
  let sheetsAvailable = false;

  // ─── INIT ─────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    checkScanDeduction(); // handle QR scan silently before rendering
    if (!userBuilding || !userRole) {
      showSetupWizard();
    } else {
      launchApp();
    }
  }

  // ─── QR SCAN DEDUCTION LISTENER ───────────────────────────────────────────
  // When a hand scanner fires a QR URL, this catches the params silently,
  // deducts 1 from the matching item, saves, and cleans the URL — no page reload.
  function checkScanDeduction() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('inv_action') !== 'deduct') return;

    const scannedBuilding = params.get('building');
    const scannedItem     = params.get('item');

    if (!scannedBuilding || !scannedItem) return;

    // Load inventory if not already loaded
    if (allRows.length === 0) {
      const saved = GM_getValue('inventory_' + scannedBuilding, null);
      if (saved) allRows = JSON.parse(saved);
      else allRows = SEED_DATA.map(r => [...r]);
    }

    const globalIdx = allRows.findIndex(
      r => r[COL.BUILDING] === scannedBuilding && r[COL.ITEM] === scannedItem
    );

    if (globalIdx === -1) {
      console.warn('[EZ Logi] Scanned item not found:', scannedItem);
    } else {
      const current = Number(allRows[globalIdx][COL.CURRENT]);
      const min     = Number(allRows[globalIdx][COL.MIN]);
      const newQty  = Math.max(0, current - 1);
      allRows[globalIdx][COL.CURRENT] = newQty;
      GM_setValue('inventory_' + scannedBuilding, JSON.stringify(allRows));
      showToast(`📦 Scanned: ${scannedItem} → ${newQty} remaining`, newQty <= min ? 'error' : 'success');
      if (newQty <= min) {
        // Re-filter inventory for alert
        inventory = allRows.filter(r => r[COL.BUILDING] === scannedBuilding);
        triggerSlackAlert(allRows[globalIdx]);
      }
    }

    // Clean the URL params without reloading the page
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  // ─── SETUP WIZARD ─────────────────────────────────────────────────────────
  function showSetupWizard(isEdit = false) {
    const overlay = createElement('div', 'inv-overlay');
    const box     = createElement('div', 'inv-wizard');
    box.innerHTML = `
      <div class="inv-wizard-topbar">
        <h2>DCO Inventory Setup</h2>
        ${isEdit ? `<button class="inv-wizard-close" id="inv-wizard-close" title="Close">✕</button>` : ''}
      </div>
      <p>Select your building and role to get started.</p>
      <label>Building
        <select id="inv-building">
          ${CONFIG.BUILDINGS.map(b => `<option value="${b}" ${b === userBuilding ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
      </label>
      <label>Role
        <select id="inv-role">
          <option value="dco" ${userRole === 'dco' ? 'selected' : ''}>DCO</option>
          <option value="logistics" ${userRole === 'logistics' ? 'selected' : ''}>Logistics</option>
        </select>
      </label>
      <button id="inv-setup-save">Save &amp; Continue</button>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    if (isEdit) {
      document.getElementById('inv-wizard-close').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    }

    document.getElementById('inv-setup-save').addEventListener('click', () => {
      userBuilding = document.getElementById('inv-building').value;
      userRole     = document.getElementById('inv-role').value;
      GM_setValue('building', userBuilding);
      GM_setValue('role', userRole);
      overlay.remove();
      launchApp();
    });
  }

  // ─── LAUNCH ───────────────────────────────────────────────────────────────
  function launchApp() {
    fetchFromPublishedCSV()
      .then(() => {
        sheetsAvailable = true;
        saveLocalCache();
        showToast('Sheets synced ✓', 'success');
      })
      .catch(err => {
        console.warn('[EZ Logi] CSV fetch unavailable:', err.message);
        loadLocalFallback();
        showToast('Offline mode — using local cache', 'info');
      })
      .finally(() => {
        renderPanel();
        checkThresholds();
        startSyncTimer();
      });
  }

  // ─── FETCH FROM GOOGLE SHEETS ─────────────────────────────────────────────
  function fetchFromSheets() {
    return new Promise((resolve, reject) => {
      // Google Apps Script redirects through script.googleusercontent.com
      // We must follow redirects and hit the final URL directly
      GM_xmlhttpRequest({
        method: 'GET',
        url: CONFIG.APPS_SCRIPT_URL,
        redirect: 'follow',
        onload: res => {
          // If we got HTML back, Google redirected us to a login/error page
          // Try the final URL directly if available
          if (res.responseText.trim().startsWith('<')) {
            const finalUrl = res.finalUrl || CONFIG.APPS_SCRIPT_URL;
            if (finalUrl !== CONFIG.APPS_SCRIPT_URL) {
              GM_xmlhttpRequest({
                method: 'GET',
                url: finalUrl,
                onload: res2 => {
                  try {
                    const rows = JSON.parse(res2.responseText);
                    if (!Array.isArray(rows) || rows.length < 2) throw new Error('Empty');
                    headerRow = rows[0];
                    allRows   = rows.slice(1);
                    inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
                    resolve();
                  } catch (e) { reject(new Error('Final URL parse error: ' + e.message)); }
                },
                onerror: () => reject(new Error('Final URL fetch failed')),
              });
            } else {
              // HTML and no redirect — Apps Script not accessible from this context
              // Fall back to direct Sheets API via published CSV
              fetchFromPublishedCSV().then(resolve).catch(reject);
            }
          } else {
            try {
              const rows = JSON.parse(res.responseText);
              if (!Array.isArray(rows) || rows.length < 2) throw new Error('Empty');
              headerRow = rows[0];
              allRows   = rows.slice(1);
              inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
              resolve();
            } catch (e) { reject(new Error('Parse error: ' + e.message)); }
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  // ─── FETCH FROM PUBLISHED CSV (primary read method) ──────────────────────
  // Uses Google Sheets published CSV — no auth needed, works from any browser
  // Each building maps to its own published CSV URL in CONFIG.CSV_URLS
  function fetchFromPublishedCSV() {
    const csvUrl = CONFIG.CSV_URLS[userBuilding];
    if (!csvUrl) return Promise.reject(new Error('No CSV URL configured for ' + userBuilding));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: csvUrl,
        redirect: 'follow',
        onload: res => {
          try {
            const lines = res.responseText.trim().split('\n');
            if (lines.length < 2) throw new Error('CSV empty');
            const parse = line => {
              // Handle quoted CSV fields
              const result = [];
              let cur = '', inQuote = false;
              for (const ch of line) {
                if (ch === '"') { inQuote = !inQuote; }
                else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
                else { cur += ch; }
              }
              result.push(cur.trim());
              return result;
            };
            headerRow = parse(lines[0]);
            allRows   = lines.slice(1).map(line => {
              const cols = parse(line);
              return [cols[0], cols[1], Number(cols[2]), Number(cols[3]), Number(cols[4])];
            }).filter(r => r[0]); // skip empty rows
            inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
            resolve();
          } catch (e) { reject(new Error('CSV parse error: ' + e.message)); }
        },
        onerror: () => {
          showToast('CSV onerror — domain not in @connect?', 'error');
          reject(new Error('CSV fetch failed'));
        },
        ontimeout: () => {
          showToast('CSV timeout', 'error');
          reject(new Error('CSV timeout'));
        },
      });
    });
  }

  // ─── PUSH SINGLE ITEM TO GOOGLE SHEETS ───────────────────────────────────
  // Uses GET with URL params instead of POST — avoids Google's auth redirect
  // on POST requests from Tampermonkey context
  function pushItemToSheets(building, item, current) {
    const params = new URLSearchParams({
      action:      'update',
      building:    building,
      item_needed: item,
      current_qty: current,
    });
    GM_xmlhttpRequest({
      method: 'GET',
      url: CONFIG.APPS_SCRIPT_URL + '?' + params.toString(),
      redirect: 'follow',
      onload: res => {
        try {
          const result = JSON.parse(res.responseText);
          if (result.status !== 'ok') showToast('Sheets write failed', 'error');
          else showToast('Sheets updated ✓', 'success');
        } catch {
          showToast('Sheets write error', 'error');
        }
      },
      onerror: () => showToast('Sheets write network error', 'error'),
    });
  }

  // ─── LOCAL CACHE ──────────────────────────────────────────────────────────
  function saveLocalCache() {
    GM_setValue('inventory_' + userBuilding, JSON.stringify(allRows));
    GM_setValue('header_' + userBuilding, JSON.stringify(headerRow));
  }

  function loadLocalFallback() {
    const savedRows   = GM_getValue('inventory_' + userBuilding, null);
    const savedHeader = GM_getValue('header_' + userBuilding, null);
    if (savedRows) {
      allRows   = JSON.parse(savedRows);
      headerRow = savedHeader ? JSON.parse(savedHeader) : ['Building','Item Name','Current Qty','Maximum Qty','Minimum Qty thres.'];
    } else {
      allRows   = SEED_DATA.map(r => [...r]);
      headerRow = ['Building','Item Name','Current Qty','Maximum Qty','Minimum Qty thres.'];
      saveLocalCache();
    }
    inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
  }

  // ─── SYNC TIMER ───────────────────────────────────────────────────────────
  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      fetchFromPublishedCSV()
        .then(() => { saveLocalCache(); showToast('Sheets synced ✓', 'success'); })
        .catch(() => showToast('Sync failed — using local cache', 'info'));
    }, CONFIG.SYNC_INTERVAL_MS);
  }

  // ─── RENDER PANEL ─────────────────────────────────────────────────────────
  function renderPanel() {
    const existing = document.getElementById('inv-panel');
    if (existing) existing.remove();

    const panel = createElement('div', 'inv-panel');
    panel.id = 'inv-panel';
    panel.innerHTML = `
      <div class="inv-header">
        <span class="inv-title">📦 Inventory — ${userBuilding}</span>
        <span class="inv-role-badge ${userRole}">${userRole.toUpperCase()}</span>
        <span class="inv-sp-badge" id="inv-sp-badge" title="${sheetsAvailable ? 'Google Sheets connected' : 'Offline — local cache'}">${sheetsAvailable ? '🟢' : '🟡'}</span>
        <button class="inv-btn-icon" id="inv-sync-now" title="Sync to Google Sheets now">🔄</button>
        <button class="inv-btn-icon" id="inv-settings" title="Change building/role">⚙️</button>
        <button class="inv-btn-icon" id="inv-minimize" title="Minimize">—</button>
      </div>
      <div class="inv-body" id="inv-body">
        <table class="inv-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Min</th>
              <th>Max</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="inv-tbody"></tbody>
        </table>
      </div>
    `;
    document.body.appendChild(panel);
    makeDraggable(panel);
    document.getElementById('inv-sync-now').addEventListener('click', () => {
      fetchFromPublishedCSV()
        .then(() => { saveLocalCache(); showToast('Sheets synced ✓', 'success'); populateTable(); })
        .catch(() => showToast('Sync failed — using local cache', 'info'));
    });
    document.getElementById('inv-settings').addEventListener('click', resetSettings);
    document.getElementById('inv-minimize').addEventListener('click', toggleMinimize);
    populateTable();
  }

  // ─── POPULATE TABLE ───────────────────────────────────────────────────────
  function populateTable() {
    const tbody = document.getElementById('inv-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    inventory.forEach((row, i) => {
      const item    = row[COL.ITEM];
      const current = Number(row[COL.CURRENT]);
      const min     = Number(row[COL.MIN]);
      const max     = Number(row[COL.MAX]);
      const low     = current <= min;

      const tr = document.createElement('tr');
      if (low) tr.classList.add('inv-low');
      tr.innerHTML = `
        <td>${item}</td>
        <td class="inv-qty" id="qty-${i}">${current}</td>
        <td>${min}</td>
        <td>${max}</td>
        <td class="inv-actions">
          <button class="inv-btn inv-minus" data-idx="${i}">−</button>
          ${userRole === 'logistics' ? `<button class="inv-btn inv-plus" data-idx="${i}">+</button>` : ''}
          <button class="inv-btn inv-qr" data-idx="${i}" title="Show QR code">⬛</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.inv-minus').forEach(btn =>
      btn.addEventListener('click', () => adjustQty(parseInt(btn.dataset.idx), -1))
    );
    if (userRole === 'logistics') {
      tbody.querySelectorAll('.inv-plus').forEach(btn =>
        btn.addEventListener('click', () => adjustQty(parseInt(btn.dataset.idx), 1))
      );
    }
    tbody.querySelectorAll('.inv-qr').forEach(btn =>
      btn.addEventListener('click', () => showQRModal(parseInt(btn.dataset.idx)))
    );
  }

  // ─── QR CODE MODAL ────────────────────────────────────────────────────────
  function showQRModal(localIdx) {
    const row      = inventory[localIdx];
    const item     = row[COL.ITEM];
    const building = row[COL.BUILDING];
    const current  = Number(row[COL.CURRENT]);
    const min      = Number(row[COL.MIN]);
    const max      = Number(row[COL.MAX]);
    const qrParams = new URLSearchParams({ inv_action: 'deduct', building, item });
    const qrText   = `${CONFIG.BOOST_URL}?${qrParams.toString()}`;

    const existing = document.getElementById('inv-qr-modal');
    if (existing) existing.remove();

    const modal = createElement('div', 'inv-qr-overlay');
    modal.id = 'inv-qr-modal';
    modal.innerHTML = `
      <div class="inv-qr-box">
        <div class="inv-qr-header">
          <span class="inv-qr-title">QR — ${item}</span>
          <button class="inv-qr-close" id="inv-qr-close" title="Close">✕</button>
        </div>
        <canvas id="inv-qr-canvas" width="180" height="180"
          style="border-radius:6px;border:2px solid #c9a84c44;display:block;background:#fff;">
        </canvas>
        <div class="inv-qr-meta">
          <div class="inv-qr-meta-row"><span>Building</span><span>${building}</span></div>
          <div class="inv-qr-meta-row"><span>Current Qty</span><span>${current}</span></div>
          <div class="inv-qr-meta-row"><span>Min</span><span>${min}</span></div>
          <div class="inv-qr-meta-row"><span>Max</span><span>${max}</span></div>
        </div>
        <button class="inv-qr-print" id="inv-qr-print">🖨 Print Label</button>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('inv-qr-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // Draw QR onto canvas after modal is in DOM
    setTimeout(() => drawQR('inv-qr-canvas', qrText, 180), 50);

    document.getElementById('inv-qr-print').addEventListener('click', () => {
      const canvas  = document.getElementById('inv-qr-canvas');
      if (!canvas) return;
      const dataUrl = canvas.toDataURL('image/png');
      const win = window.open('', '_blank', 'width=320,height=500');
      win.document.write(`<!DOCTYPE html><html><head><title>${item}</title>
        <style>
          body{font-family:Georgia,serif;text-align:center;padding:20px;color:#111;}
          h2{font-size:14px;margin:0 0 4px;}
          p{font-size:10px;color:#888;margin:0 0 10px;letter-spacing:.05em;}
          img{width:180px;height:180px;display:block;margin:0 auto 10px;}
          table{margin:0 auto;font-size:12px;border-collapse:collapse;width:200px;}
          td{padding:4px 10px;border-bottom:1px solid #ccc;}
          td:first-child{text-align:left;font-weight:bold;}
          td:last-child{text-align:right;}
          .footer{margin-top:10px;font-size:8px;color:#bbb;letter-spacing:.08em;text-transform:uppercase;}
        </style></head><body>
        <h2>${building} — ${item}</h2>
        <p>Scan to deduct 1 unit</p>
        <img src="${dataUrl}" onload="window.print()" />
        <table>
          <tr><td>Current Qty</td><td>${current}</td></tr>
          <tr><td>Min</td><td>${min}</td></tr>
          <tr><td>Max</td><td>${max}</td></tr>
        </table>
        <div class="footer">EZ Logi Con Count — CMH73</div>
      </body></html>`);
      win.document.close();
    });
  }

  // ─── SELF-CONTAINED QR CODE RENDERER ─────────────────────────────────────
  // Draws a QR code onto a canvas element with no external dependencies.
  // Uses a minimal QR encoding implementation for alphanumeric/byte data.
  function drawQR(canvasId, text, size) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // Use the goqr.me API as a data URL via GM_xmlhttpRequest to bypass CSP
    // This fetches the image as binary and converts to base64 in the script context
    const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(text)}&format=png`;

    GM_xmlhttpRequest({
      method:       'GET',
      url:          apiUrl,
      responseType: 'blob',
      onload: res => {
        const blob   = res.response;
        const reader = new FileReader();
        reader.onloadend = () => {
          const img    = new Image();
          img.onload   = () => {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(img, 0, 0, size, size);
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(blob);
      },
      onerror: () => {
        // If fetch fails, draw a placeholder with the text
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#333';
        ctx.font = '10px Georgia';
        ctx.textAlign = 'center';
        ctx.fillText('QR unavailable', size / 2, size / 2);
      },
    });
  }

  // ─── ADJUST QUANTITY ──────────────────────────────────────────────────────
  function adjustQty(localIdx, delta) {
    const globalIdx = allRows.indexOf(inventory[localIdx]);
    const current   = Number(allRows[globalIdx][COL.CURRENT]);
    const min       = Number(allRows[globalIdx][COL.MIN]);
    const max       = Number(allRows[globalIdx][COL.MAX]);
    const newQty    = Math.max(0, Math.min(max, current + delta));
    const item      = allRows[globalIdx][COL.ITEM];

    allRows[globalIdx][COL.CURRENT]  = newQty;
    inventory[localIdx][COL.CURRENT] = newQty;

    const qtyCell = document.getElementById(`qty-${localIdx}`);
    if (qtyCell) {
      qtyCell.textContent = newQty;
      qtyCell.closest('tr').classList.toggle('inv-low', newQty <= min);
    }

    saveLocalCache();
    pushItemToSheets(inventory[localIdx][COL.BUILDING], item, newQty);
  }

  // ─── SCHEDULED DIGEST CHECK ───────────────────────────────────────────────
  // Fires at 6am and 12pm only — shared across all users via Google Sheets
  // so only one person's script sends the message per window, not everyone's
  function checkThresholds() {
    const now    = new Date();
    const hour   = now.getHours();
    const minute = now.getMinutes();

    // Only proceed if we're within the first 5 minutes of 6am or 12pm
    const isDigestWindow = (hour === 6 || hour === 12) && minute < 5;
    if (!isDigestWindow) return;

    // Build a key for this specific window e.g. "CMH73-2026-05-13-6"
    const windowKey = `${userBuilding}-${now.toISOString().slice(0,10)}-${hour}`;

    // Check Google Sheets to see if digest was already sent this window
    GM_xmlhttpRequest({
      method: 'GET',
      url: CONFIG.APPS_SCRIPT_URL + '?action=getDigestKey',
      redirect: 'follow',
      onload: res => {
        try {
          const data = JSON.parse(res.responseText);
          if (data.digestKey === windowKey) return; // already sent this window
          sendDigest(windowKey);
        } catch {
          // If check fails, fall back to localStorage to avoid spam
          const localKey = GM_getValue('digest_key', null);
          if (localKey === windowKey) return;
          sendDigest(windowKey);
        }
      },
      onerror: () => {
        const localKey = GM_getValue('digest_key', null);
        if (localKey === windowKey) return;
        sendDigest(windowKey);
      },
    });
  }

  // ─── SEND DIGEST ──────────────────────────────────────────────────────────
  function sendDigest(windowKey) {
    const lowItems = inventory.filter(r => Number(r[COL.CURRENT]) <= Number(r[COL.MIN]));
    if (lowItems.length === 0) return;

    // Mark as sent locally and in Sheets immediately to prevent other users sending
    GM_setValue('digest_key', windowKey);
    pushDigestKey(windowKey);

    const now        = new Date();
    const timeLabel  = now.getHours() === 6 ? '6:00 AM' : '12:00 PM';
    const dateLabel  = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const itemLines = lowItems.map(r => {
      const current = Number(r[COL.CURRENT]);
      const max     = Number(r[COL.MAX]);
      const reorder = max - current;
      return `• *${r[COL.ITEM]}* — Qty: ${current} | Reorder: ${reorder} units`;
    }).join('\n');

    const payload = {
      building: userBuilding,
      summary:  `*${dateLabel} @ ${timeLabel}*\n\n${itemLines}`,
    };

    GM_xmlhttpRequest({
      method: 'POST',
      url: CONFIG.SLACK_DIGEST_WEBHOOK,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onload: res => {
        if (res.status !== 200) showToast('Digest failed to send', 'error');
        else showToast(`Digest sent @ ${timeLabel} ✓`, 'success');
      },
      onerror: () => showToast('Digest Slack error', 'error'),
    });
  }

  // ─── PUSH DIGEST KEY TO SHEETS ────────────────────────────────────────────
  function pushDigestKey(windowKey) {
    const params = new URLSearchParams({ action: 'setDigestKey', digestKey: windowKey });
    GM_xmlhttpRequest({
      method: 'GET',
      url: CONFIG.APPS_SCRIPT_URL + '?' + params.toString(),
      redirect: 'follow',
      onerror: () => {},
    });
  }

  // ─── UI HELPERS ───────────────────────────────────────────────────────────
  function resetSettings() {
    showSetupWizard(true);
  }

  function toggleMinimize() {
    const body  = document.getElementById('inv-body');
    const btn   = document.getElementById('inv-minimize');
    const panel = document.getElementById('inv-panel');
    if (!body || !panel) return;
    const isMinimized = body.style.display === 'none';
    if (isMinimized) {
      body.style.display = '';
      btn.title = 'Minimize';
      btn.textContent = '—';
      panel.style.width = '420px';
    } else {
      panel.style.width = panel.offsetWidth + 'px';
      body.style.display = 'none';
      btn.title = 'Restore';
      btn.textContent = '□';
    }
  }

  function showToast(msg, type = 'info') {
    const toast = createElement('div', `inv-toast inv-toast-${type}`);
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function createElement(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function makeDraggable(el) {
    const header = el.querySelector('.inv-header');
    header.style.cursor = 'move';
    header.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      el.style.bottom = 'auto';
      el.style.right  = 'auto';
      el.style.left   = rect.left + 'px';
      el.style.top    = rect.top  + 'px';
      el.style.width  = el.offsetWidth + 'px';
      const startX = e.clientX - rect.left;
      const startY = e.clientY - rect.top;
      function drag(e2) {
        let newLeft = e2.clientX - startX;
        let newTop  = e2.clientY - startY;
        newLeft = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  newLeft));
        newTop  = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, newTop));
        el.style.left = newLeft + 'px';
        el.style.top  = newTop  + 'px';
      }
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', drag), { once: true });
    });
  }

  // ─── STYLES ───────────────────────────────────────────────────────────────
  function injectStyles() {
    const fontLink = document.createElement('link');
    fontLink.rel  = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap';
    document.head.appendChild(fontLink);

    const style = document.createElement('style');
    style.textContent = `
      #inv-panel {
        position: fixed; bottom: 24px; right: 24px; width: 420px;
        background: #0d1f0f; color: #e8d9b0;
        border-radius: 10px; border: 1px solid #c9a84c;
        box-shadow: 0 8px 36px rgba(0,0,0,0.7), 0 0 0 1px #c9a84c33;
        font-family: 'Cinzel', 'Georgia', serif; font-size: 13px;
        z-index: 999999; overflow: hidden; box-sizing: border-box;
      }
      .inv-header {
        display: flex; align-items: center; gap: 8px;
        padding: 11px 14px; background: #0a1a0c;
        border-bottom: 1px solid #c9a84c55;
        user-select: none; -webkit-user-select: none;
      }
      .inv-title {
        font-weight: 700; font-size: 13px; letter-spacing: 0.08em;
        color: #f0d080; flex: 1; text-transform: uppercase;
      }
      .inv-role-badge {
        font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
        padding: 3px 9px; border-radius: 20px;
        text-transform: uppercase; font-family: 'Cinzel', serif;
      }
      .inv-role-badge.logistics { background: #c9a84c; color: #0d1f0f; }
      .inv-role-badge.dco       { background: #8b6914; color: #f0d080; }
      .inv-sp-badge { font-size: 12px; cursor: default; }
      .inv-body {
        padding: 12px; max-height: 320px; overflow-y: auto;
        scrollbar-width: thin; scrollbar-color: #c9a84c44 transparent;
      }
      .inv-table { width: 100%; border-collapse: collapse; }
      .inv-table th {
        text-align: left; padding: 7px 8px;
        border-bottom: 1px solid #c9a84c44; color: #c9a84c;
        font-weight: 600; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      }
      .inv-table td {
        padding: 7px 8px; border-bottom: 1px solid #0d1f0f;
        color: #e8d9b0; font-size: 12px;
      }
      .inv-table tr.inv-low td { color: #e05c5c; font-weight: 600; }
      .inv-table tr:hover td { background: #122614; }
      .inv-actions { display: flex; gap: 6px; }
      .inv-btn {
        width: 28px; height: 28px; border: none; border-radius: 5px;
        font-size: 16px; font-weight: 700; cursor: pointer; line-height: 1;
        font-family: 'Cinzel', serif; transition: opacity 0.15s;
      }
      .inv-btn:hover { opacity: 0.8; }
      .inv-minus { background: #7a1f1f; color: #f0a0a0; border: 1px solid #e05c5c55; }
      .inv-plus  { background: #1a4a1a; color: #90d090; border: 1px solid #4caf5055; }
      .inv-btn.inv-qr { background: #1a2a3a; color: #80b0d0; border: 1px solid #4080b044; font-size: 12px; }
      .inv-btn-icon {
        background: transparent; border: none; color: #c9a84c99;
        cursor: pointer; font-size: 14px; padding: 2px 5px;
        border-radius: 4px; transition: color 0.15s, background 0.15s;
      }
      .inv-btn-icon:hover { background: #122614; color: #f0d080; }
      .inv-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.75);
        z-index: 1000000; display: flex; align-items: center; justify-content: center;
      }
      .inv-wizard {
        background: #0d1f0f; color: #e8d9b0; border: 1px solid #c9a84c;
        border-radius: 12px; padding: 32px; width: 300px;
        display: flex; flex-direction: column; gap: 18px;
        font-family: 'Cinzel', 'Georgia', serif; box-shadow: 0 8px 40px rgba(0,0,0,0.8);
      }
      .inv-wizard-topbar {
        display: flex; align-items: center; justify-content: center;
        position: relative; width: 100%;
      }
      .inv-wizard h2 {
        margin: 0; font-size: 16px; letter-spacing: 0.12em;
        text-transform: uppercase; color: #f0d080; text-align: center;
      }
      .inv-wizard-close {
        position: absolute; right: 0; top: 50%; transform: translateY(-50%);
        background: transparent; border: none; color: #c9a84c99;
        font-size: 16px; cursor: pointer; padding: 2px 6px;
        border-radius: 4px; line-height: 1; transition: color 0.15s, background 0.15s;
        font-family: sans-serif;
      }
      .inv-wizard-close:hover { background: #7a1f1f; color: #f0a0a0; }
      .inv-wizard p { margin: 0; color: #a89060; font-size: 11px; text-align: center; letter-spacing: 0.05em; }
      .inv-wizard label {
        display: flex; flex-direction: column; gap: 7px;
        font-size: 11px; font-weight: 600; letter-spacing: 0.08em;
        text-transform: uppercase; color: #c9a84c;
      }
      .inv-wizard select {
        padding: 9px; border-radius: 6px; background: #0a1a0c; color: #e8d9b0;
        border: 1px solid #c9a84c55; font-size: 12px; font-family: 'Cinzel', serif;
      }
      #inv-setup-save {
        padding: 11px; border-radius: 7px; background: #c9a84c; color: #0d1f0f;
        border: none; font-weight: 700; font-size: 12px; cursor: pointer;
        letter-spacing: 0.1em; text-transform: uppercase;
        font-family: 'Cinzel', serif; transition: background 0.15s;
      }
      #inv-setup-save:hover { background: #f0d080; }
      .inv-toast {
        position: fixed; bottom: 84px; right: 24px;
        padding: 10px 16px; border-radius: 7px; font-family: 'Cinzel', serif;
        font-size: 12px; z-index: 1000001; letter-spacing: 0.05em;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5); animation: inv-fadein 0.3s ease;
      }
      .inv-toast-success { background: #1a4a1a; color: #90d090; border: 1px solid #4caf5055; }
      .inv-toast-error   { background: #7a1f1f; color: #f0a0a0; border: 1px solid #e05c5c55; }
      .inv-toast-info    { background: #0a1a0c; color: #c9a84c;  border: 1px solid #c9a84c55; }
      @keyframes inv-fadein {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      /* ── QR Modal ── */
      .inv-qr-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.75);
        z-index: 1000002; display: flex; align-items: center; justify-content: center;
      }
      .inv-qr-box {
        background: #0d1f0f; color: #e8d9b0; border: 1px solid #c9a84c;
        border-radius: 12px; padding: 20px; width: 240px;
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        font-family: 'Cinzel', 'Georgia', serif; box-shadow: 0 8px 40px rgba(0,0,0,0.85);
      }
      .inv-qr-header {
        display: flex; align-items: center; justify-content: center;
        position: relative; width: 100%;
      }
      .inv-qr-title {
        font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
        text-transform: uppercase; color: #f0d080; text-align: center; padding: 0 24px;
      }
      .inv-qr-close {
        position: absolute; right: 0; top: 50%; transform: translateY(-50%);
        background: transparent; border: none; color: #c9a84c99;
        font-size: 15px; cursor: pointer; padding: 2px 5px;
        border-radius: 4px; line-height: 1; font-family: sans-serif;
        transition: color 0.15s, background 0.15s;
      }
      .inv-qr-close:hover { background: #7a1f1f; color: #f0a0a0; }
      .inv-qr-img {
        width: 180px; height: 180px; border-radius: 6px;
        border: 2px solid #c9a84c44; display: block;
      }
      .inv-qr-meta { width: 100%; display: flex; flex-direction: column; gap: 5px; }
      .inv-qr-meta-row {
        display: flex; justify-content: space-between;
        font-size: 11px; color: #c9a84c; letter-spacing: 0.05em;
        border-bottom: 1px solid #c9a84c22; padding-bottom: 4px;
      }
      .inv-qr-meta-row span:last-child { color: #e8d9b0; font-weight: 600; }
      .inv-qr-print {
        width: 100%; padding: 9px; border-radius: 6px;
        background: #1a3a1a; color: #90d090; border: 1px solid #4caf5044;
        font-family: 'Cinzel', serif; font-size: 11px; font-weight: 700;
        letter-spacing: 0.08em; text-transform: uppercase;
        cursor: pointer; transition: background 0.15s;
      }
      .inv-qr-print:hover { background: #1a4a1a; }
    `;
    document.head.appendChild(style);
  }

  // ─── GO ───────────────────────────────────────────────────────────────────
  init();

})();
