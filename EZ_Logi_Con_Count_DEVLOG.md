# ⚙️ EZ LOGI CON COUNT — DEV LOG
### Consumable Inventory Manager for DCO | CMH73 Pilot

---

> *All changes, fixes, and additions across every version of the script.*
> *Maintained by the CMH73 DCO team.*

---

## ═══════════════════════════════════════
## 📦 VERSION 1.4.3
### *"Loud and Clear"*
#### Status: CURRENT RELEASE
## ═══════════════════════════════════════

### 🐛 FIXES
- Slack Workflow payload field names corrected — `building`, `item_needed`, `current_qty`, `reorder_qty`, `max_qty` now match Workflow Builder variable names explicitly
- Daily digest payload updated to use the same consistent field names
- Resolves Workflow not displaying building name or item needed in channel messages

---

## ═══════════════════════════════════════
## 📦 VERSION 1.4.2
### *"Morning Briefing"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **Daily Digest Alert** — Once per calendar day, fires a single bundled Slack message listing all items currently at or below their minimum threshold, including item name, current quantity, and suggested reorder amount
- **Digest Deduplication** — Last sent date stored in localStorage so the digest only fires once per day even if multiple users have the script open simultaneously

### 🔧 CHANGES
- Daily digest fires on page load alongside the existing per-item threshold check
- If no items are low, no digest is sent — channel stays clean on good inventory days

---

## ═══════════════════════════════════════
## 📦 VERSION 1.4.1
### *"Sheet Happens"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **Google Sheets Backend** — All inventory data now reads from and writes to Google Sheets via a Google Apps Script web app endpoint — no Microsoft tokens, no IT dependency
- **Live Item Push** — Every quantity change immediately POSTs only the changed item to Google Sheets (lightweight, no full rewrite)
- **Hourly Re-fetch** — Sync timer now pulls a fresh full read from Google Sheets every hour, picking up any direct edits logistics makes to the spreadsheet

### 🔧 CHANGES
- Removed all SharePoint / Microsoft Graph API code entirely
- Removed MSAL token auth logic — no longer needed
- Sync button (🔄) now triggers a full re-fetch from Google Sheets and refreshes the panel table
- SP status indicator now reflects Google Sheets connection status
- Header tooltip updated to reference Google Sheets instead of SharePoint

### 🐛 FIXES
- Eliminated all remaining Microsoft auth dependencies that caused offline fallback on every load

---

## ═══════════════════════════════════════
## 📦 VERSION 1.4.0
### *"On Target"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **QR Scan Auto-Deduction** — Hand scanner firing a QR label URL silently deducts 1 from the matching item in the background, saves locally, and fires a Slack alert if threshold is breached — no popup, no page reload, works while minimized
- **Boost-URL QR Encoding** — All QR codes now encode the Boost URL (`https://myday-website.cmh.aws-border.com`) so hand scanners always hit the correct page
- **Print Sheet URL Updated** — `CMH73_QR_Print_Sheet.html` updated to use the live Boost URL in all labels

### 🔧 CHANGES
- Script now restricted to Boost only — `@match` locked to `https://myday-website.cmh.aws-border.com/*`, no longer runs on every website
- Token prompt popup removed — auth failure now silently falls to offline/local cache mode with no interruption to the user

### 🐛 FIXES
- Eliminated disruptive token prompt dialog that appeared on every script load
- QR codes previously encoded raw JSON — now encode actionable Boost URLs compatible with hand scanners

---

## ═══════════════════════════════════════
## 📦 VERSION 1.3.1
### *"The Full Kit — Revised"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### 🔧 CHANGES
- CSV inventory data merged directly into the v1.3.0 build, promoting it to v1.3.1
- All v1.3.0 features confirmed stable: QR Code Generator, Print Label Support, SharePoint Fallback, SP Status Indicator, Manual Sync Button, Improved Setup Wizard, Viewport-Bounded Dragging, Stable Drag Anchoring

---

## ═══════════════════════════════════════
## 📦 VERSION 1.3.0
### *"The Full Kit"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **QR Code Generator** — Every inventory item now has a QR button (⬛) that generates a scannable code containing building, item name, min, and max quantity
- **Print Label Support** — QR modal includes a 🖨 Print Label button that opens a clean print-ready label in a new window
- **SharePoint Fallback System** — Script now attempts SharePoint sync on load; if unavailable, falls back to local cache silently with an offline toast notification
- **SP Status Indicator** — Header now shows 🟢 (SharePoint connected) or 🟡 (offline/local cache) at a glance
- **Manual Sync Button** — 🔄 button in the header forces an immediate sync to SharePoint without waiting for the hourly timer
- **Improved Setup Wizard** — Settings wizard now opens as an overlay on top of the existing panel (non-destructive edit mode) with a ✕ close button and backdrop dismiss
- **Viewport-Bounded Dragging** — Panel can no longer be dragged off-screen; constrained to visible viewport at all times
- **Stable Drag Anchoring** — Fixed panel jumping when dragging by switching from bottom/right to top/left positioning on drag start

