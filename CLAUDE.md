## Releasing a new version

The release process is automated via GitHub Actions on tag push.

1. Bump the version with the helper script (updates `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the README badge in one shot):

   ```bash
   ./scripts/bump-version.sh patch   # 1.0.0 -> 1.0.1
   ./scripts/bump-version.sh minor   # 1.0.0 -> 1.1.0
   ./scripts/bump-version.sh major   # 1.0.0 -> 2.0.0
   ./scripts/bump-version.sh 1.2.3   # explicit version
   ```

2. Update `CHANGELOG.md` with the new version and changes.
3. Commit the version bump and changelog.
4. Tag the release and push:

   ```bash
   git tag v1.2.3
   git push --tags
   ```

The `.github/workflows/release.yml` workflow then:

- Re-applies the version to source files (idempotent with the bump-version script)
- Installs Linux build dependencies, runs the Rust test suite
- Builds the AppImage via `npm run tauri build -- --bundles appimage`
- Publishes a GitHub Release with auto-generated release notes and attaches the AppImage

No manual signing, notarization, or third-party tap is involved — the only artifact is the Linux AppImage on the Releases page.

## Local development

```bash
npm install
npm run tauri dev               # dev server with hot reload
npm run tauri build -- --bundles appimage   # build the AppImage locally
```

Rust tests:

```bash
cd src-tauri && cargo test
```
