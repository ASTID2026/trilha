"""Persistência SQLite do AudTrilhas Offline."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from motor_auditoria import (
    DEFAULT_INTEREST_TERMS,
    TRAIL_CATALOG,
    make_interest_term_alerts,
    parse_interest_terms,
    sanitize_interest_terms,
)


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
DATA_DIR = Path(os.environ.get("AUDTRILHAS_DATA_DIR", str(ROOT_DIR / "dados"))).resolve()
DB_DIR = DATA_DIR / "banco"
ORIGINALS_DIR = DATA_DIR / "arquivos" / "originais"
PROCESSED_DIR = DATA_DIR / "arquivos" / "processados"
EXPORTS_DIR = DATA_DIR / "exportacoes"
BACKUPS_DIR = DATA_DIR / "backups"
LOGS_DIR = DATA_DIR / "logs"
TEMP_DIR = DATA_DIR / "temporarios"
DB_PATH = DB_DIR / "audtrilhas.db"
UASG_RESOURCE = APP_DIR / "recursos" / "uasg-comaer.json"

DEFAULT_SETTINGS = {
    "materiality": "500000",
    "publicationLag": "30",
    "retentionDays": "1825",
    "interestTerms": json.dumps(DEFAULT_INTEREST_TERMS, ensure_ascii=False),
}

ALLOWED_STATUSES = {"Novo", "Em análise", "Validado", "Descartado"}
_INITIALIZED = False
_INIT_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_directories() -> None:
    for directory in (DB_DIR, ORIGINALS_DIR, PROCESSED_DIR, EXPORTS_DIR, BACKUPS_DIR, LOGS_DIR, TEMP_DIR):
        directory.mkdir(parents=True, exist_ok=True)


def resolve_data_path(value: str | Path) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (DATA_DIR / path).resolve()


def connect() -> sqlite3.Connection:
    ensure_directories()
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


@contextmanager
def database():
    connection = connect()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  processed_path TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/csv',
  file_size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT NOT NULL UNIQUE,
  row_count INTEGER NOT NULL DEFAULT 0,
  alert_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Processado',
  imported_by TEXT NOT NULL DEFAULT 'Equipe CENCIAR',
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  search_term TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  publication_date TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Outros atos',
  uasg TEXT NOT NULL DEFAULT '',
  process TEXT NOT NULL DEFAULT '',
  modality TEXT NOT NULL DEFAULT '',
  procurement_code TEXT NOT NULL DEFAULT '',
  contract TEXT NOT NULL DEFAULT '',
  cnpj TEXT NOT NULL DEFAULT '',
  cnpjs_json TEXT NOT NULL DEFAULT '[]',
  supplier TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  contracting_party TEXT NOT NULL DEFAULT '',
  contracted_party TEXT NOT NULL DEFAULT '',
  object_text TEXT NOT NULL DEFAULT '',
  value REAL,
  values_json TEXT NOT NULL DEFAULT '[]',
  signature_date TEXT NOT NULL DEFAULT '',
  validity_start TEXT NOT NULL DEFAULT '',
  validity_end TEXT NOT NULL DEFAULT '',
  opening_date TEXT NOT NULL DEFAULT '',
  legal_basis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  trail_id TEXT NOT NULL,
  trail TEXT NOT NULL,
  severity TEXT NOT NULL,
  score INTEGER NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  procedure_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'Novo',
  notes TEXT NOT NULL DEFAULT '',
  assigned_to TEXT NOT NULL DEFAULT '',
  due_date TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT 'Equipe CENCIAR',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trails (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uasg_directory (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uf TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imports_active_created ON imports(is_active, created_at);
CREATE INDEX IF NOT EXISTS idx_publications_import ON publications(import_id);
CREATE INDEX IF NOT EXISTS idx_publications_process ON publications(process);
CREATE INDEX IF NOT EXISTS idx_publications_uasg ON publications(uasg);
CREATE INDEX IF NOT EXISTS idx_alerts_import ON alerts(import_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
CREATE INDEX IF NOT EXISTS idx_alerts_trail ON alerts(trail_id);
CREATE INDEX IF NOT EXISTS idx_alert_events_alert_created ON alert_events(alert_id, created_at);
"""


