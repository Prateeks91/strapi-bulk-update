# Publishing & Release Guide

This guide provides step-by-step instructions to push the plugin to GitHub at **`https://github.com/Prateeks91/strapi-bulk-update.git`** and publish the plugin to the npm registry.

---

## 📋 Pre-Requisites

1. **GitHub Account Access**: Ensure you have write access to [https://github.com/Prateeks91/strapi-bulk-update](https://github.com/Prateeks91/strapi-bulk-update).
2. **npm Account**: An active account at [npmjs.com](https://www.npmjs.com) with 2FA enabled. If publishing as scoped `@strapi-utills/strapi-plugin-bulk-updater`, ensure the `strapi-utills` organization or team is created on npm.
3. **Node.js**: Version 18.x to 22.x.

---

## 🐙 Step 1: Push to GitHub

The local repository is already initialized on branch `main` with remote origin set to `https://github.com/Prateeks91/strapi-bulk-update.git`.

Simply run:

```bash
cd /Users/prateeksrivastava/Desktop/pocs/strapi-plugin-bulk-updater

# Push to GitHub
git push -u origin main
```

---

## 📦 Step 2: Test & Build the npm Distribution

Before publishing to npm, verify that the build succeeds and only the expected production files are bundled into the package tarball.

### 2.1 Build the Production Artifacts
Using `@strapi/pack-up`:

```bash
# Build admin and server bundles into dist/
npm run build
```

### 2.2 Dry-Run Pack Verification
Run `npm pack --dry-run` to preview the exact package contents:

```bash
npm pack --dry-run
```

Expected bundled files in the tarball:
- `dist/admin/index.js` & `dist/admin/index.mjs`
- `dist/server/index.js` & `dist/server/index.mjs`
- `strapi-admin.js`
- `strapi-server.js`
- `package.json`
- `README.md`
- `LICENSE`

*(Note: Raw TypeScript sources under `admin/src/` and `server/src/`, as well as `node_modules/` and tests, are strictly excluded from the package tarball.)*

---

## 🚀 Step 3: Publish to npm

### 3.1 Choose Package Naming: Scoped vs Unscoped

- **Option A: Unscoped (`strapi-plugin-bulk-updater`)**
  If `strapi-plugin-bulk-updater` is available on npm:
  `package.json` currently has:
  ```json
  "name": "strapi-plugin-bulk-updater"
  ```

- **Option B: Scoped (`@strapi-utills/strapi-plugin-bulk-updater`)**
  If you prefer publishing under your organization scope:
  Edit `package.json`:
  ```json
  "name": "@strapi-utills/strapi-plugin-bulk-updater"
  ```

### 3.2 Login to npm
In your terminal, log in to your npm account:

```bash
npm login
```
Enter your username, password, and OTP / 2FA code.

Verify your login status:
```bash
npm whoami
```

### 3.3 Test with a Dry-Run
```bash
npm publish --dry-run --access public
```

### 3.4 Publish the Plugin!
```bash
npm publish --access public
```

---

## 🏷️ Step 4: Create a GitHub Release & Tag

Once pushed and published, create a Git tag and GitHub release:

```bash
git tag -a v1.3.0 -m "Release v1.3.0: Separate Search Attributes, Configurable Component Depth (L1-L5), Bulk Publish & Excel Export"
git push origin v1.3.0
```

1. Go to [https://github.com/Prateeks91/strapi-bulk-update/releases/new](https://github.com/Prateeks91/strapi-bulk-update/releases/new).
2. Select tag `v1.3.0`.
3. Title: `v1.3.0 - Separate Search Attributes, Configurable Component Depth, Bulk Publish & Excel Export`
4. Paste the feature highlights from `README.md`.
5. Click **Publish release**.

---

## 🌟 Step 5: Submit to Strapi Marketplace

To get featured in the official [Strapi Marketplace](https://market.strapi.io/):

1. Ensure the package name starts with `strapi-plugin-` or `@<scope>/strapi-plugin-`.
2. Ensure `package.json` includes `strapi` in its `keywords` array and contains the `strapi` configuration block.
3. Submit your plugin via [Strapi Marketplace Submission Form](https://strapi.io/marketplace).

---

## 🔄 Releasing Future Versions

For future bug fixes or features:

```bash
# 1. Bump version (patch: 1.0.1, minor: 1.1.0, major: 2.0.0)
npm version patch

# 2. Build and verify
npm run build
npm pack --dry-run

# 3. Push commits and tags to GitHub
git push origin main --follow-tags

# 4. Publish to npm
npm publish --access public
```
