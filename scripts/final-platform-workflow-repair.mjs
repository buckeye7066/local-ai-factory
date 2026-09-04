import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}
function write(path, text) {
  writeFileSync(path, text, "utf8");
}
function one(path, before, after) {
  const text = read(path);
  const count = text.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected one repair anchor, found ${count}`);
  }
  write(path, text.replace(before, after));
}

const tarExcludes = `            --exclude='*/node_modules' \\
            --exclude='*/node_modules/*' \\
            --exclude='*/__pycache__' \\
            --exclude='*/__pycache__/*' \\
            --exclude='*/.pytest_cache' \\
            --exclude='*/.pytest_cache/*' \\
            --exclude='*/.mypy_cache' \\
            --exclude='*/.mypy_cache/*' \\
            --exclude='*/.ruff_cache' \\
            --exclude='*/.ruff_cache/*' \\
            --exclude='*/.hypothesis' \\
            --exclude='*/.hypothesis/*' \\
            --exclude='*/.tox' \\
            --exclude='*/.tox/*' \\
            --exclude='*/.nox' \\
            --exclude='*/.nox/*' \\
            --exclude='*/.nyc_output' \\
            --exclude='*/.nyc_output/*' \\
            --exclude='*/.coverage' \\
            --exclude='*/.coverage.*' \\
            --exclude='*.pyc' \\
            --exclude='*.pyo' \\
            workspaces`;

one(
  ".github/workflows/factory-deck-cloud.yml",
  `      - name: Preserve exact candidate\n        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: factory-deck-seed-\${{ github.run_id }}\n          if-no-files-found: error\n          overwrite: true\n          include-hidden-files: true\n          retention-days: 14\n          path: |\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**`,
  `      - name: Pack immutable candidate with POSIX metadata\n        shell: bash\n        run: |\n          tar --create --file factory-deck-workspaces.tar \\\n${tarExcludes}\n\n      - name: Preserve exact candidate\n        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: factory-deck-seed-\${{ github.run_id }}\n          if-no-files-found: error\n          overwrite: true\n          include-hidden-files: true\n          retention-days: 14\n          path: |\n            .factory/**\n            factory-deck-workspaces.tar`,
);

one(
  ".github/workflows/factory-deck-cloud.yml",
  `      - name: Execute Windows proof without production secrets\n        shell: pwsh\n        env:\n          WORKSPACE_ROOT: "\${{ github.workspace }}/workspaces"\n          ALLOW_UNTRUSTED_SCRIPTS: "true"\n          CI: "true"\n        run: pnpm exec tsx src/cli/factory-platform-proof.ts record`,
  `      - name: Materialize immutable candidate\n        shell: pwsh\n        run: tar --extract --file factory-deck-workspaces.tar\n\n      - name: Execute Windows proof without production secrets\n        shell: pwsh\n        run: ./scripts/ci/run-windows-platform-proof.ps1 -WorkspaceRoot "\${{ github.workspace }}/workspaces"\n\n      - name: Stage Windows checkpoint evidence\n        if: always()\n        shell: pwsh\n        run: |\n          Remove-Item -Recurse -Force platform-evidence -ErrorAction SilentlyContinue\n          New-Item -ItemType Directory -Path platform-evidence | Out-Null\n          Copy-Item -Path .factory -Destination platform-evidence/.factory -Recurse -Force`,
);

one(
  ".github/workflows/factory-deck-cloud.yml",
  `          path: |\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**\n\n  macos:`,
  `          path: |\n            platform-evidence/**\n\n  macos:`,
);

one(
  ".github/workflows/factory-deck-cloud.yml",
  `      - name: Restore Windows-verified candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-windows-\${{ github.run_id }}\n          path: .\n\n      - name: Execute macOS proof without production secrets\n        shell: pwsh\n        env:\n          WORKSPACE_ROOT: "\${{ github.workspace }}/workspaces"\n          ALLOW_UNTRUSTED_SCRIPTS: "true"\n          CI: "true"\n        run: pnpm exec tsx src/cli/factory-platform-proof.ts record`,
  `      - name: Restore immutable seed candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-seed-\${{ github.run_id }}\n          path: .\n\n      - name: Restore Windows checkpoint evidence\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-windows-\${{ github.run_id }}\n          path: platform-evidence\n\n      - name: Materialize immutable candidate\n        shell: bash\n        run: tar --extract --file factory-deck-workspaces.tar\n\n      - name: Apply Windows checkpoint evidence\n        shell: bash\n        run: |\n          rm -rf .factory\n          cp -R platform-evidence/.factory .factory\n\n      - name: Execute macOS proof without production secrets\n        shell: bash\n        run: bash scripts/ci/run-macos-platform-proof.sh "\${{ github.workspace }}/workspaces"\n\n      - name: Stage macOS checkpoint evidence\n        if: always()\n        shell: bash\n        run: |\n          rm -rf platform-evidence\n          mkdir -p platform-evidence\n          cp -R .factory platform-evidence/.factory`,
);

one(
  ".github/workflows/factory-deck-cloud.yml",
  `          path: |\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**\n\n  build:`,
  `          path: |\n            platform-evidence/**\n\n  build:`,
);

one(
  ".github/workflows/factory-deck-cloud.yml",
  `      - name: Restore cross-platform candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-macos-\${{ github.run_id }}\n          path: .`,
  `      - name: Restore immutable seed candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-seed-\${{ github.run_id }}\n          path: .\n\n      - name: Restore macOS checkpoint evidence\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: factory-deck-macos-\${{ github.run_id }}\n          path: platform-evidence\n\n      - name: Materialize immutable candidate\n        shell: bash\n        run: tar --extract --file factory-deck-workspaces.tar\n\n      - name: Apply macOS checkpoint evidence\n        shell: bash\n        run: |\n          rm -rf .factory\n          cp -R platform-evidence/.factory .factory`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `      - name: Preserve exact candidate\n        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: purpose-foundry-seed-\${{ github.run_id }}\n          if-no-files-found: error\n          overwrite: true\n          include-hidden-files: true\n          retention-days: 14\n          path: |\n            purpose-foundry-seed-server.log\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**`,
  `      - name: Pack immutable candidate with POSIX metadata\n        shell: bash\n        run: |\n          tar --create --file purpose-foundry-workspaces.tar \\\n${tarExcludes}\n\n      - name: Preserve exact candidate\n        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: purpose-foundry-seed-\${{ github.run_id }}\n          if-no-files-found: error\n          overwrite: true\n          include-hidden-files: true\n          retention-days: 14\n          path: |\n            purpose-foundry-seed-server.log\n            .factory/**\n            purpose-foundry-workspaces.tar`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `      - name: Execute Windows proof without production secrets\n        shell: pwsh\n        env:\n          WORKSPACE_ROOT: "\${{ github.workspace }}/workspaces"\n          ALLOW_UNTRUSTED_SCRIPTS: "true"\n          CI: "true"\n        run: pnpm exec tsx src/cli/factory-platform-proof.ts record`,
  `      - name: Materialize immutable candidate\n        shell: pwsh\n        run: tar --extract --file purpose-foundry-workspaces.tar\n\n      - name: Execute Windows proof without production secrets\n        shell: pwsh\n        run: ./scripts/ci/run-windows-platform-proof.ps1 -WorkspaceRoot "\${{ github.workspace }}/workspaces"\n\n      - name: Stage Windows checkpoint evidence\n        if: always()\n        shell: pwsh\n        run: |\n          Remove-Item -Recurse -Force platform-evidence -ErrorAction SilentlyContinue\n          New-Item -ItemType Directory -Path platform-evidence | Out-Null\n          Copy-Item -Path .factory -Destination platform-evidence/.factory -Recurse -Force`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `          path: |\n            purpose-foundry-seed-server.log\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**\n\n  macos:`,
  `          path: |\n            platform-evidence/**\n\n  macos:`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `      - name: Restore Windows-verified candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-windows-\${{ github.run_id }}\n          path: .\n\n      - name: Execute macOS proof without production secrets\n        shell: pwsh\n        env:\n          WORKSPACE_ROOT: "\${{ github.workspace }}/workspaces"\n          ALLOW_UNTRUSTED_SCRIPTS: "true"\n          CI: "true"\n        run: pnpm exec tsx src/cli/factory-platform-proof.ts record`,
  `      - name: Restore immutable seed candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-seed-\${{ github.run_id }}\n          path: .\n\n      - name: Restore Windows checkpoint evidence\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-windows-\${{ github.run_id }}\n          path: platform-evidence\n\n      - name: Materialize immutable candidate\n        shell: bash\n        run: tar --extract --file purpose-foundry-workspaces.tar\n\n      - name: Apply Windows checkpoint evidence\n        shell: bash\n        run: |\n          rm -rf .factory\n          cp -R platform-evidence/.factory .factory\n\n      - name: Execute macOS proof without production secrets\n        shell: bash\n        run: bash scripts/ci/run-macos-platform-proof.sh "\${{ github.workspace }}/workspaces"\n\n      - name: Stage macOS checkpoint evidence\n        if: always()\n        shell: bash\n        run: |\n          rm -rf platform-evidence\n          mkdir -p platform-evidence\n          cp -R .factory platform-evidence/.factory`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `          path: |\n            purpose-foundry-seed-server.log\n            .factory/**\n            workspaces/**\n            !workspaces/**/node_modules/**\n\n  verify:`,
  `          path: |\n            platform-evidence/**\n\n  verify:`,
);

one(
  ".github/workflows/purpose-foundry-cloud.yml",
  `      - name: Restore cross-platform candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-macos-\${{ github.run_id }}\n          path: .`,
  `      - name: Restore immutable seed candidate\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-seed-\${{ github.run_id }}\n          path: .\n\n      - name: Restore macOS checkpoint evidence\n        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4\n        with:\n          name: purpose-foundry-macos-\${{ github.run_id }}\n          path: platform-evidence\n\n      - name: Materialize immutable candidate\n        shell: bash\n        run: tar --extract --file purpose-foundry-workspaces.tar\n\n      - name: Apply macOS checkpoint evidence\n        shell: bash\n        run: |\n          rm -rf .factory\n          cp -R platform-evidence/.factory .factory`,
);

console.log("Repaired Factory Deck and Purpose Foundry platform proof workflows.");