def initialize_database() -> Path:
    global _INITIALIZED
    ensure_directories()
    if _INITIALIZED and DB_PATH.exists():
        return DB_PATH
    with _INIT_LOCK:
        if _INITIALIZED and DB_PATH.exists():
            return DB_PATH
        with database() as connection:
            connection.executescript(SCHEMA)
            stamp = now_iso()
            connection.execute("INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', '1')")
            for trail in TRAIL_CATALOG:
                connection.execute(
                    """INSERT INTO trails(id, name, category, description, active, updated_at)
                       VALUES(?, ?, ?, ?, 1, ?)
                       ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, description=excluded.description""",
                    (trail["id"], trail["name"], trail["category"], trail["description"], stamp),
                )
            for key, value in DEFAULT_SETTINGS.items():
                connection.execute("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?, ?, ?)", (key, value, stamp))
            if UASG_RESOURCE.exists():
                data = json.loads(UASG_RESOURCE.read_text(encoding="utf-8"))
                for unit in data.get("units", []):
                    connection.execute(
                        """INSERT INTO uasg_directory(code, name, uf, source_file, source_checksum, imported_at)
                           VALUES(?, ?, ?, ?, ?, ?)
                           ON CONFLICT(code) DO UPDATE SET name=excluded.name, uf=excluded.uf,
                             source_file=excluded.source_file, source_checksum=excluded.source_checksum""",
                        (str(unit.get("code", "")), str(unit.get("name", "")), str(unit.get("uf", "")), data.get("sourceFile", "UASG-COMAER"), data.get("checksum", ""), stamp),
                    )
            connection.execute("PRAGMA optimize")
        _INITIALIZED = True
    return DB_PATH


def json_list(value: str) -> list[Any]:
    try:
        result = json.loads(value)
        return result if isinstance(result, list) else []
    except (TypeError, ValueError):
        return []


def batch_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "fileName": row["file_name"], "fileSize": row["file_size"],
        "checksum": row["checksum"], "rowCount": row["row_count"], "alertCount": row["alert_count"],
        "status": row["status"], "importedBy": row["imported_by"], "isActive": bool(row["is_active"]),
        "createdAt": row["created_at"],
    }


def publication_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "importId": row["import_id"], "searchTerm": row["search_term"],
        "unit": row["unit"], "section": row["section"], "url": row["url"], "title": row["title"],
        "summary": row["summary"], "date": row["publication_date"], "category": row["category"],
        "uasg": row["uasg"], "uasgName": row["uasg_name"] if "uasg_name" in row.keys() else "",
        "uasgUf": row["uasg_uf"] if "uasg_uf" in row.keys() else "", "process": row["process"],
        "modality": row["modality"], "procurementCode": row["procurement_code"], "contract": row["contract"],
        "cnpj": row["cnpj"], "cnpjs": json_list(row["cnpjs_json"]), "supplier": row["supplier"],
        "organization": row["organization"], "contractingParty": row["contracting_party"],
        "contractedParty": row["contracted_party"], "object": row["object_text"], "value": row["value"],
        "values": json_list(row["values_json"]), "signatureDate": row["signature_date"],
        "validityStart": row["validity_start"], "validityEnd": row["validity_end"],
        "openingDate": row["opening_date"], "legalBasis": row["legal_basis"],
    }


def alert_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "importId": row["import_id"], "publicationId": row["publication_id"],
        "trailId": row["trail_id"], "trail": row["trail"], "severity": row["severity"],
        "score": row["score"], "title": row["title"], "reason": row["reason"],
        "evidence": json_list(row["evidence_json"]), "procedure": json_list(row["procedure_json"]),
        "status": row["status"], "notes": row["notes"], "assignedTo": row["assigned_to"],
        "dueDate": row["due_date"], "reviewedAt": row["reviewed_at"], "updatedAt": row["updated_at"],
    }


def event_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "alertId": row["alert_id"], "action": row["action"],
        "fromStatus": row["from_status"], "toStatus": row["to_status"], "note": row["note"],
        "actor": row["actor"], "createdAt": row["created_at"],
    }


def get_settings(connection: sqlite3.Connection) -> dict[str, str]:
    stored = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM settings")}
    return {key: stored.get(key, value) for key, value in DEFAULT_SETTINGS.items()}


