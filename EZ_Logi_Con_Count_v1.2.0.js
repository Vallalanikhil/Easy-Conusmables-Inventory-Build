// ==UserScript==
// @name         EZ Logi Con Count v1.2.0
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Inventory management for DCO consumables — CMH73
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      hooks.slack.com
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIGURATION ────────────────────────────────────────────────────────
  const CONFIG = {
    SLACK_WEBHOOK: 'https://hooks.slack.com/triggers/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',
    BUILDINGS: ['CMH73'],
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
  let inventory    = [];
  let alerted      = {};

  // ─── INIT ─────────────────────────────────────────────────────────────────
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
    const box     = createElement('div', 'inv-wizard');
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
      <button id="inv-setup-save">Save &amp; Continue</button>
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

  // ─── LAUNCH ───────────────────────────────────────────────────────────────
  function launchApp() {
    loadInventory();
    renderPanel();
    checkThresholds();
  }

  // ─── LOAD / SAVE (localStorage via GM) ───────────────────────────────────
  function loadInventory() {
    const saved = GM_getValue('inventory_' + userBuilding, null);
    if (saved) {
      allRows = JSON.parse(saved);
    } else {
      allRows = SEED_DATA.map(r => [...r]);
      saveInventory();
    }
    inventory = allRows.filter(r => r[COL.BUILDING] === userBuilding);
  }

  function saveInventory() {
    GM_setValue('inventory_' + userBuilding, JSON.stringify(allRows));
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
  }

  // ─── ADJUST QUANTITY ──────────────────────────────────────────────────────
  function adjustQty(localIdx, delta) {
    const globalIdx = allRows.indexOf(inventory[localIdx]);
    const current   = Number(allRows[globalIdx][COL.CURRENT]);
    const min       = Number(allRows[globalIdx][COL.MIN]);
    const max       = Number(allRows[globalIdx][COL.MAX]);
    const newQty    = Math.max(0, Math.min(max, current + delta));

    allRows[globalIdx][COL.CURRENT]  = newQty;
    inventory[localIdx][COL.CURRENT] = newQty;

    const qtyCell = document.getElementById(`qty-${localIdx}`);
    if (qtyCell) {
      qtyCell.textContent = newQty;
      qtyCell.closest('tr').classList.toggle('inv-low', newQty <= min);
    }

    saveInventory();

    if (newQty <= min) triggerSlackAlert(inventory[localIdx]);
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

    if (alerted[alertKey]) return;
    alerted[alertKey] = true;

    // Payload for Slack Workflow webhook
    const payload = {
      building: building,
      item: item,
      current: current,
      reorder: reorder,
      max: max
    };

    GM_xmlhttpRequest({
      method: 'POST',
      url: CONFIG.SLACK_WEBHOOK,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload),
      onload: res => {
        if (res.status !== 200) showToast(`Slack alert failed for ${item}`, 'error');
      },
      onerror: () => showToast(`Slack alert error for ${item}`, 'error'),
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
    let ox = 0, oy = 0;
    header.style.cursor = 'move';
    header.addEventListener('mousedown', e => {
      e.preventDefault();
      ox = e.clientX - el.offsetLeft;
      oy = e.clientY - el.offsetTop;
      const drag = e2 => {
        el.style.left = (e2.clientX - ox) + 'px';
        el.style.top  = (e2.clientY - oy) + 'px';
      };
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
      .inv-role-badge.logistics { background: #c9a84c; color: #0d1f0f; }
      .inv-role-badge.dco       { background: #8b6914; color: #f0d080; }
      .inv-body {
        padding: 12px;
        max-height: 320px;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #c9a84c44 transparent;
      }
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
      .inv-table tr.inv-low td { color: #e05c5c; font-weight: 600; }
      .inv-table tr:hover td { background: #122614; }
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
      .inv-btn-icon:hover { background: #122614; color: #f0d080; }
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
        margin: 0; font-size: 16px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #f0d080; text-align: center;
      }
      .inv-wizard p {
        margin: 0; color: #a89060;
        font-size: 11px; text-align: center;
        letter-spacing: 0.05em;
      }
      .inv-wizard label {
        display: flex; flex-direction: column; gap: 7px;
        font-size: 11px; font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase; color: #c9a84c;
      }
      .inv-wizard select {
        padding: 9px; border-radius: 6px;
        background: #0a1a0c; color: #e8d9b0;
        border: 1px solid #c9a84c55;
        font-size: 12px; font-family: 'Cinzel', serif;
      }
      #inv-setup-save {
        padding: 11px; border-radius: 7px;
        background: #c9a84c; color: #0d1f0f;
        border: none; font-weight: 700;
        font-size: 12px; cursor: pointer;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        font-family: 'Cinzel', serif;
        transition: background 0.15s;
      }
      #inv-setup-save:hover { background: #f0d080; }
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