### 🔧 CHANGES
- Quantity adjustments now save to local cache immediately on every click, then push to SharePoint
- Sync timer now saves local cache AND pushes to SharePoint every hour
- Minimize button now locks panel width before collapsing to prevent layout reflow

### 🐛 FIXES
- Panel no longer jumps or resizes when minimized or dragged
- Wizard close button no longer triggers a full app re-launch when dismissed without saving

---

## ═══════════════════════════════════════
## 📦 VERSION 1.2.0
### *"Workflow Automation"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **Slack Workflow Integration** — Replaced Slack Block Kit payload with a clean key-value JSON payload compatible with Slack Workflow Builder webhooks
- **Workflow Variable Support** — Slack message now passes `building`, `item`, `current`, `reorder`, and `max` as discrete variables for use in Slack Workflow message templates
- **Updated Webhook URL** — Pointed to the active Logi Inventory Alert workflow webhook

### 🔧 CHANGES
- Removed manual Slack Block Kit message formatting in favor of Slack Workflow-driven message composition
- Logistics channel notification is now fully automated — no manual message construction required

### 🐛 FIXES
- Resolved Slack payload mismatch that caused silent alert failures with Workflow trigger webhooks

---

## ═══════════════════════════════════════
## 📦 VERSION 1.1.0
### *"Going Offline"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **CSV Seed Data Embedded** — Full CMH73 inventory (28 items) loaded directly from CSV data; no external data source required to run
- **localStorage Persistence** — Quantity changes now save locally via Tampermonkey's GM_setValue and persist between browser sessions
- **Self-Contained Operation** — Script runs entirely without SharePoint or Graph API; removed all token/auth requirements for this build phase

### 🔧 CHANGES
- Removed SharePoint Graph API dependency entirely for this version
- Removed hourly sync timer (no remote backend in this version)
- Removed manual sync button (not applicable without remote backend)
- Script now loads instantly on any page with no auth prompts

### 🐛 FIXES
- Eliminated "token required" prompt that blocked script from running due to Amazon tenant Graph API restrictions
- Resolved blank inventory panel caused by failed SharePoint fetch on first load

---

## ═══════════════════════════════════════
## 📦 VERSION 1.0.0
### *"First Drop"*
#### Status: SUPERSEDED
## ═══════════════════════════════════════

### ✅ NEW FEATURES
- **Initial Script Release** — First working build of EZ Logi Con Count
- **Floating Inventory Panel** — Dark green / gold themed draggable panel rendered on any page via Tampermonkey
- **Setup Wizard** — First-run wizard for selecting building (CMH73) and role (DCO or Logistics)
- **Role-Based Controls** — DCO role: minus quantity only | Logistics role: minus and plus quantity
- **Low Stock Highlighting** — Rows at or below minimum threshold turn red automatically
- **Slack Low Stock Alerts** — Fires a Slack notification to the logistics channel when any item hits its minimum threshold
- **Session Deduplication** — Each item only fires one Slack alert per browser session to prevent spam
- **Minimize / Restore** — Panel can be collapsed to header-only view and restored
- **Draggable Panel** — Panel can be repositioned anywhere on screen
- **Cinzel Gothic Font** — Readable gothic-style font (Cinzel via Google Fonts) applied throughout
- **Deep Green Theme** — Forest green (#0d1f0f) with gold (#c9a84c) accents chosen to contrast against Boost's dark blue UI
- **SharePoint Graph API Integration** — Auto-discovers SharePoint Site ID and Drive ID from existing Microsoft browser session
- **Hourly SharePoint Sync** — Pushes quantity changes back to the Excel file every 60 minutes
- **Column Structure Defined:**
  - `Building` | `Item Name` | `Current Qty` | `Maximum Qty` | `Minimum Qty thres.`

---

## ═══════════════════════════════════════
## 🗺️ KNOWN ISSUES & UPCOMING
## ═══════════════════════════════════════

| # | Issue / Feature | Status |
|---|---|---|
| 1 | SharePoint Graph API blocked by Amazon tenant IT policy | 🟡 Workaround in place (local cache) |
| 2 | Slack Workflow trigger payload format may need tuning per workflow config | 🟡 Monitor |
| 3 | Multi-building support (beyond CMH73) | 🔵 Planned |
| 4 | Real-time sync between multiple users on same building | 🔵 Planned |
| 5 | Item add/remove from within the panel (Logistics role) | 🔵 Planned |

---

*EZ Logi Con Count is an internal DCO tooling project — CMH73 Pilot*
*For issues or feature requests, bring them to the next dev session.*