def get_application_state() -> dict[str, Any]:
    initialize_database()
    with database() as connection:
        batches = list(connection.execute("SELECT * FROM imports ORDER BY created_at DESC"))
        active = [row for row in batches if row["is_active"]]
        if not active and batches:
            connection.execute("UPDATE imports SET is_active=1 WHERE id=?", (batches[0]["id"],))
            batches = list(connection.execute("SELECT * FROM imports ORDER BY created_at DESC"))
            active = [batches[0]]
        trails = [{"id": row["id"], "name": row["name"], "category": row["category"], "description": row["description"], "active": bool(row["active"]), "updatedAt": row["updated_at"]} for row in connection.execute("SELECT * FROM trails ORDER BY id")]
        settings = get_settings(connection)
        if not active:
            return {"batches": [batch_dict(row) for row in batches], "activeBatches": [], "activeBatch": None, "publications": [], "alerts": [], "trails": trails, "settings": settings, "events": []}

        active_ids = [row["id"] for row in active]
        placeholders = ",".join("?" for _ in active_ids)
        publications = list(connection.execute(
            f"""SELECT p.*, COALESCE(u.name, '') AS uasg_name, COALESCE(u.uf, '') AS uasg_uf
                FROM publications p LEFT JOIN uasg_directory u ON u.code=p.uasg
                WHERE p.import_id IN ({placeholders}) ORDER BY p.created_at, p.id""",
            active_ids,
        ))
        alerts = list(connection.execute(f"SELECT * FROM alerts WHERE import_id IN ({placeholders}) ORDER BY score DESC, created_at", active_ids))
        alert_ids = [row["id"] for row in alerts]
        events: list[sqlite3.Row] = []
        if alert_ids:
            event_placeholders = ",".join("?" for _ in alert_ids)
            events = list(connection.execute(f"SELECT * FROM alert_events WHERE alert_id IN ({event_placeholders}) ORDER BY created_at DESC LIMIT 300", alert_ids))

        active_batches = [batch_dict(row) for row in active]
        if len(active_batches) == 1:
            active_batch = active_batches[0]
        else:
            active_batch = {
                **active_batches[0], "id": "consolidated-selection", "fileName": "Lote consolidado",
                "fileSize": sum(item["fileSize"] for item in active_batches), "checksum": "",
                "rowCount": sum(item["rowCount"] for item in active_batches),
                "alertCount": sum(item["alertCount"] for item in active_batches),
                "status": "Incompleto" if any(item["status"] == "Incompleto" for item in active_batches) else "Processado",
                "importedBy": "Seleção de arquivos", "isActive": True,
            }
        return {
            "batches": [batch_dict(row) for row in batches], "activeBatches": active_batches,
            "activeBatch": active_batch, "publications": [publication_dict(row) for row in publications],
            "alerts": [alert_dict(row) for row in alerts], "trails": trails, "settings": settings,
            "events": [event_dict(row) for row in events],
        }


def get_import_by_checksum(checksum: str) -> sqlite3.Row | None:
    initialize_database()
    with database() as connection:
        return connection.execute("SELECT * FROM imports WHERE checksum=?", (checksum,)).fetchone()


def import_is_complete(import_id: str) -> bool:
    with database() as connection:
        row = connection.execute("SELECT row_count, alert_count FROM imports WHERE id=?", (import_id,)).fetchone()
        if not row:
            return False
        publications = connection.execute("SELECT COUNT(*) FROM publications WHERE import_id=?", (import_id,)).fetchone()[0]
        alerts = connection.execute("SELECT COUNT(*) FROM alerts WHERE import_id=?", (import_id,)).fetchone()[0]
        return publications == row["row_count"] and alerts == row["alert_count"]


def activate_imports(import_ids: Iterable[str]) -> None:
    ids = list(dict.fromkeys(import_ids))
    if not ids:
        raise ValueError("Selecione ao menos um arquivo para análise.")
    with database() as connection:
        existing = {row[0] for row in connection.execute("SELECT id FROM imports")}
        if any(item not in existing for item in ids):
            raise LookupError("Um ou mais arquivos selecionados não estão disponíveis.")
        connection.execute("UPDATE imports SET is_active=0")
        connection.executemany("UPDATE imports SET is_active=1 WHERE id=?", [(item,) for item in ids])


PUBLICATION_COLUMNS = (
    "id", "import_id", "search_term", "unit", "section", "url", "title", "summary", "publication_date",
    "category", "uasg", "process", "modality", "procurement_code", "contract", "cnpj", "cnpjs_json",
    "supplier", "organization", "contracting_party", "contracted_party", "object_text", "value", "values_json",
    "signature_date", "validity_start", "validity_end", "opening_date", "legal_basis", "created_at",
)


