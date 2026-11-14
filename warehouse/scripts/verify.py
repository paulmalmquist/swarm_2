"""Local dbt execution plus offline BigQuery parsing. Never invoke cloud compilation/authentication."""
from __future__ import annotations
import importlib.metadata
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace

import duckdb
import jinja2
import sqlglot
import yaml

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "warehouse"
DBT = Path(sys.executable).with_name("dbt")
if not DBT.exists():
    raise SystemExit("Run with the Python environment containing warehouse/requirements-dev.txt")


def main() -> None:
    subprocess.run(["node", str(PROJECT / "scripts/generate-fixtures.mjs")], cwd=ROOT, check=True)
    variables = yaml.safe_load((PROJECT / "fixture-vars.yml").read_text())
    evidence = ROOT / "evidence/warehouse"
    evidence.mkdir(parents=True, exist_ok=True)
    results = []
    with tempfile.TemporaryDirectory(prefix="swarm-dbt-") as temp:
        work = Path(temp)
        shutil.copyfile(PROJECT / "profiles.yml.example", work / "profiles.yml")
        database = work / "manufacturing.duckdb"
        env = {**os.environ, "SWARM_DBT_PROJECT": "compile-only", "SWARM_DBT_LOCAL_PATH": str(database), "DBT_SEND_ANONYMOUS_USAGE_STATS": "false"}

        def run(label, command, target="local", vars_override=None, expect_failure=False):
            target_dir = work / ("local" if target == "local" else "bigquery")
            args = [str(DBT), *command, "--project-dir", str(PROJECT), "--profiles-dir", str(work), "--target", target,
                    "--target-path", str(target_dir), "--log-path", str(work / "logs"), "--no-use-colors",
                    "--vars", json.dumps(variables if vars_override is None else vars_override)]
            proc = subprocess.run(args, cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
            (evidence / f"{label}.log").write_text("\n".join(line.rstrip() for line in proc.stdout.splitlines()) + "\n")
            if expect_failure:
                report = json.loads((target_dir / "run_results.json").read_text())
                if proc.returncode != 1 or not report["results"] or any(r["status"] != "fail" or r.get("failures", 0) < 1 for r in report["results"]):
                    raise AssertionError(f"{label} did not detect invalid data: {proc.stdout[-3000:]}")
            elif proc.returncode != 0:
                raise AssertionError(f"{label} failed: {proc.stdout[-4000:]}")
            print(f"PASS {label}", flush=True)
            return target_dir

        local = run("local-build", ["build"])
        build = json.loads((local / "run_results.json").read_text())
        manifest = json.loads((local / "manifest.json").read_text())
        models = {k: v for k, v in manifest["nodes"].items() if v["resource_type"] == "model"}
        allowed = {"staging": {"staging"}, "intermediate": {"staging", "intermediate"}, "mart": {"intermediate", "mart", "staging"}, "consumer": {"mart", "consumer"}}
        for node in models.values():
            layer = Path(node["original_file_path"]).parts[1]
            for parent in node["depends_on"]["nodes"]:
                if parent in models:
                    parent_layer = Path(models[parent]["original_file_path"]).parts[1]
                    assert parent_layer in allowed[layer], f"Layer violation: {node['name']} -> {models[parent]['name']}"
        results.append("Layer dependencies: Consumer reads only Mart or Consumer")

        def query(sql, params=None):
            with duckdb.connect(str(database)) as connection:
                return connection.execute(sql, params or []).fetchall()

        def require(label, condition):
            if not condition:
                raise AssertionError(label)
            results.append(label)

        require("Conformed keys separate identical hardware IDs in two datasets", query("select count(distinct hardware_key) from swarm_dev_mart.dim_hardware where hardware_id = 'SYN-SN008'")[0][0] == 2)
        require("Finding revisions do not inflate finding count", query("select count(*) from swarm_dev_mart.fact_finding_revision")[0][0] == 2 and query("select count(*) from swarm_dev_consumer.consumer_findings")[0][0] == 1)
        require("Hardware Type 2 retains two knowledge versions", query("select count(*) from swarm_dev_mart.sc_dim_hardware where dataset_id = 'synthetic-anomaly' and hardware_id = 'SYN-SN008'")[0][0] == 2)

        # A historical Consumer rebuild must recover the previous evidence/identity basis.
        initial = json.loads((PROJECT / "fixture-manifest.json").read_text())["initial_sequence"]
        historical_vars = {**variables, "consumer_known_sequence": initial}
        run("historical-consumer", ["run", "--select", "tag:consumer"], vars_override=historical_vars)
        require("Historical cutoff retains the original configuration conflict", query("select count(*) from swarm_dev_consumer.consumer_configuration_conflicts")[0][0] == 1)
        require("Historical cutoff retains subsequently withdrawn evidence", query("select count(*) from swarm_dev_consumer.consumer_evidence where evidence_class = 'qualification'")[0][0] == 1)
        require("Historical cutoff does not learn late hardware early", query("select count(*) from swarm_dev_consumer.consumer_hardware_as_of where hardware_id = 'SYN-SN011'")[0][0] == 0)
        run("current-consumer", ["run", "--select", "tag:consumer"])

        # Negative tests must fail on data, not infrastructure or SQL syntax errors.
        raw = "swarm_dev_fixture.raw_manufacturing_versions"
        original = query(f"select * from {raw} limit 1")[0]
        altered = list(original); altered[2] = 100000; altered[4] = "b" * 64
        query(f"insert into {raw} values (?,?,?,?,?,?)", altered)
        run("reject-conflicting-revision", ["test", "--select", "no_conflicting_source_revisions"], expect_failure=True)
        query(f"delete from {raw} where ingestion_sequence = 100000")
        altered = list(original); altered[2] = 100001; altered[5] = altered[5] + " "
        query(f"insert into {raw} values (?,?,?,?,?,?)", altered)
        run("reject-payload-tampering", ["test", "--select", "valid_source_envelopes"], expect_failure=True)
        query(f"delete from {raw} where ingestion_sequence = 100001")
        columns = [r[1] for r in query("pragma table_info('swarm_dev_mart.sc_dim_hardware')")]
        row = list(query("select * from swarm_dev_mart.sc_dim_hardware where hardware_version_key <> '__unknown__' limit 1")[0])
        row[columns.index("hardware_version_key")] = "overlap-negative-test"
        query("insert into swarm_dev_mart.sc_dim_hardware values (" + ",".join("?" for _ in row) + ")", row)
        run("reject-overlapping-scd", ["test", "--select", "sc_dim_hardware_no_overlap"], expect_failure=True)
        query("delete from swarm_dev_mart.sc_dim_hardware where hardware_version_key = 'overlap-negative-test'")
        run("final-data-tests", ["test"])

        # dbt parse is documented to avoid warehouse connections. Do not use dbt compile here.
        bq = run("bigquery-parse", ["parse", "--no-partial-parse"], target="bigquery")
        bq_manifest = json.loads((bq / "manifest.json").read_text())
        defaults = yaml.safe_load((PROJECT / "dbt_project.yml").read_text())["vars"]
        values = {**defaults, **variables}
        macro_text = (PROJECT / "macros/platform.sql").read_text()
        # dbt's return() returns objects; this single static list is supplied directly to Jinja.
        macro_text = re.sub(r"{% macro dimensions\(\) %}.*?{% endmacro %}", "", macro_text, flags=re.S)
        def fail(message):
            raise ValueError(message)
        def relation(name):
            return bq_manifest["nodes"][f"model.swarm_manufacturing.{name}"]["relation_name"] if f"model.swarm_manufacturing.{name}" in bq_manifest["nodes"] else bq_manifest["nodes"][f"seed.swarm_manufacturing.{name}"]["relation_name"]
        environment = jinja2.Environment(undefined=jinja2.StrictUndefined)
        context = {"target": SimpleNamespace(type="bigquery"), "execute": True, "config": lambda *a, **k: "", "ref": relation,
                   "var": lambda name, default=None: values.get(name, default), "exceptions": SimpleNamespace(raise_compiler_error=fail),
                   "dimensions": lambda: ["design_revision", "geometry", "material", "material_lot", "process", "supplier", "site", "equipment", "environment", "test_procedure", "test_setup", "instrumentation", "firmware"]}
        rendered = 0
        for node in bq_manifest["nodes"].values():
            if node["resource_type"] != "model":
                continue
            sql = environment.from_string(macro_text + "\n" + (PROJECT / node["original_file_path"]).read_text()).render(**context)
            sqlglot.parse_one(sql, read="bigquery")
            rendered += 1
        assert rendered == len(models)
        # Parse the production source path too; no source seed or fixture test should remain enabled.
        production_vars = {**variables, "manufacturing_fixture_mode": False, "raw_project": "compile-only"}
        production = run("bigquery-source-parse", ["parse", "--no-partial-parse"], target="bigquery", vars_override=production_vars)
        production_manifest = json.loads((production / "manifest.json").read_text())
        assert len(production_manifest["sources"]) == 1
        assert not any(n["resource_type"] == "seed" for n in production_manifest["nodes"].values())

        receipt = {
            "evidence_class": "synthetic_local_warehouse",
            "versions": {p: importlib.metadata.version(p) for p in ["dbt-core", "dbt-bigquery", "dbt-duckdb", "duckdb", "sqlglot"]},
            "models_built_locally": len(models), "data_tests_passed": sum(r["unique_id"].startswith("test.") for r in build["results"]),
            "negative_data_tests_detected": 3, "additional_checks": results,
            "bigquery_dbt_parse": "passed: fixture and source modes", "bigquery_static_sql_syntax_models": rendered,
            "bigquery_dbt_compile": "not performed by this offline verifier",
            "bigquery_execution": "not performed", "production_deployment": "not performed",
            "limitations": ["DuckDB execution does not validate BigQuery execution semantics, IAM, DDL contracts or performance", "Static Jinja rendering is not dbt BigQuery compilation", "No manufacturing ground truth or operational reliability claim"],
        }
        (evidence / "validation.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
