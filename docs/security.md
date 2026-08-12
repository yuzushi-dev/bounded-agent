# Security

`omp-bounded` enforces one short local run inside OMP. The controller binds the exact task, acceptance check, inputs, writable outputs, budgets, qualification evidence, worker, independent verifier, routing, and deadline. Execution is sandboxed; direct OMP task/eval/hub dispatch is blocked; output is bounded and secret-looking command input is rejected.

The user-systemd guard is independent of the OMP process. A pending recovery record contains the exact protected baseline. Completion, failure, expiry, reboot, process death, or detected drift restores:

```text
level: L3-narrow-write
killSwitch.active: true
killSwitch.marker: UNATTENDED_MODE_DISABLED
```

The accepted threat model is one trusted operator on a trusted LAN and one Unix account. A process already compromised under the same UID is out of scope. Operator policy prohibits provider credentials in installation state, qualification files, receipts, command input, or artifacts. The installer rejects credential-like material in its installation manifest and receipt; it is not a general content scanner for arbitrary artifact bytes.

No contract authorizes an external effect. Publishing, pushing, deployment, spending, deletion, credential use, and third-party communication remain outside the bounded run and require a separate human decision. `--final-gate human-approval` records that boundary; it does not perform or authorize the action.

The clean-host test uses OMP 17.2.11's real [RPC transport](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md), an actual linked extension, and the real user systemd manager. It verifies local execution, confirmation, OMP-process crash recovery, exact L3 restoration, installer/runtime residue removal, and byte-exact preservation of host-owned evidence. It does not validate marketplace delivery, another OMP version, another init system, or Codex/Claude enforcement parity.
