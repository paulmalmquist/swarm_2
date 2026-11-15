# Affected hardware investigation

Evidence: **synthetic** · Packet: **current** · Decision support only.
This packet does not authorize a hold, release, disposition, rework, retest or physical-completion claim.

Finding: syn-qms/finding/SYN-NCR-1042
Lot hypothesis: syn-mes/hardware/SYN-MAT-L17
Exposure: 2026-11-01T00:00:00.000Z to 2026-11-10T00:00:00.000Z (end excluded).
Packet hash: `42ade3ca98442d209d58dfd8f3f6df96530c9066cd1e8bad6288dfe43d94bb7c`
Snapshot hash: `b0fc7ccf512eceb50c4113604fab0dd8032c72220868e03ab9c31fbaa621dd98`

| Hardware | Assessment | Basis |
|---|---|---|
| SYN-ASM-020 | potentially_affected | Source-backed candidate relationship; applicability requires review |
| SYN-ASM-021 | potentially_affected | Source-backed candidate relationship; applicability requires review |
| SYN-ASM-022 | potentially_affected | Source-backed candidate relationship; applicability requires review |
| SYN-MAT-L17 | potentially_affected | Investigator-selected lot hypothesis; causal relevance is unproven |
| SYN-SN008 | potentially_affected; finding subject | Recorded subject of the finding; no disposition inferred; Source-backed candidate relationship; applicability requires review |
| SYN-SN009 | potentially_affected | Source-backed candidate relationship; applicability requires review |
| SYN-SN010 | unknown | Source-backed candidate relationship; applicability requires review |
| syn-mes/hardware/SYN-SN011 | unknown | Unresolved identity on the candidate path |

## Gaps and conflicts

- identity\_missing: Cannot uniquely resolve syn-mes/hardware/SYN-SN011
- ambiguous\_path: Cannot traverse syn-mes/relationship/SYN-LOT-LINK-011 without identity reconciliation
- genealogy\_not\_complete: SYN-SN010: source genealogy is incomplete
- coverage\_not\_established: No source export proves the complete hardware universe. Unreached hardware is unassessed, never unaffected.
- SYN-ASM-020 / process: **missing**.
- SYN-ASM-020 / material_lot: **missing**.
- SYN-ASM-020 / design_revision: **missing**.
- SYN-ASM-021 / process: **missing**.
- SYN-ASM-021 / material_lot: **missing**.
- SYN-ASM-021 / design_revision: **missing**.
- SYN-ASM-022 / process: **missing**.
- SYN-ASM-022 / material_lot: **missing**.
- SYN-ASM-022 / design_revision: **missing**.
- SYN-MAT-L17 / process: **missing**.
- SYN-MAT-L17 / material_lot: **missing**.
- SYN-MAT-L17 / design_revision: **missing**.
- SYN-SN009 / process: **disputed**.
- Unassessed hardware: SYN-MAT-L03, SYN-REF-077. No path does not mean unaffected.

## Relationship paths

- SYN-ASM-020: SYN-MAT-L17 → SYN-SN008 (produced_from; syn-mes/relationship/SYN-LOT-LINK-008; `cb4fea1860895444e295ae5df4a22aea2da38793b480544603d7d06cc4f88f37`); SYN-SN008 → SYN-ASM-020 (installed_in; syn-mes/relationship/SYN-INSTALL-008-020; `f6d4ecae1f46c483cd6e589b1e99e0c35667d294967090c4a72509bc5b775ad6`)
- SYN-ASM-021: SYN-MAT-L17 → SYN-SN008 (produced_from; syn-mes/relationship/SYN-LOT-LINK-008; `cb4fea1860895444e295ae5df4a22aea2da38793b480544603d7d06cc4f88f37`); SYN-SN008 → SYN-ASM-021 (installed_in; syn-mes/relationship/SYN-INSTALL-008-021; `d0c25395a0b2b3118739f1bd8513523c75ae30c5d0aea80e37532649c0ab36a7`)
- SYN-ASM-022: SYN-MAT-L17 → SYN-SN009 (produced_from; syn-mes/relationship/SYN-LOT-LINK-009; `d8cbfdf935991c4cfa46b9a549fe97276bcbf87a0b28db6dbcc2716748e7db8c`); SYN-SN009 → SYN-ASM-022 (installed_in; syn-mes/relationship/SYN-INSTALL-009-022; `9b91fe2295995e65f0abfe6ea9808ab97eac0f0ecc9dfb8892d4729488ceaef1`)
- SYN-SN008: SYN-MAT-L17 → SYN-SN008 (produced_from; syn-mes/relationship/SYN-LOT-LINK-008; `cb4fea1860895444e295ae5df4a22aea2da38793b480544603d7d06cc4f88f37`)
- SYN-SN009: SYN-MAT-L17 → SYN-SN009 (produced_from; syn-mes/relationship/SYN-LOT-LINK-009; `d8cbfdf935991c4cfa46b9a549fe97276bcbf87a0b28db6dbcc2716748e7db8c`)
- SYN-SN010: SYN-MAT-L17 → SYN-SN010 (produced_from; syn-mes/relationship/SYN-LOT-LINK-010; `feca4150f5811d80186e60124588c9e750ed9a07c9fa7e3c97416f7bedae6c54`)
- syn-mes/hardware/SYN-SN011: SYN-MAT-L17 → syn-mes/hardware/SYN-SN011 (produced_from; syn-mes/relationship/SYN-LOT-LINK-011; `46b15b89876b1f68d663cc00c695bd049d7a9d5f599d4e21f9e1b871b0f56c11`)

## Evidence applicability

