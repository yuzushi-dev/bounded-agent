# Install

The current MVP supports a local OMP link on Linux with OMP 17.2.11, Node 22.22, user systemd, `bubblewrap`, `prlimit`, and `flock`. It is not published to a marketplace.

The host must first produce an absolute, credential-free qualified installation JSON. It binds the controller paths, worker and independent verifier commands, runtime mounts, routing, evidence, and admission defaults. Do not invent or reuse stale qualification data.

From the package root:

```bash
(umask 077; node scripts/install.mjs --config /absolute/path/to/qualified-installation.json --omp "$(command -v omp)")
omp plugin doctor
node scripts/doctor.mjs doctor
```

The hardened umask is required because OMP creates its plugin registry and `node_modules` directory. The installer rejects group- or world-writable plugin paths. It calls `omp plugin link <package-root> --scope user`, installs `omp-bounded-guard.service` and `omp-bounded-guard.timer`, verifies the timer and first reconciliation, and records only the state needed for exact removal. Restart OMP after installation.

Remove the linked MVP with:

```bash
node scripts/uninstall.mjs
```

Removal disables the product units, restores the prior plugin registry/link and any prior unit files, and removes installer-created state. A valid pending transaction is recovered before uninstall continues; malformed or mismatched pending state is rejected. Unrelated registry changes are merged key-wise; the plugin-owned entry/link and guard-owned files must still match the receipt, otherwise uninstall fails closed instead of overwriting drift. An active product timer is stopped normally; uninstall refuses an active guard service or any stop, disable, verification, unsafe-guard, or owned-state-drift failure. Host-provisioned qualification, inputs, delivery artifacts, and trusted-state files are not user-owned by the installer and are preserved; the host that provisioned them must retire them separately.

OMP documents the plugin CLI and plugin discovery in its [official repository](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/cli/plugin-cli.ts). OMP's [official plugin authoring guide](https://github.com/can1357/oh-my-pi/blob/main/docs/skills/authoring-marketplaces.md) describes `package.json` extension declarations. Marketplace delivery remains outside this MVP and has not been validated here.