def publication_values(publication: dict[str, Any], stamp: str) -> tuple[Any, ...]:
    return (
        publication["id"], publication["importId"], publication["searchTerm"], publication["unit"], publication["section"],
        publication["url"], publication["title"], publication["summary"], publication["date"], publication["category"],
        publication["uasg"], publication["process"], publication["modality"], publication["procurementCode"], publication["contract"],
        publication["cnpj"], json.dumps(publication["cnpjs"], ensure_ascii=False), publication["supplier"], publication["organization"],
        publication["contractingParty"], publication["contractedParty"], publication["object"], publication["value"],
        json.dumps(publication["values"], ensure_ascii=False), publication["signatureDate"], publication["validityStart"],
        publication["validityEnd"], publication["openingDate"], publication["legalBasis"], stamp,
    )


def alert_values(alert: dict[str, Any], import_id: str, stamp: str) -> tuple[Any, ...]:
    return (
        alert["id"], import_id, alert["publicationId"], alert["trailId"], alert["trail"], alert["severity"], alert["score"],
        alert["title"], alert["reason"], json.dumps(alert["evidence"], ensure_ascii=False),
        json.dumps(alert["procedure"], ensure_ascii=False), alert.get("status", "Novo"), "", "", "", "", stamp, stamp,
    )


