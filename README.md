# Compound Memory Installer

Install a private, Git-synced Obsidian memory vault and connect it to Codex through a local MCP bridge.

The public installer contains no personal notes, credentials, tokens, or private repository contents.

## Windows quick install

Run this version-pinned command in PowerShell on a new Windows computer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://raw.githubusercontent.com/Lujiuqin/compound-memory-installer/v0.1.0/install.ps1' | iex"
```

The installer checks prerequisites, opens GitHub device authentication, clones the private vault, registers the Codex plugin, installs `memoryctl`, and runs a health check.

Repository: https://github.com/Lujiuqin/compound-memory-installer

## Safety

- Memory tools can only access the configured Vault path.
- No delete tool is provided.
- Writes stop when unresolved Git conflicts are detected.
- The installer never stores GitHub tokens or overwrites a non-empty unrelated directory.