Coverage describes only the requested configuration dimensions. Even a full match requires engineering review.

| Target | Evidence hash | Class | Result | Coverage |
|---|---|---|---|---|
| SYN-ASM-020 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | unknown |
| SYN-ASM-020 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-ASM-021 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | unknown |
| SYN-ASM-021 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-ASM-022 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | unknown |
| SYN-ASM-022 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-MAT-L17 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | unknown |
| SYN-MAT-L17 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-SN008 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | partial |
| SYN-SN008 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-SN009 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | unknown |
| SYN-SN009 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |
| SYN-SN010 | `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280` | acceptance | unknown | partial |
| SYN-SN010 | `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb` | qualification | class_mismatch | none |

## Review

No engineering/quality packet review recorded.

## Source manifest

- syn-mes/configuration/SYN-CFG-008-material\_lot @ 1: `40d2ad62c351207e91d9739881b991af660f33b8b5a81823e07080d77297faa5`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-LOT-LINK-009 @ 1: `d8cbfdf935991c4cfa46b9a549fe97276bcbf87a0b28db6dbcc2716748e7db8c`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-INSTALL-008-021 @ 1: `d0c25395a0b2b3118739f1bd8513523c75ae30c5d0aea80e37532649c0ab36a7`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-05T00:00:00.000Z to open.
- syn-mes/configuration/SYN-CFG-008-process @ 1: `ca4bad364063ce57ea3cfde8148c9d0bcf22d68756469532241e768c4230f1ac`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-test/evidence/SYN-AT-008 @ 1: `74aaf812805d288c70b7d7ff294ee0a75a21e5a16e8a7ee4e98a5036ec451280`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-MAT-L17 @ 1: `f455559f7ae3d5be6478e78ba1d227cc97ddf4eab0d5a101e22f7eb69901c4d5`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-SN008 @ 1: `2723fe12388f88abfce47827659eb5ce49d26562890271ca80cd38a3d569af0e`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/configuration/SYN-CFG-009-material\_lot @ 1: `ecfa285fa7fcacc563c6c3bbf3ae562559e5c0197b533dca9a4adccc9d50ccba`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-SN010 @ 1: `59e5823b95211e070d02f1bfd57f2fbbbad8721373b9ab306fc5a35489634d20`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-LOT-LINK-011 @ 1: `46b15b89876b1f68d663cc00c695bd049d7a9d5f599d4e21f9e1b871b0f56c11`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/configuration/SYN-CFG-009-process @ 1: `779429c8ab0ca28e25f37ae12b0473ded5da5a2a5106e57c3c401e1205188cde`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-test/evidence/SYN-QT-77 @ 1: `97a81eb508db81cacefaae7e1ddd5ff16fa825b31753078d0f830b8781c147eb`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-LOT-LINK-008 @ 1: `cb4fea1860895444e295ae5df4a22aea2da38793b480544603d7d06cc4f88f37`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-qms/configuration/SYN-CONTRARY-009 @ 1: `195beed972e8b3da832e4136ba36863041b6779e70f7c74a3314bc395aa71b68`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-INSTALL-008-020 @ 1: `f6d4ecae1f46c483cd6e589b1e99e0c35667d294967090c4a72509bc5b775ad6`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to 2026-11-05T00:00:00.000Z.
- syn-design/configuration/SYN-CFG-008-design\_revision @ 1: `a0d104f9fc781e1175acd4b6159fd2360852193af9bffe3cc85d4ae39e6589b6`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-design/configuration/SYN-CFG-010-design\_revision @ 1: `44762ab82ba2548923614f7df204e8c0526bfe028888e8bc2c275ddf16932f6a`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-INSTALL-009-022 @ 1: `9b91fe2295995e65f0abfe6ea9808ab97eac0f0ecc9dfb8892d4729488ceaef1`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-design/configuration/SYN-CFG-009-design\_revision @ 1: `04485db8a60e72a64c3471d84f30d8337d882ba6cddfabac7eba1699b2992878`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/configuration/SYN-CFG-010-material\_lot @ 1: `b148f56f4e2f3f1b919b2215fcf7ed10ef96ad09cee77d5c324aacb7c3dec881`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-REF-077 @ 1: `437d49b2f25e6a4a50e31d36e431a7862756f6f9a0a60f6e126005c2266d759f`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-ASM-022 @ 1: `3be512ae4c123a6ecc05341cf96fa2fb2819e102d76046e01fcd7f746503583d`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-ASM-020 @ 1: `b0cd748f452974cf64fef4f486d6fa158a43043663c6bf9e3f9a41270ce9bddc`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-SN009 @ 1: `40163162aabc02ff15ff050fbee01b001783334b23f8e24b50aa3754b40f134c`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-qms/finding/SYN-NCR-1042 @ 1: `af87301f7eecdffd8d6d7f85cea30a0a3db033f9125f7793306b2525aa8cc750`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/relationship/SYN-LOT-LINK-010 @ 1: `feca4150f5811d80186e60124588c9e750ed9a07c9fa7e3c97416f7bedae6c54`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-ASM-021 @ 1: `a8a78708cbebe7264776d503384f0e00b8ef3e88cd4c172dab7a83d1fd389754`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/hardware/SYN-MAT-L03 @ 1: `2720921116b90e60c4d20d843e7c2d57a1af28777f365c798a4afd9898cda402`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
- syn-mes/configuration/SYN-CFG-010-process @ 1: `c21ca7a22283eac2833a4fef946de40f97d4d950019da221a7429fd8a1b75c2c`. Known 2026-11-14T00:00:00.000Z; valid 2026-11-01T00:00:00.000Z to open.
