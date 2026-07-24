# Changelog

## 0.1.35

- Publish the merged PR-drain line to npm (registry was stuck at 0.1.33). Includes all
  changes merged into `main` after the 0.1.33 release, notably:
  - feat: compact CLI and MCP output defaults (#2)
  - Branch adjudication / relocation hardening series (#15–#22): fail-closed primary repo
    relocation, divergent branch preservation, abbreviated relocation SHA resolution, fsck
    timeout fix for large repos, release-gate and Git-evidence hardening.
  - fix(pr-queue): pagination + stale-ref skip, seed pr_author/pr_state + State/Author in
    seed body, repair npm publish auth (NPM_CONFIG_TOKEN) (#8–#11, #13).
  - feat: release-pipeline parity check on the release_health surface (#14).
