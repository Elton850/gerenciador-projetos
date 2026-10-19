"""Gera a REFERÊNCIA do teste de paridade rodando o código ORIGINAL do "bt sql gui" (app.py) sem SQL Server.

O que é substituído: só o acesso ao banco. A orquestração (_processing_worker), o parser (BtFileImporter.import_file)
e a regra de criar/acrescentar (SqlServerManager.append_dataframe) são os do app original, sem alteração:
  - SqlServerManager → subclasse que guarda as tabelas em memória (_load_table_columns, _add_missing_columns, conexão);
  - pandas.DataFrame.to_sql → grava as linhas na tabela em memória (mesmos argumentos que o original passa).

Uso (fora da pasta do repositório, para o load_dotenv do app não ler nada daqui):
  py -I scripts/bt-parity-reference.py <caminho do app.py> <pasta das fixtures> <saida.json>
Saída: JSON com, por cenário, os bancos → tabelas → colunas e linhas, o status de cada arquivo e os avisos do log.
"""
import importlib.util
import json
import sys
import threading
from pathlib import Path

app_path, fixtures_dir, out_path = sys.argv[1:4]
spec = importlib.util.spec_from_file_location("bt_sql_gui_ref", app_path)
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)

import pandas as pd  # noqa: E402  (o app original já importou)

STATE = {}  # banco -> tabela -> {"columns": [...], "rows": [[...]]}


def _to_sql(self, name, con, schema=None, if_exists="fail", index=True, chunksize=None, dtype=None, **_):
    db = STATE.setdefault(con, {})
    if name in db and if_exists == "fail":
        raise ValueError(f"Table '{name}' already exists.")
    t = db.setdefault(name, {"columns": list(self.columns), "rows": []})
    pos = {c: i for i, c in enumerate(t["columns"])}
    for rec in self.itertuples(index=False, name=None):
        row = [None] * len(t["columns"])
        for col, val in zip(self.columns, rec):
            row[pos[col]] = None if val is None or (isinstance(val, float) and val != val) else val
        t["rows"].append(row)


pd.DataFrame.to_sql = _to_sql


class MemoryManager(ref.SqlServerManager):
    def test_connection(self):
        return ("SRV", "login", "master")

    def prepare_database(self, database, recreate=False):
        STATE.setdefault(database, {})

    def get_engine(self, database):
        return database

    def dispose_all(self):
        pass

    def _load_table_columns(self, database, table):
        t = STATE.get(database, {}).get(table)
        return None if t is None else list(t["columns"])

    def _add_missing_columns(self, database, table, missing_columns):
        t = STATE[database][table]
        for c in missing_columns:
            t["columns"].append(c)
            for r in t["rows"]:
                r.append(None)


ref.SqlServerManager = MemoryManager


class FakeQueue:
    def __init__(self):
        self.events = []

    def put(self, ev):
        self.events.append(ev)


class FakeApp:
    def __init__(self):
        self.stop_event = threading.Event()
        self.ui_queue = FakeQueue()
        self.logs = []

    def _queue_log(self, msg):
        self.logs.append(msg)


def run(name, files, mapping, only_required, batch_size):
    STATE.clear()
    fake = FakeApp()
    paths = [str(Path(fixtures_dir) / f) for f in files]
    mappings = [(p, mapping.get(Path(p).name) or ref.make_default_database_name(p)) for p in paths]
    ref.BtSqlApp._processing_worker(fake, config=None, mappings=mappings, recreate=False,
                                    only_required=only_required, batch_size=batch_size)
    status = {}
    for ev in fake.ui_queue.events:
        if ev[0] == "file_status":
            status[Path(ev[1]).name] = ev[2]
    warnings = [m.strip() for m in fake.logs if "[AVISO]" in m or "[SCHEMA]" in m or "[ERRO]" in m]
    return {"name": name, "onlyRequired": only_required, "batchSize": batch_size,
            "mappings": [[Path(p).name, d] for p, d in mappings], "status": status,
            "databases": json.loads(json.dumps(STATE)), "warnings": warnings}


FILES = ["CLIENTES_01.bt", "CLIENTES_02.bt", "ESPECIAIS.bt", "VAZIO.bt", "INVALIDO.bt"]
scenarios = [
    run("agrupado-somente-lista", FILES, {"CLIENTES_01.bt": "HIST", "CLIENTES_02.bt": "hist"}, True, 100),
    run("padrao-todas-tabelas", FILES, {}, False, 100),
    run("lote-grande", ["CLIENTES_02.bt", "CLIENTES_01.bt"], {"CLIENTES_01.bt": "UNICO", "CLIENTES_02.bt": "UNICO"}, True, 5000),
]
out = {"requiredTables": sorted(ref.REQUIRED_TABLES),
       "defaultNames": {f: ref.make_default_database_name(f) for f in FILES + ["a b-c.d.bt", "ção.bt", "___.bt"]},
       "scenarios": scenarios}
Path(out_path).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"referencia gravada em {out_path}")
