// ==UserScript==
// @name         DCO Consumable Inventory Manager
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Inventory management for DCO consumables, synced to SharePoint Excel
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      graph.microsoft.com
// @connect      hooks.slack.com
// @connect      amazon-my.sharepoint.com
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIGURATION ────────────────────────────────────────────────────────
  const CONFIG = {
    // SharePoint / Microsoft Graph settings
    // SITE_ID and DRIVE_ID are auto-discovered on first run and cached locally
    SITE_ID:   GM_getValue('site_id', null),
    DRIVE_ID:  GM_getValue('drive_id', null),

    // Extracted from your SharePoint file URL
    FILE_ID:   '87644297-8C46-4D9F-ADA5-996D692B3E4C',
    SHEET_NAME: 'Ez Con Logi count',

    // SharePoint tenant info for Graph API discovery
    TENANT_HOST: 'amazon-my.sharepoint.com',
    OWNER_PATH:  '/personal/maprideg_amazon_com',

    // Slack incoming webhook — logistics channel
    SLACK_WEBHOOK: 'https://hooks.slack.com/triggers/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',

    // How often to sync changes back to SharePoint (ms)
    SYNC_INTERVAL_MS: 60 * 60 * 1000, // 1 hour

    // Available buildings — add more as the rollout expands
    BUILDINGS: ['CMH73'],
  };

  // ─── EXCEL COLUMN MAP (0-indexed) ─────────────────────────────────────────
  // Row 1 is the header. Data starts at row 2.
  // Building | Item Name | Current Qty | Max Qty | Min Threshold
  const COL = {
    BUILDING:   0,
    ITEM:       1,
    CURRENT:    2,
    MAX:        3,
    MIN:        4,
  };

  // ─── STATE ────────────────────────────────────────────────────────────────
  let userBuilding = GM_getValue('building', null);
  let userRole     = GM_getValue('role', null);     // 'dco' | 'logistics'
  let inventory    = [];   // filtered rows for current building
  let allRows      = [];   // full dataset from Excel (excluding header)
  let headerRow    = [];   // column headers from Excel row 1
  let alerted      = {};   // tracks items already alerted this session
  let syncTimer    = null;
  let accessToken  = null;

  // ─── ENTRY POINT ──────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    if (!userBuilding || !userRole) {
      showSetupWizard();
    } else {
      launchApp();
    }
  }

  // ─── SETUP WIZARD ─────────────────────────────────────────────────────────
  function showSetupWizard() {
    const overlay = createElement('div', 'inv-overlay');
    const box = createElement('div', 'inv-wizard');

    box.innerHTML = `
      <h2>DCO Inventory Setup</h2>
      <p>Select your building and role to get started.</p>
      <label>Building
        <select id="inv-building">
          ${CONFIG.BUILDINGS.map(b => `<option value="${b}">${b}</option>`).join('')}
        </select>
      </label>
      <label>Role
        <select id="inv-role">
          <option value="dco">DCO</option>
          <option value="logistics">Logistics</option>
        </select>
      </label>
      <button id="inv-setup-save">Save & Continue</button>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    document.getElementById('inv-setup-save').addEventListener('click', () => {
      userBuilding = document.getElementById('inv-building').value;
      userRole     = document.getElementById('inv-role').value;
      GM_setValue('building', userBuilding);
      GM_setValue('role', userRole);
      overlay.remove();
      launchApp();
    });
  }

  // ─── LAUNCH APP ───────────────────────────────────────────────────────────
  function launchApp() {
    getAccessToken()
      .then(() => discoverSiteAndDrive())
      .then(() => fetchInventory())
      .then(() => {
        renderPanel();
        startSyncTimer();
      })
      .catch(err => showToast('Failed to load inventory: ' + err.message, 'error'));
  }

  // ─── AUTO-DISCOVER SITE ID AND DRIVE ID ───────────────────────────────────
  function discoverSiteAndDrive() {
    // Use cached values if already discovered
    if (CONFIG.SITE_ID && CONFIG.DRIVE_ID) return Promise.resolve();

    const siteUrl = `https://graph.microsoft.com/v1.0/sites/${CONFIG.TENANT_HOST}:${CONFIG.OWNER_PATH}`;

    return graphRequest('GET', siteUrl).then(siteData => {
      CONFIG.SITE_ID = siteData.id;
      GM_setValue('site_id', siteData.id);

      const drivesUrl = `https://graph.microsoft.com/v1.0/sites/${CONFIG.SITE_ID}/drives`;
      return graphRequest('GET', drivesUrl);
    }).then(drivesData => {
      // Pick the default Documents drive (first drive or one named 'Documents')
      const drives = drivesData.value || [];
      const drive  = drives.find(d => d.name === 'Documents') || drives[0];
      if (!drive) throw new Error('Could not find a SharePoint drive.');
      CONFIG.DRIVE_ID = drive.id;
      GM_setValue('drive_id', drive.id);
      showToast('SharePoint connected.', 'success');
    });
  }

  // ─── AUTH — Microsoft Graph (uses existing browser MSAL session) ──────────
  function getAccessToken() {
    return new Promise((resolve, reject) => {
      // Attempt to grab a token silently from the MSAL cache in the page context.
      // This works when the script runs on a Microsoft 365 / SharePoint domain.
      // If running on a non-MS domain, the user will need to provide a token manually.
      try {
        const msalKeys = Object.keys(sessionStorage).filter(k => k.includes('accesstoken'));
        for (const key of msalKeys) {
          const entry = JSON.parse(sessionStorage.getItem(key));
          if (entry && entry.target && entry.target.includes('Files.ReadWrite') && entry.secret) {
            const expiry = parseInt(entry.expiresOn || entry.cachedAt, 10) * 1000;
            if (Date.now() < expiry) {
              accessToken = entry.secret;
              return resolve();
            }
          }
        }
        // Fallback: prompt user to paste a token (dev/testing convenience)
        const token = prompt(
          'Could not auto-detect your Microsoft access token.\n' +
          'Please paste a Graph API token with Files.ReadWrite scope:'
        );
        if (token) { accessToken = token; resolve(); }
        else reject(new Error('No access token provided.'));
      } catch (e) {
        reject(e);
      }
    });
  }

  // ─── FETCH INVENTORY FROM SHAREPOINT EXCEL ────────────────────────────────
  function fetchInventory() {
    const url = `https://graph.microsoft.com/v1.0/sites/${CONFIG.SITE_ID}/drives/${CONFIG.DRIVE_ID}/items/${CONFIG.FILE_ID}/workbook/worksheets('${CONFIG.SHEET_NAME}')/usedRange`;

    return graphRequest('GET', url).then(data => {
      const rows = data.values;
      if (!rows || rows.length < 2) throw new Error('Spreadsheet appears empty.');
      headerRow = rows[0];
      allRows   = rows.slice(1);
      inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
    });
  }

  // ─── WRITE INVENTORY BACK TO SHAREPOINT ───────────────────────────────────
  function pushInventory() {
    // Rebuild the full values array (header + all rows with updated quantities)
    const values = [headerRow, ...allRows];
    const url = `https://graph.microsoft.com/v1.0/sites/${CONFIG.SITE_ID}/drives/${CONFIG.DRIVE_ID}/items/${CONFIG.FILE_ID}/workbook/worksheets('${CONFIG.SHEET_NAME}')/range(address='A1')`;

    // We need to address the exact range
    const rowCount = values.length;
    const colCount = headerRow.length;
    const endCol   = String.fromCharCode(65 + colCount - 1);
    const rangeUrl = `https://graph.microsoft.com/v1.0/sites/${CONFIG.SITE_ID}/drives/${CONFIG.DRIVE_ID}/items/${CONFIG.FILE_ID}/workbook/worksheets('${CONFIG.SHEET_NAME}')/range(address='A1:${endCol}${rowCount}')`;

    return graphRequest('PATCH', rangeUrl, { values }).then(() => {
      showToast('Inventory synced to SharePoint.', 'success');
    }).catch(err => {
      showToast('Sync failed: ' + err.message, 'error');
    });
  }

  // ─── SYNC TIMER ───────────────────────────────────────────────────────────
  function startSyncTimer() {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(() => {
      pushInventory();
    }, CONFIG.SYNC_INTERVAL_MS);
  }

  // ─── RENDER PANEL ─────────────────────────────────────────────────────────
  function renderPanel() {
    // Remove existing panel if re-rendering
    const existing = document.getElementById('inv-panel');
    if (existing) existing.remove();

    const panel = createElement('div', 'inv-panel');
    panel.id = 'inv-panel';

    panel.innerHTML = `
      <div class="inv-header">
        <span class="inv-title">📦 Inventory — ${userBuilding}</span>
        <span class="inv-role-badge ${userRole}">${userRole.toUpperCase()}</span>
        <button class="inv-btn-icon" id="inv-sync-now" title="Sync now">🔄</button>
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

    document.getElementById('inv-sync-now').addEventListener('click', () => pushInventory());
    document.getElementById('inv-settings').addEventListener('click', resetSettings);
    document.getElementById('inv-minimize').addEventListener('click', toggleMinimize);

    populateTable();
    checkThresholds();
  }

  function populateTable() {
    const tbody = document.getElementById('inv-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    inventory.forEach((row, localIdx) => {
      const item    = row[COL.ITEM];
      const current = Number(row[COL.CURRENT]);
      const min     = Number(row[COL.MIN]);
      const max     = Number(row[COL.MAX]);
      const low     = current <= min;

      const tr = document.createElement('tr');
      if (low) tr.classList.add('inv-low');

      tr.innerHTML = `
        <td>${item}</td>
        <td class="inv-qty" id="qty-${localIdx}">${current}</td>
        <td>${min}</td>
        <td>${max}</td>
        <td class="inv-actions">
          <button class="inv-btn inv-minus" data-idx="${localIdx}">−</button>
          ${userRole === 'logistics' ? `<button class="inv-btn inv-plus" data-idx="${localIdx}">+</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Attach button listeners
    tbody.querySelectorAll('.inv-minus').forEach(btn => {
      btn.addEventListener('click', () => adjustQty(parseInt(btn.dataset.idx), -1));
    });
    if (userRole === 'logistics') {
      tbody.querySelectorAll('.inv-plus').forEach(btn => {
        btn.addEventListener('click', () => adjustQty(parseInt(btn.dataset.idx), 1));
      });
    }
  }

  // ─── ADJUST QUANTITY ──────────────────────────────────────────────────────
  function adjustQty(localIdx, delta) {
    const globalIdx = allRows.indexOf(inventory[localIdx]);
    const current   = Number(allRows[globalIdx][COL.CURRENT]);
    const min       = Number(allRows[globalIdx][COL.MIN]);
    const max       = Number(allRows[globalIdx][COL.MAX]);
    const newQty    = Math.max(0, Math.min(max, current + delta));

    allRows[globalIdx][COL.CURRENT]   = newQty;
    inventory[localIdx][COL.CURRENT]  = newQty;

    // Update display
    const qtyCell = document.getElementById(`qty-${localIdx}`);
    if (qtyCell) {
      qtyCell.textContent = newQty;
      qtyCell.closest('tr').classList.toggle('inv-low', newQty <= min);
    }

    // Check threshold after adjustment
    if (newQty <= min) {
      triggerSlackAlert(inventory[localIdx]);
    }
  }

  // ─── THRESHOLD CHECK ON LOAD ──────────────────────────────────────────────
  function checkThresholds() {
    inventory.forEach(row => {
      if (Number(row[COL.CURRENT]) <= Number(row[COL.MIN])) {
        triggerSlackAlert(row);
      }
    });
  }

  // ─── SLACK ALERT ──────────────────────────────────────────────────────────
  function triggerSlackAlert(row) {
    const item     = row[COL.ITEM];
    const building = row[COL.BUILDING];
    const current  = Number(row[COL.CURRENT]);
    const max      = Number(row[COL.MAX]);
    const reorder  = max - current;
    const alertKey = `${building}-${item}`;

    // Only alert once per session per item
    if (alerted[alertKey]) return;
    alerted[alertKey] = true;

    const message = {
      text: `🚨 *Low Stock Alert — ${building}*`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🚨 Low Stock Alert — ${building}` }
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Building:*\n${building}` },
            { type: 'mrkdwn', text: `*Item Needed:*\n${item}` },
            { type: 'mrkdwn', text: `*Current Quantity:*\n${current}` },
            { type: 'mrkdwn', text: `*Suggested Reorder Qty:*\n${reorder} units (to reach max of ${max})` },
          ]
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `Triggered automatically by DCO Inventory Manager` }]
        }
      ]
    };

    GM_xmlhttpRequest({
      method: 'POST',
      url: CONFIG.SLACK_WEBHOOK,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(message),
      onload: res => {
        if (res.status !== 200) showToast(`Slack alert failed for ${item}`, 'error');
      },
      onerror: () => showToast(`Slack alert error for ${item}`, 'error'),
    });
  }

  // ─── GRAPH API HELPER ─────────────────────────────────────────────────────
  function graphRequest(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload: res => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch { resolve({}); }
          } else {
            reject(new Error(`Graph API ${res.status}: ${res.responseText}`));
          }
        },
        onerror: err => reject(new Error('Network error: ' + JSON.stringify(err))),
      });
    });
  }

  // ─── UI HELPERS ───────────────────────────────────────────────────────────
  function resetSettings() {
    GM_setValue('building', null);
    GM_setValue('role', null);
    userBuilding = null;
    userRole = null;
    const panel = document.getElementById('inv-panel');
    if (panel) panel.remove();
    showSetupWizard();
  }

  function toggleMinimize() {
    const body = document.getElementById('inv-body');
    const btn  = document.getElementById('inv-minimize');
    if (!body) return;
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    btn.textContent = hidden ? '—' : '□';
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
    let ox = 0, oy = 0, mx = 0, my = 0;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', e => {
      e.preventDefault();
      ox = e.clientX - el.offsetLeft;
      oy = e.clientY - el.offsetTop;
      document.addEventListener('mousemove', drag);
      document.addEventListener('mouseup', () => document.removeEventListener('mousemove', drag), { once: true });
    });
    function drag(e) {
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top  = (e.clientY - oy) + 'px';
    }
  }

  // ─── STYLES ───────────────────────────────────────────────────────────────
  function injectStyles() {
    // Load Cinzel from Google Fonts — gothic, highly readable
    const fontLink = document.createElement('link');
    fontLink.rel  = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&display=swap';
    document.head.appendChild(fontLink);

    const style = document.createElement('style');
    style.textContent = `
      /* ── Panel ── */
      #inv-panel {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 420px;
        background: #0d1f0f;
        color: #e8d9b0;
        border-radius: 10px;
        border: 1px solid #c9a84c;
        box-shadow: 0 8px 36px rgba(0,0,0,0.7), 0 0 0 1px #c9a84c33;
        font-family: 'Cinzel', 'Georgia', serif;
        font-size: 13px;
        z-index: 999999;
        overflow: hidden;
      }

      /* ── Header ── */
      .inv-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 11px 14px;
        background: #0a1a0c;
        border-bottom: 1px solid #c9a84c55;
      }
      .inv-title {
        font-weight: 700;
        font-size: 13px;
        letter-spacing: 0.08em;
        color: #f0d080;
        flex: 1;
        text-transform: uppercase;
      }
      .inv-role-badge {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.1em;
        padding: 3px 9px;
        border-radius: 20px;
        text-transform: uppercase;
        font-family: 'Cinzel', serif;
      }
      .inv-role-badge.logistics { background: #c9a84c; color: #141414; }
      .inv-role-badge.dco       { background: #8b6914; color: #f0d080; }

      /* ── Body ── */
      .inv-body {
        padding: 12px;
        max-height: 320px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #c9a84c44 transparent;
      }

      /* ── Table ── */
      .inv-table { width: 100%; border-collapse: collapse; }
      .inv-table th {
        text-align: left;
        padding: 7px 8px;
        border-bottom: 1px solid #c9a84c44;
        color: #c9a84c;
        font-weight: 600;
        font-size: 11px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .inv-table td {
        padding: 7px 8px;
        border-bottom: 1px solid #0d1f0f;
        color: #e8d9b0;
        font-size: 12px;
      }
      .inv-table tr.inv-low td {
        color: #e05c5c;
        font-weight: 600;
      }
      .inv-table tr:hover td { background: #122614; }

      /* ── Buttons ── */
      .inv-actions { display: flex; gap: 6px; }
      .inv-btn {
        width: 28px; height: 28px;
        border: none; border-radius: 5px;
        font-size: 16px; font-weight: 700;
        cursor: pointer; line-height: 1;
        font-family: 'Cinzel', serif;
        transition: opacity 0.15s;
      }
      .inv-btn:hover { opacity: 0.8; }
      .inv-minus { background: #7a1f1f; color: #f0a0a0; border: 1px solid #e05c5c55; }
      .inv-plus  { background: #1a4a1a; color: #90d090; border: 1px solid #4caf5055; }
      .inv-btn-icon {
        background: transparent;
        border: none;
        color: #c9a84c99;
        cursor: pointer;
        font-size: 14px;
        padding: 2px 5px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      .inv-btn-icon:hover { background: #2a2a2a; color: #f0d080; }

      /* ── Setup Wizard ── */
      .inv-overlay {
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.75);
        z-index: 1000000;
        display: flex; align-items: center; justify-content: center;
      }
      .inv-wizard {
        background: #0d1f0f;
        color: #e8d9b0;
        border: 1px solid #c9a84c;
        border-radius: 12px;
        padding: 32px;
        width: 300px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        font-family: 'Cinzel', 'Georgia', serif;
        box-shadow: 0 8px 40px rgba(0,0,0,0.8);
      }
      .inv-wizard h2 {
        margin: 0;
        font-size: 16px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #f0d080;
        text-align: center;
      }
      .inv-wizard p {
        margin: 0;
        color: #a89060;
        font-size: 11px;
        text-align: center;
        letter-spacing: 0.05em;
      }
      .inv-wizard label {
        display: flex; flex-direction: column; gap: 7px;
        font-size: 11px; font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #c9a84c;
      }
      .inv-wizard select {
        padding: 9px; border-radius: 6px;
        background: #0a1a0c; color: #e8d9b0;
        border: 1px solid #c9a84c55;
        font-size: 12px;
        font-family: 'Cinzel', serif;
      }
      #inv-setup-save {
        padding: 11px; border-radius: 7px;
        background: #c9a84c; color: #141414;
        border: none; font-weight: 700;
        font-size: 12px; cursor: pointer;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        font-family: 'Cinzel', serif;
        transition: background 0.15s;
      }
      #inv-setup-save:hover { background: #f0d080; }

      /* ── Toasts ── */
      .inv-toast {
        position: fixed; bottom: 84px; right: 24px;
        padding: 10px 16px; border-radius: 7px;
        font-family: 'Cinzel', serif;
        font-size: 12px; z-index: 1000001;
        letter-spacing: 0.05em;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
        animation: inv-fadein 0.3s ease;
      }
      .inv-toast-success { background: #1a4a1a; color: #90d090; border: 1px solid #4caf5055; }
      .inv-toast-error   { background: #7a1f1f; color: #f0a0a0; border: 1px solid #e05c5c55; }
      .inv-toast-info    { background: #0a1a0c; color: #c9a84c;  border: 1px solid #c9a84c55; }

      @keyframes inv-fadein {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ─── GO ───────────────────────────────────────────────────────────────────
  init();

})();
