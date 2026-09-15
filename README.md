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
- 🔗 **Full Relational Field Support**:
  - Supports `manyToOne`, `oneToOne`, `oneToMany`, and `manyToMany` relations.
  - Interactive target entity dropdown populated directly from target collection records.
  - Relational update modes: **Set / Overwrite**, **Add / Connect**, **Remove / Disconnect**, and **Clear / Unlink**.
  - Human-readable relation labels (`formatDisplayValue`) throughout the UI, confirmation modal, queue, and audit diffs.
- 👥 **Enterprise Maker-Checker Governance**:
  - Two-person rule: Makers propose bulk changes; authorized Checkers review detailed diffs before approval and execution.
  - Interactive Approvals Queue tab with status tracking (`PENDING`, `APPROVED`, `REJECTED`, `EXECUTED`).
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
- 🛡️ **Flexible 3-Tier Audit Architecture & One-Click Rollback**:
  - **Tier 1 (Zero-Config)**: Auto-detects standard audit collections (`api::audit-log.audit-log`).
  - **Tier 2 (Strapi Enterprise Bridge)**: Bridges events directly to native Strapi Enterprise Audit Logs (`admin::audit-logs`).
  - **Tier 3 (Custom Declarative Schema)**: Custom collection types and declarative column mappings.
  - **Deterministic Rollback**: Restores exact prior values and relationship links using Strapi v5 Document Service.
- 🌓 **Adaptive Light & Dark Theme Design**: Built with native `@strapi/design-system` tokens with high-contrast text and sticky viewport-constrained modals.
- ⚡ **Zero-Infra Strapi Cloud Ready**: In-memory caching, pod-level high-watermark ETags, zero external Redis/SQL requirements.
- 💎 **Pro Monetization Tier**: License key activation, Regex Find & Replace within attributes, and priority SLA.

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

## 💎 Monetization & License Tiers

| Feature | Community (Free) | Pro / Enterprise Tier |
| :--- | :---: | :---: |
| Dynamic schema & attribute introspection | ✅ | ✅ |
| Cross-collection selection | ✅ | ✅ |
| Conditional schema validation & skip safety | ✅ | ✅ |
| Live execution report | ✅ | ✅ |
| Draft & Publish control | ✅ | ✅ |
| Per-collection column visibility | ✅ | ✅ |
| Relational field bulk updates | ✅ | ✅ |
| 3-Tier Audit Trail & Rollback | ✅ | ✅ |
| Enterprise Maker-Checker flow | ✅ | ✅ |
| Timezone-aware off-peak scheduling | ✅ | ✅ |
| **Regex Find & Replace within attributes** | ❌ | ✅ |
| **Audit log export (CSV / JSON)** | ❌ | ✅ |
| **Commercial License & Priority SLA** | ❌ | ✅ |

### License Activation
Enter your license key in **Settings > Bulk Updater License** to unlock Pro features.

---

## 🛠️ API Reference

All routes are mounted under `/bulk-updater` and protected by Strapi Admin authentication:

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/bulk-updater/models` | Returns collections, attributes, and entries with schema introspection. |
| `GET` | `/bulk-updater/relation-options?targetUid=...` | Fetches relation candidate records for target content types. |
| `POST` | `/bulk-updater/batch-update` | Submits or queues a bulk update payload. |
| `GET` | `/bulk-updater/pending-batches` | Returns list of pending maker-checker batches and off-peak queues. |
| `POST` | `/bulk-updater/pending-batches/:id/approve` | Approves a pending batch (Checker action). |
| `POST` | `/bulk-updater/pending-batches/:id/reject` | Rejects a pending batch with reason notes. |
| `POST` | `/bulk-updater/pending-batches/:id/execute` | Executes an approved or off-peak queued batch. |
| `GET` | `/bulk-updater/audit/history` | Fetches audit log history and diffs. |
| `POST` | `/bulk-updater/audit/:batchId/rollback` | Rolls back a batch to its prior state. |
| `GET` | `/bulk-updater/license` | Checks current license status. |
| `POST` | `/bulk-updater/license/verify` | Activates and verifies a Pro license key. |
| `POST` | `/bulk-updater/license/deactivate` | Deactivates an active Pro license key. |

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