def save_import(import_id: str, file_name: str, original_path: Path, processed_path: Path, content_type: str, file_size: int, checksum: str, imported_by: str, publications: list[dict[str, Any]], alerts: list[dict[str, Any]]) -> None:
    stamp = now_iso()
    original_reference = original_path.resolve().relative_to(DATA_DIR).as_posix()
    processed_reference = processed_path.resolve().relative_to(DATA_DIR).as_posix()
    with database() as connection:
        connection.execute("UPDATE imports SET is_active=0")
        connection.execute(
            """INSERT INTO imports(id, file_name, original_path, processed_path, content_type, file_size, checksum,
               row_count, alert_count, status, imported_by, is_active, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'Processado', ?, 1, ?)""",
            (import_id, file_name, original_reference, processed_reference, content_type, file_size, checksum, len(publications), len(alerts), imported_by, stamp),
        )
        placeholders = ",".join("?" for _ in PUBLICATION_COLUMNS)
        connection.executemany(
            f"INSERT INTO publications({','.join(PUBLICATION_COLUMNS)}) VALUES({placeholders})",
            [publication_values(publication, stamp) for publication in publications],
        )
        connection.executemany(
            """INSERT INTO alerts(id, import_id, publication_id, trail_id, trail, severity, score, title, reason,
               evidence_json, procedure_json, status, notes, assigned_to, due_date, reviewed_at, created_at, updated_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [alert_values(alert, import_id, stamp) for alert in alerts],
        )


def import_file_info(import_id: str) -> sqlite3.Row | None:
    with database() as connection:
        return connection.execute("SELECT id, file_name, original_path, processed_path, content_type FROM imports WHERE id=?", (import_id,)).fetchone()


def delete_import(import_id: str) -> tuple[Path | None, Path | None]:
    with database() as connection:
        row = connection.execute("SELECT original_path, processed_path, is_active FROM imports WHERE id=?", (import_id,)).fetchone()
        if not row:
            raise LookupError("Arquivo não encontrado.")
        connection.execute("DELETE FROM imports WHERE id=?", (import_id,))
        remaining_active = connection.execute("SELECT COUNT(*) FROM imports WHERE is_active=1").fetchone()[0]
        if not remaining_active:
            latest = connection.execute("SELECT id FROM imports ORDER BY created_at DESC LIMIT 1").fetchone()
            if latest:
                connection.execute("UPDATE imports SET is_active=1 WHERE id=?", (latest["id"],))
        return resolve_data_path(row["original_path"]) if row["original_path"] else None, resolve_data_path(row["processed_path"]) if row["processed_path"] else None


def update_alert(alert_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with database() as connection:
        current = connection.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        if not current:
            raise LookupError("Alerta não encontrado.")
        status = str(payload.get("status", current["status"]))
        if status not in ALLOWED_STATUSES:
            raise ValueError("Status inválido.")
        notes = str(payload.get("notes", current["notes"]))[:8000]
        assigned_to = str(payload.get("assignedTo", current["assigned_to"]))[:120]
        due_date = str(payload.get("dueDate", current["due_date"]))[:10]
        stamp = now_iso()
        reviewed_at = stamp if status in {"Validado", "Descartado"} else current["reviewed_at"]
        connection.execute(
            "UPDATE alerts SET status=?, notes=?, assigned_to=?, due_date=?, reviewed_at=?, updated_at=? WHERE id=?",
            (status, notes, assigned_to, due_date, reviewed_at, stamp, alert_id),
        )
        connection.execute(
            """INSERT INTO alert_events(id, alert_id, action, from_status, to_status, note, actor, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
            (str(uuid.uuid4()), alert_id, "Anotação atualizada" if current["status"] == status else "Status alterado", current["status"], status, notes, str(payload.get("actor", "Equipe CENCIAR"))[:120], stamp),
        )
        saved = connection.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        return alert_dict(saved)


def toggle_trail(trail_id: str, active: bool) -> dict[str, Any]:
    stamp = now_iso()
    with database() as connection:
        connection.execute("UPDATE trails SET active=?, updated_at=? WHERE id=?", (1 if active else 0, stamp, trail_id))
        row = connection.execute("SELECT * FROM trails WHERE id=?", (trail_id,)).fetchone()
        if not row:
            raise LookupError("Trilha não encontrada.")
        return {"id": row["id"], "name": row["name"], "category": row["category"], "description": row["description"], "active": bool(row["active"]), "updatedAt": row["updated_at"]}


def publications_for_import(connection: sqlite3.Connection, import_id: str) -> list[dict[str, Any]]:
    rows = connection.execute("SELECT p.*, '' AS uasg_name, '' AS uasg_uf FROM publications p WHERE import_id=? ORDER BY id", (import_id,))
    return [publication_dict(row) for row in rows]


def recalculate_t09(connection: sqlite3.Connection, terms: list[str]) -> None:
    stamp = now_iso()
    import_ids = [row[0] for row in connection.execute("SELECT id FROM imports")]
    for import_id in import_ids:
        desired = {alert["id"]: alert for alert in make_interest_term_alerts(publications_for_import(connection, import_id), terms)}
        existing = {row["id"]: row for row in connection.execute("SELECT * FROM alerts WHERE import_id=? AND trail_id='T09'", (import_id,))}
        for alert_id in set(existing) - set(desired):
            connection.execute("DELETE FROM alerts WHERE id=?", (alert_id,))
        for alert_id, alert in desired.items():
            if alert_id in existing:
                connection.execute(
                    """UPDATE alerts SET trail=?, severity=?, score=?, title=?, reason=?, evidence_json=?, procedure_json=?, updated_at=? WHERE id=?""",
                    (alert["trail"], alert["severity"], alert["score"], alert["title"], alert["reason"], json.dumps(alert["evidence"], ensure_ascii=False), json.dumps(alert["procedure"], ensure_ascii=False), stamp, alert_id),
                )
            else:
                connection.execute(
                    """INSERT INTO alerts(id, import_id, publication_id, trail_id, trail, severity, score, title, reason,
                       evidence_json, procedure_json, status, notes, assigned_to, due_date, reviewed_at, created_at, updated_at)
                       VALUES(?, ?, ?, 'T09', ?, ?, ?, ?, ?, ?, ?, 'Novo', '', '', '', '', ?, ?)""",
                    (alert_id, import_id, alert["publicationId"], alert["trail"], alert["severity"], alert["score"], alert["title"], alert["reason"], json.dumps(alert["evidence"], ensure_ascii=False), json.dumps(alert["procedure"], ensure_ascii=False), stamp, stamp),
                )
        count = connection.execute("SELECT COUNT(*) FROM alerts WHERE import_id=?", (import_id,)).fetchone()[0]
        connection.execute("UPDATE imports SET alert_count=? WHERE id=?", (count, import_id))


def update_settings(payload: dict[str, Any]) -> dict[str, str]:
    entries: dict[str, str] = {}
    for key in ("materiality", "publicationLag", "retentionDays"):
        if key in payload:
            try:
                number = float(payload[key])
            except (TypeError, ValueError):
                continue
            if number >= 0:
                entries[key] = str(payload[key])
    if "interestTerms" in payload:
        entries["interestTerms"] = json.dumps(sanitize_interest_terms(payload["interestTerms"]), ensure_ascii=False)
    if not entries:
        raise ValueError("Nenhum parâmetro válido informado.")
    stamp = now_iso()
    with database() as connection:
        for key, value in entries.items():
            connection.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                (key, value, stamp),
            )
        if "interestTerms" in entries:
            recalculate_t09(connection, parse_interest_terms(entries["interestTerms"]))
    return entries
