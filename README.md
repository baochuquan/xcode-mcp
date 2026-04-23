# @baochuquan/xcode-mcp

An MCP (Model Context Protocol) server that exposes Xcode tooling — project
inspection, file operations, builds, archives, simulator control, CocoaPods
and Swift Package Manager — to AI assistants.

Installable via `npx`. No clone, no local build, no `.env` file.

> Derived from [r-huijts/xcode-mcp-server](https://github.com/r-huijts/xcode-mcp-server)
> (MIT). The tool surface is preserved 1:1; the installation, configuration
> and entry point are repackaged for one-line distribution.

---

## Quick start

Add this to your MCP client config (Claude Desktop, Cursor, Cline, …):

```json
{
  "mcpServers": {
    "xcode": {
      "command": "npx",
      "args": ["-y", "@baochuquan/xcode-mcp"],
      "env": {
        "PROJECTS_BASE_DIR": "/Users/you/Code"
      }
    }
  }
}
```

Restart your MCP client. Done.

> First launch downloads the package (~few MB) and may take 5–15 seconds.
> Subsequent launches use the npx cache and start in milliseconds.

### Lock to a specific version

```json
"args": ["-y", "@baochuquan/xcode-mcp@0.1.0"]
```

### Upgrade

```bash
npm cache clean --force                  # optional, forces a fresh fetch
npx -y @baochuquan/xcode-mcp@latest      # next client launch picks it up
```

---

## Configuration

All configuration is read at startup from environment variables (set in your
MCP client's `env` block) or CLI flags. The server never reads `process.cwd()`
or a `.env` file — every value comes from the client config, so the same
config travels across machines.

| Variable | CLI flag | Required | Description |
|---|---|---|---|
| `PROJECTS_BASE_DIR` | `--projects-dir=` | yes | Absolute path to the directory containing your Xcode projects. Used as the default file-access boundary. |
| `XCODE_MCP_TOOLS` | — | no | Comma-separated list of tool groups to expose. Defaults to all. Example: `project,file,build`. Unknown names are warned-about but tolerated. |
| `ALLOWED_PATHS` | `--allowed-paths=` | no | Extra absolute paths that tools may read/write. Comma-separated. |
| `DEBUG` | `--debug` | no | `true` enables verbose stderr diagnostics. |
| `LOG_LEVEL` | `--log-level=` | no | One of `error|warn|info|debug`. Default `info`. |

CLI flags override environment variables when both are present.

### Tool groups

| Id | Tools | External requirement |
|---|---|---|
| `project` | project discovery, scheme/target listing, set active project | none |
| `file` | read/write/list/search project files | none |
| `build` | `xcodebuild` build/test/clean/archive | Xcode |
| `xcode` | misc Xcode utilities (devicectl, app icons, etc.) | Xcode |
| `cocoapods` | `pod install`, `pod update` | CocoaPods (lazy-checked) |
| `spm` | Swift Package Manager commands | Swift toolchain |
| `simulator` | iOS Simulator control via `simctl` | Xcode |

Optional dependencies (e.g. CocoaPods) are checked **at tool invocation
time**, not at startup — so a missing `pod` does not prevent the rest of the
server from working.

---

## Examples

### Restrict to inspection-only tools

```json
"env": {
  "PROJECTS_BASE_DIR": "/Users/you/Code",
  "XCODE_MCP_TOOLS": "project,file"
}
```

### Allow access to a sibling configuration directory

```json
"env": {
  "PROJECTS_BASE_DIR": "/Users/you/Code",
  "ALLOWED_PATHS": "/Users/you/.config/fastlane,/Users/you/Library/Developer/Xcode/DerivedData"
}
```

### Debug a startup failure

```json
"env": {
  "PROJECTS_BASE_DIR": "/Users/you/Code",
  "DEBUG": "true",
  "LOG_LEVEL": "debug"
}
```

---

## Migration from `r-huijts/xcode-mcp-server`

If you previously cloned the upstream and configured Claude Desktop with an
absolute `node` path:

1. Replace your `mcpServers.xcode` block with the JSON above.
2. Move whatever you had in `.env` into the `env` block.
3. Restart your MCP client.

There is no need to touch the upstream clone; the two packages can coexist.

---

## Development

```bash
git clone https://github.com/baochuquan/xcode-mcp.git
cd xcode-mcp
npm install
npm run build      # esbuild → dist/
npm test           # node --test
npm run typecheck  # optional, scoped tsc --noEmit
```

The `build` step uses esbuild rather than `tsc` because the combination of
zod's recursive types and the SDK's deep generics exhausts >8GB of TypeScript
heap on this codebase. Type checking is available as an opt-in lint via
`npm run typecheck`.

### Publishing

Tagged commits trigger an npm publish via GitHub Actions:

```bash
npm version patch  # or minor / major
git push --follow-tags
```

---

## License

MIT. Original copyright remains with R.Huijts and the Xcode MCP Server
Contributors. See `LICENSE` for the derived-work statement.
