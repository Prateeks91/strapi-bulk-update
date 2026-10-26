# Strapi Plugin: Bulk Attribute & Relation Updater

<div align="center">

# ⚡ Bulk Attribute & Relation Updater for Strapi v5

**Cross-Collection Mass Attribute & Relationship Updates with Schema Safety, Enterprise Maker-Checker Governance, Off-Peak Scheduling, and 3-Tier Audit Rollback.**

[![npm version](https://img.shields.io/npm/v/strapi-plugin-bulk-updater.svg?style=flat-square)](https://www.npmjs.com/package/strapi-plugin-bulk-updater)
[![Strapi v5 Compatible](https://img.shields.io/badge/Strapi-v5.x-4945ff.svg?style=flat-square)](https://strapi.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://github.com/Prateeks91/strapi-bulk-update/pulls)

</div>

---

## 🚀 Why Bulk Updater?

Strapi allows editing entries individually or applying bulk actions within a single collection type. However, real-world content teams, enterprise marketing ops, and compliance managers often need to:

1. **Update attributes across multiple collection types simultaneously** (e.g. updating a brand tagline, SEO meta description, department name, or compliance disclaimer).
2. **Bulk-assign or update entity relationships** across content types (e.g. re-assigning articles to a new author, or associating multiple products with a promotion category).
3. **Enforce enterprise Maker-Checker approval governance** so junior editors can propose changes that senior compliance officers review and approve.
4. **Prevent database strain during peak traffic** by scheduling bulk operations for off-peak hours in a server-enforced business timezone.
5. **Decide whether updates should auto-publish or remain as drafts** in Strapi v5 Draft & Publish collections.
6. **Safely undo changes with one-click reversible rollback** backed by before/after audit snapshots.

---

## ✨ Features at a Glance

- 🔍 **Dynamic Cross-Collection Discovery**: Introspects all registered content types and attributes in your Strapi v5 instance.
- 🎯 **Separate Search vs Update Attributes**: Search and filter by one attribute, relation, or nested component in Section 2, while targeting a distinct attribute to update in Section 1. Side-by-side table columns display both searched and target values simultaneously.
- 🌲 **Configurable Component Nesting Depth (Levels 1–5)**: User-controlled depth exploration in the UI (`L1` to `L5`), persistent across sessions. Fully supports recursive component schema introspection, deep population, query filtering, and safe leaf mutation preserving sibling component properties.
- 🚀 **Direct Bulk Publishing & Auto-Publish Toggle**: Directly publish draft records in bulk across multiple collections without editing values, plus an auto-publish toggle that instantly publishes updated documents for draft-enabled content types.
- 📑 **Excel-Safe Bulk CSV Export**: RFC-4180 compliant CSV export with UTF-8 BOM and CRLF line breaks for seamless opening in Microsoft Excel and Numbers, with full recursive nested component support.
- 🔍 **Interactive Pre-Update Change Preview**: Inspect real-time before-and-after diffs with impact classification (`Will Update`, `Unchanged`, `Will Skip`) prior to executing batch updates.
- 🔎 **Searchable Combobox Attribute & Entity Picker**:
  - Instant fuzzy and substring search across all scalar fields, relations, and nested component paths.
  - Interactive visual badges for relation targets (`relation ➔ Target`) and component nesting levels (`L1 component`, `L2 component`).
- 🔗 **Full Relational Field Support**:
  - Supports `manyToOne`, `oneToOne`, `oneToMany`, and `manyToMany` relations.
  - Interactive searchable target entity dropdown populated directly from target collection records.
  - Relational update modes: **Set / Overwrite**, **Add / Connect**, **Remove / Disconnect**, and **Clear / Unlink**.
  - Human-readable relation labels (`formatDisplayValue`) throughout the UI, confirmation modal, queue, and audit diffs.
- 👥 **Enterprise Maker-Checker Governance**:
  - Two-person rule: Makers propose bulk changes; authorized Checkers review detailed diffs before approval and execution.
  - Interactive Approvals Queue tab with status tracking (`PENDING`, `APPROVED`, `REJECTED`, `EXECUTED`).
  - **4-Eyes Bulk Review Modal**: Side-by-side before & after diff inspector, itemized row-level change tracking, change KPI metrics breakdown (total, updates, creates, unchanged, skipped), and one-click offline CSV diff report export for compliance sign-off.
- 🕒 **Timezone-Aware Off-Peak Scheduling**:
  - Configured at server init time via `config/plugins.ts`.
  - Server strictly enforces timezone evaluation via native `Intl.DateTimeFormat`.
  - Blocks high-load batch updates during business hours and queues them for off-peak execution window with auto-wake processing.
- 📝 **Draft & Publish Granular Control**:
  - Dedicated publishing mode toggle: **"Publish immediately upon execution"** vs **"Keep as draft"**.
  - Transparent queue badging (`AUTO-PUBLISH` vs `DRAFT ONLY`).
- 👁️ **Per-Collection Dynamic Column Visibility**:
  - Customizable visible columns per collection type with zero deep nesting architecture.
  - Independent column selections, responsive horizontal scrolling, and accessible table headers.
- 🛡️ **Zero-Config Built-In Audit Trail & One-Click Rollback**:
  - **Native Plugin Schema**: Automatically provisions `bulk_updater_audit_logs` in your database on startup — **zero caller setup required**.
  - **Convention Auto-Discovery**: Seamlessly detects and mirrors custom app collections (`api::audit-log.audit-log`).
  - **Strapi Enterprise Bridge**: Bridges events directly to native Strapi Enterprise Audit Logs (`admin::audit-logs`).
  - **Deterministic Rollback**: Restores exact prior values and relationship links using Strapi v5 Document Service.
- ⚡ **Server-Side Filter & Full-Text Search Pushdown**:
  - Pushes text searches and attribute filters (`equals`, `contains`, `empty`, `starts_with`) directly to the database.
  - Automatically hides non-matching records and pre-selects matching rows with real-time match counters.
  - Scalable server-side pagination up to 500 records per page with a one-click "Load all entries" button.
- 🌓 **Adaptive Light & Dark Theme Design**: Built with native `@strapi/design-system` tokens with high-contrast text and sticky viewport-constrained modals.
- ⚡ **Zero-Infra Strapi Cloud Ready**: In-memory caching, pod-level high-watermark ETags, zero external Redis/SQL requirements.

---

## 📦 Installation

```bash
# Using npm
npm install strapi-plugin-bulk-updater

# Using yarn
yarn add strapi-plugin-bulk-updater

# Using pnpm
pnpm add strapi-plugin-bulk-updater
```

---

## ⚙️ Configuration

Enable the plugin in your Strapi project's `config/plugins.ts` (or `config/plugins.js`):

### 1. Basic Setup (Zero-Config)

```typescript
// config/plugins.ts
export default () => ({
  'bulk-updater': {
    enabled: true,
  },
});
```

### 2. Full Enterprise Configuration

```typescript
// config/plugins.ts
export default () => ({
  'bulk-updater': {
    enabled: true,
    config: {
      // Allowed collections for bulk updates
      collections: [
        'api::article.article',
        'api::employee.employee',
        'api::job.job',
        'api::product.product',
      ],

      // Timezone-aware off-peak execution guardrails
      executionTime: {
        businessHours: {
          start: '09:00',
          end: '18:00',
          timezone: 'America/New_York', // Any valid IANA timezone string
        },
        offPeakOnly: true, // Block direct execution during business hours
      },

      // Enterprise governance
      makerChecker: {
        enabled: true, // Requires checker approval before batch execution
      },

      // 3-Tier Audit Logging Configuration
      audit: {
        enabled: true,
        // Optional: Custom collection type. If omitted, Tier 1 auto-discovers 'api::audit-log.audit-log'
        contentType: 'api::audit-log.audit-log',
        fields: {
          batchId: 'batchId',
          attribute: 'attribute',
          value: 'value',
          userEmail: 'userEmail',
          userName: 'userName',
          diffs: 'diffs',
          isRolledBack: 'isRolledBack',
          rolledBackAt: 'rolledBackAt',
          rolledBackBy: 'rolledBackBy',
          executedAt: 'executedAt',
        },
      },
    },
  },
});
```

Rebuild your Strapi admin panel and start the server:

```bash
npm run build
npm run develop
```

---

## 🖥️ How It Works

### 1. Workspace & Dynamic Attribute Selection
1. Navigate to **Plugins > Bulk Attribute Updater** in your Strapi Admin Panel.
2. Select your target **Collection Type** (e.g. `Article`, `Employee`).
3. Choose the **Attribute to Update** from the dynamic dropdown:
   - **Scalar attributes**: String, Text, Number, Boolean, Enumeration, etc.
   - **Relation attributes**: Displayed with badges such as `author (relation ➔ Author)` or `categories (relation ➔ Category)`.
4. Enter the new value or select a target entity from the relation combobox.
5. Filter, sort, or customize visible columns with the **Columns** dropdown.
6. Select target records using individual checkboxes or the select-all header.

### 2. Confirmation Modal with Sticky Controls
- Inspect the update summary, target entity details, and before/after previews.
- Toggle **"Publish immediately upon execution"** (checked by default for Draft & Publish content types).
- If operating during business hours under an off-peak policy, click **Queue for Off-Peak** or **Submit for Checker Approval**.

### 3. Maker-Checker Approvals Queue
- Switch to the **Pending Approvals & Queued Batches** tab.
- Makers can review their queued proposals.
- Authorized Checkers can review detailed before/after diffs, approve, reject, or trigger execution.

### 4. Audit Trail & Deterministic Version Rollback
- Switch to the **Audit Trail & Rollback History** tab.
- View chronological execution history with admin authorship and timestamps.
- Click **View Diffs** to inspect previous vs applied values.
- Click **Rollback Batch** to revert documents and relationship links back to their exact prior state.

---

## 🎯 UI-Configurable Validation & Quota Rules & Legacy Violation Scanner

Define dynamic semantic constraints across components and dynamic zones right from the Strapi UI:

- Navigate to **Bulk Attribute Updater > Validation & Quota Rules** or **Settings > Bulk Updater Settings**.
- Click **Create Rule**.
- Set **Rule Name**, **Target Field Identifier** (e.g. `headingLevel`), and configure **Option Quotas** (e.g. `h1` = 1, `h2` = 3).
- Toggle rules on/off or delete them at any time. Rules take effect immediately in both the Strapi Admin content editing form and backend Document Service create/update validations.
- **Legacy Violation Scanner**:
  - Click **Scan Violations** on any active rule card to instantly audit all existing legacy entries across target content types.
  - Review non-compliant records and exact violation reasons (e.g. `Found 2 occurrences of "h1", exceeds quota limit of 1`).
  - Click **Export Violations (CSV)** directly from the modal to take the affected records offline for correction or batch re-import.

---

## 📊 CSV Export / Import & Override Engine

For high-volume operations or legacy data remediation, the plugin includes a full-featured CSV Management Center:

1. **Direct Workspace Export**:
   - On the primary workspace table, click the **Export CSV** button on any collection card to download the currently filtered view directly to your workstation.
2. **Dedicated CSV Manager Tab**:
   - Switch to the **CSV Import / Export** tab in the plugin header.
   - Select any registered collection type.
   - **Download Template**: Get a ready-to-use CSV file pre-populated with all schema column headers.
   - **Export All Records**: Download the complete dataset with a single click.
   - **Export Violations**: Filter and export only records violating a selected Validation Rule.
3. **Flexible Import Modes**:
   - **Update Existing Records (`documentId` matching)**: Match entries by `documentId` and selectively update specific scalar fields and relation references without touching other attributes.
   - **Add / Override Multiple Records**: Insert fresh records in bulk directly from your spreadsheet without requiring pre-existing IDs.
   - **Dry-Run Audit**: Real-time validation audit shows total rows parsed, records updated vs created, and immediate error reporting before committing to the database.

---

## 🛠️ API Reference

All routes are mounted under `/bulk-updater` and protected by Strapi Admin authentication:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/bulk-updater/models` | Returns collections, attributes, and entries with schema introspection. |
| `GET` | `/bulk-updater/relation-options?targetUid=...` | Fetches relation candidate records for target content types. |
| `POST` | `/bulk-updater/batch-update` | Submits or queues a bulk update payload. |
| `GET` | `/bulk-updater/pending-batches` | Returns list of pending maker-checker batches and off-peak queues. |
| `GET` | `/bulk-updater/batches/:batchId/diffs` | Retrieves itemized before/after entry diffs and KPI metrics for Checker review. |
| `GET` | `/bulk-updater/batches/:batchId/diffs/export` | Exports itemized batch diffs as an offline CSV report for compliance audit. |
| `POST` | `/bulk-updater/pending-batches/:id/approve` | Approves a pending batch (Checker action). |
| `POST` | `/bulk-updater/pending-batches/:id/reject` | Rejects a pending batch with reason notes. |
| `POST` | `/bulk-updater/pending-batches/:id/execute` | Executes an approved or off-peak queued batch. |
| `GET` | `/bulk-updater/audit/history` | Fetches audit log history and diffs. |
| `POST` | `/bulk-updater/audit/:batchId/rollback` | Rolls back a batch to its prior state. |
| `GET` | `/bulk-updater/validation-rules` | Retrieves all UI-configured validation and quota rules. |
| `POST` | `/bulk-updater/validation-rules` | Creates or updates a validation and quota rule. |
| `DELETE` | `/bulk-updater/validation-rules/:id` | Deletes a validation rule. |
| `POST` | `/bulk-updater/validation-rules/:id/toggle` | Toggles rule active status. |
| `POST` | `/bulk-updater/validation-rules/:id/scan` | Scans all existing records in target content types for violations. |
| `POST` | `/bulk-updater/preview` | Generates a dry-run diff preview across target entries before update. |
| `POST` | `/bulk-updater/publish` | Bulk publishes selected draft entries across multiple collections. |
| `POST` | `/bulk-updater/export-selected` | Exports selected entries across collections to Excel-compatible CSV. |
| `GET` | `/bulk-updater/collections/:uid/entries` | Paginated and filtered collection entries with search attribute pushdown. |
| `GET` | `/bulk-updater/csv/template/:uid` | Generates a blank CSV template with content type headers. |
| `GET` | `/bulk-updater/csv/export/:uid` | Exports all records for a collection type as CSV. |
| `GET` | `/bulk-updater/csv/export-violations/:ruleId` | Exports only records violating the specified rule as CSV. |
| `POST` | `/bulk-updater/csv/import` | Parses and applies or inserts records from uploaded CSV data. |

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues and pull requests:

1. Fork the repository: [https://github.com/Prateeks91/strapi-bulk-update](https://github.com/Prateeks91/strapi-bulk-update)
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more details.

---

<div align="center">
  Maintained by <b><a href="https://github.com/Prateeks91">Prateek Srivastava</a></b> (strapi-utills)
</div>
