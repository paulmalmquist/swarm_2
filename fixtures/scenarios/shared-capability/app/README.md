# syn-dataset-health

SYNTHETIC FIXTURE APPLICATION. A small shared capability that reports dataset freshness and schema
drift from policy configuration. All datasets, teams and values are invented.

- `data/` synthetic dataset observations and policies
- `contracts/` the agreed HealthRecord interface (written when the contract is pinned)
- `src/engine/` evaluates observations against policy and produces HealthRecords
- `src/report/` renders an SLA report and alert payloads from HealthRecords
- `test/integration/` the boundary where the two workstreams meet
